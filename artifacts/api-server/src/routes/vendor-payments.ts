import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  actualCostAllocationsTable, auditLogsTable, commitmentEventsTable, commitmentLinesTable,
  commitmentTable, db, vendorInvoicesTable, vendorMatchPoliciesTable, vendorPaymentsTable,
} from "@workspace/db";
import {
  CreateVendorInvoiceBody, CreateVendorInvoiceResponse, ListVendorInvoicesResponse,
  DecideVendorInvoiceBody, DecideVendorInvoiceResponse, RequestVendorPaymentBody,
  RequestVendorPaymentResponse, DecideVendorPaymentBody, DecideVendorPaymentResponse,
  ListVendorPaymentsResponse, ListVendorReceiptsResponse,
  ListVendorMatchPoliciesResponse, CreateVendorMatchPolicyBody, CreateVendorMatchPolicyResponse,
} from "@workspace/api-zod";
import { canAccessProject, requirePermission } from "../middlewares/access";

const router: IRouter = Router();
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
const safeMoney = (...values: number[]) => values.every((n) => Number.isSafeInteger(n) && n >= 0);
function errorResponse(error: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) {
  let cause = error;
  const seen = new Set<unknown>();
  while (typeof cause === "object" && cause !== null && !seen.has(cause)) {
    seen.add(cause);
    if ("code" in cause && cause.code === "23505") {
      res.status(409).json({ error: "Nomor invoice vendor sudah dipakai" });
      return;
    }
    cause = "cause" in cause ? cause.cause : null;
  }
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
  if (status === 500) throw error;
  res.status(status).json({ error: error instanceof Error ? error.message : "Operasi ditolak" });
}
function audit(tx: Tx, req: Request, entityId: string, action: string, evidence: string, metadata: Record<string, unknown>) {
  return tx.insert(auditLogsTable).values({
    id: randomUUID(), action, entity: "VendorPayment", entityId, detail: evidence,
    user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role,
    tone: "info", metadata,
  });
}
async function lock(tx: Tx, id: string) {
  // Share the commitment lock with the existing RECEIVE/INVOICE transitions.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
}
async function match(tx: Tx, invoice: typeof vendorInvoicesTable.$inferSelect) {
  const [commitment] = await tx.select().from(commitmentTable).where(eq(commitmentTable.id, invoice.commitmentId));
  const [line] = await tx.select().from(commitmentLinesTable).where(eq(commitmentLinesTable.id, invoice.lineId));
  if (!commitment || !line || commitment.projectId !== invoice.projectId || line.commitmentId !== commitment.id || line.costCodeId !== invoice.costCodeId) fail(409, "PO/SPK, proyek, atau cost code tidak cocok");
  const issues: string[] = [];
  if (!["APPROVED", "CLOSED"].includes(commitment.status)) issues.push("PO/SPK belum disetujui atau telah dibatalkan");
  if (commitment.vendorName.trim().toLocaleLowerCase() !== invoice.vendorKey) issues.push("Vendor tidak cocok");
  const receipts = invoice.receiptEventIds.length
    ? await tx.select().from(commitmentEventsTable).where(and(eq(commitmentEventsTable.commitmentId, commitment.id), eq(commitmentEventsTable.eventType, "RECEIVE"), inArray(commitmentEventsTable.id, invoice.receiptEventIds)))
    : [];
  const commitmentLines = await tx.select({ id: commitmentLinesTable.id }).from(commitmentLinesTable).where(eq(commitmentLinesTable.commitmentId, commitment.id));
  if (receipts.length !== invoice.receiptEventIds.length || receipts.some((event) => {
    try {
      const eventLineId = JSON.parse(event.metadata).lineId;
      return eventLineId ? eventLineId !== line.id : commitmentLines.length !== 1;
    } catch { return commitmentLines.length !== 1; }
  })) issues.push("Bukti penerimaan tidak sah untuk baris PO/SPK");
  if (receipts.some((event) => {
    try { return !String(JSON.parse(event.metadata).note ?? "").trim(); } catch { return true; }
  })) issues.push("Referensi dokumen penerimaan barang/jasa tidak tersedia");
  const received = receipts.reduce((sum, event) => sum + event.amount, 0);
  const [policy] = await tx.select().from(vendorMatchPoliciesTable)
    .where(eq(vendorMatchPoliciesTable.version, invoice.policyVersion));
  if (!policy) fail(409, "Versi toleransi tidak tersedia");
  const base = invoice.quantity * invoice.unitPrice;
  const expectedBase = Math.round(line.amount * invoice.quantity / line.quantity);
  const expectedTax = Math.round(base * line.taxBasisPoints / 10000);
  const expectedRetention = Math.round(base * line.retentionBasisPoints / 10000);
  if (!Number.isSafeInteger(base) || invoice.total !== base + invoice.tax - invoice.retention) issues.push("Total invoice tidak sesuai rinciannya");
  if (invoice.quantity > line.quantity * (1 + policy.quantityToleranceBasisPoints / 10000)) issues.push("Kuantitas melebihi PO/SPK");
  if (Math.abs(base - expectedBase) > Math.round(expectedBase * policy.priceToleranceBasisPoints / 10000)) issues.push("Harga satuan tidak sesuai PO/SPK");
  if (Math.abs(invoice.tax - expectedTax) > policy.taxTolerance) issues.push("Pajak tidak sesuai PO/SPK");
  if (Math.abs(invoice.retention - expectedRetention) > policy.retentionTolerance) issues.push("Retensi tidak sesuai PO/SPK");
  if (Math.abs(invoice.total - (expectedBase + expectedTax - expectedRetention)) > policy.totalTolerance) issues.push("Total tidak sesuai PO/SPK");
  if (line.invoicedAmount + base > line.amount || line.invoicedAmount + base > received || line.invoicedAmount + base > line.receivedAmount) issues.push("Nilai invoice kumulatif melebihi PO/SPK atau penerimaan");
  const eligibleCeiling = Math.round(Math.min(line.amount - line.invoicedAmount, received - line.invoicedAmount) * (1 + line.taxBasisPoints / 10000));
  if (invoice.total > eligibleCeiling) issues.push("Total pembayaran melebihi batas PO/SPK dan penerimaan termasuk pajak");
  if (!invoice.evidence.trim()) issues.push("Bukti invoice wajib tersedia");
  return { issues, base, line, commitment };
}
async function creditIssues(tx: Tx, row: typeof vendorInvoicesTable.$inferSelect) {
  const [original] = await tx.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, row.originalInvoiceId ?? ""));
  const issues: string[] = [];
  if (!original || original.status !== "REVIEWED" || original.kind !== "INVOICE" || original.commitmentId !== row.commitmentId || original.lineId !== row.lineId || original.vendorKey !== row.vendorKey) {
    return ["Nota kredit tidak sesuai invoice asal"];
  }
  const credits = await tx.select().from(vendorInvoicesTable).where(and(eq(vendorInvoicesTable.originalInvoiceId, original.id), eq(vendorInvoicesTable.status, "REVIEWED")));
  const payments = await tx.select().from(vendorPaymentsTable).where(and(eq(vendorPaymentsTable.invoiceId, original.id), inArray(vendorPaymentsTable.status, ["REQUESTED", "APPROVED", "RELEASED"])));
  if (row.unitPrice !== original.unitPrice || row.quantity + credits.reduce((sum, credit) => sum + credit.quantity, 0) > original.quantity) issues.push("Kuantitas atau harga nota kredit tidak sesuai invoice asal");
  if (row.tax + credits.reduce((sum, credit) => sum + credit.tax, 0) > original.tax || row.retention + credits.reduce((sum, credit) => sum + credit.retention, 0) > original.retention) issues.push("Pajak atau retensi nota kredit melebihi invoice asal");
  if (row.total + credits.reduce((sum, credit) => sum + credit.total, 0) + payments.reduce((sum, payment) => sum + payment.amount, 0) > original.eligibleAmount) issues.push("Nota kredit melebihi nilai yang belum dibayar");
  if (row.receiptEventIds.some((id) => !original.receiptEventIds.includes(id))) issues.push("Bukti penerimaan nota kredit tidak terkait invoice asal");
  return issues;
}

router.get("/projects/:projectId/vendor-invoices", requirePermission("commitments:view"), async (req, res) => {
  const projectId = String(req.params.projectId);
  if (!canAccessProject(req, projectId)) { res.sendStatus(403); return; }
  res.json(ListVendorInvoicesResponse.parse(await db.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.projectId, projectId)).orderBy(desc(vendorInvoicesTable.createdAt))));
});
router.get("/projects/:projectId/vendor-receipts", requirePermission("commitments:view"), async (req, res) => {
  const projectId = String(req.params.projectId);
  if (!canAccessProject(req, projectId)) { res.sendStatus(403); return; }
  const commitments = await db.select({ id: commitmentTable.id }).from(commitmentTable).where(eq(commitmentTable.projectId, projectId));
  const events = commitments.length ? await db.select().from(commitmentEventsTable).where(and(inArray(commitmentEventsTable.commitmentId, commitments.map((row) => row.id)), eq(commitmentEventsTable.eventType, "RECEIVE"))) : [];
  const lines = commitments.length ? await db.select({ id: commitmentLinesTable.id, commitmentId: commitmentLinesTable.commitmentId }).from(commitmentLinesTable).where(inArray(commitmentLinesTable.commitmentId, commitments.map((row) => row.id))) : [];
  res.json(ListVendorReceiptsResponse.parse(events.flatMap((event) => {
    try {
      const candidates = lines.filter((line) => line.commitmentId === event.commitmentId);
      const lineId = JSON.parse(event.metadata).lineId ?? (candidates.length === 1 ? candidates[0].id : null);
      return typeof lineId === "string" ? [{ id: event.id, commitmentId: event.commitmentId, lineId, amount: event.amount, createdAt: event.createdAt }] : [];
    } catch { return []; }
  })));
});
router.get("/vendor-match-policies", requirePermission("commitments:view"), async (_req, res) => {
  res.json(ListVendorMatchPoliciesResponse.parse(await db.select().from(vendorMatchPoliciesTable).orderBy(desc(vendorMatchPoliciesTable.version))));
});
router.post("/vendor-match-policies", requirePermission("tax-rules:manage"), async (req, res) => {
  if (req.access!.role !== "DIRECTOR") { res.sendStatus(403); return; }
  const body = CreateVendorMatchPolicyBody.safeParse(req.body);
  if (!body.success || !safeMoney(body.data?.taxTolerance ?? NaN, body.data?.retentionTolerance ?? NaN, body.data?.totalTolerance ?? NaN)) {
    res.status(400).json({ error: "Aturan toleransi tidak valid" }); return;
  }
  const effectiveFrom = new Date(body.data.effectiveFrom);
  if (Number.isNaN(effectiveFrom.valueOf())) { res.status(400).json({ error: "Tanggal berlaku tidak valid" }); return; }
  const row = await db.transaction(async (tx) => {
    await lock(tx, "vendor-match-policy");
    const [last] = await tx.select().from(vendorMatchPoliciesTable).orderBy(desc(vendorMatchPoliciesTable.version)).limit(1);
    if (last && effectiveFrom <= last.effectiveFrom) fail(409, "Tanggal berlaku harus setelah versi sebelumnya");
    const [created] = await tx.insert(vendorMatchPoliciesTable).values({
      id: randomUUID(), version: (last?.version ?? 0) + 1, effectiveFrom,
      quantityToleranceBasisPoints: body.data.quantityToleranceBasisPoints,
      priceToleranceBasisPoints: body.data.priceToleranceBasisPoints,
      taxTolerance: body.data.taxTolerance, retentionTolerance: body.data.retentionTolerance, totalTolerance: body.data.totalTolerance,
    }).returning();
    await audit(tx, req, created.id, "VENDOR_MATCH_POLICY", "Aturan matching berversi dibuat", { ...body.data, version: created.version });
    return created;
  }).catch((error: unknown) => { errorResponse(error, res); return undefined; });
  if (row) res.status(201).json(CreateVendorMatchPolicyResponse.parse(row));
});
router.post("/projects/:projectId/vendor-invoices", requirePermission("commitments:write"), async (req, res) => {
  const body = CreateVendorInvoiceBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const projectId = String(req.params.projectId);
  if (!canAccessProject(req, projectId)) { res.sendStatus(403); return; }
  const data = body.data;
  if (!safeMoney(data.quantity, data.unitPrice, data.tax, data.retention, data.total) || !Number.isSafeInteger(data.quantity * data.unitPrice) || data.total !== data.quantity * data.unitPrice + data.tax - data.retention) { res.status(400).json({ error: "Nilai invoice tidak valid" }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      await lock(tx, data.commitmentId);
      const [commitment] = await tx.select().from(commitmentTable).where(and(eq(commitmentTable.id, data.commitmentId), eq(commitmentTable.projectId, projectId)));
      const [line] = await tx.select().from(commitmentLinesTable).where(and(eq(commitmentLinesTable.id, data.lineId), eq(commitmentLinesTable.commitmentId, data.commitmentId)));
      if (!commitment || !line) fail(400, "PO/SPK atau baris tidak ditemukan pada proyek ini");
      const [policy] = await tx.select().from(vendorMatchPoliciesTable).where(sql`${vendorMatchPoliciesTable.effectiveFrom} <= now()`).orderBy(desc(vendorMatchPoliciesTable.effectiveFrom), desc(vendorMatchPoliciesTable.version)).limit(1);
      if (!policy) fail(503, "Aturan matching belum tersedia");
      const id = randomUUID();
      const [row] = await tx.insert(vendorInvoicesTable).values({
        id, projectId, commitmentId: commitment.id, lineId: line.id, costCodeId: line.costCodeId,
        vendorKey: commitment.vendorName.trim().toLocaleLowerCase(), invoiceNumber: data.invoiceNumber.trim().toLocaleLowerCase(),
        kind: data.kind ?? "INVOICE", originalInvoiceId: data.originalInvoiceId ?? null,
        quantity: data.quantity, unitPrice: data.unitPrice, tax: data.tax, retention: data.retention, total: data.total,
        receiptEventIds: data.receiptEventIds, evidence: data.evidence.trim(), policyVersion: policy.version,
        policySnapshot: { quantityToleranceBasisPoints: policy.quantityToleranceBasisPoints, priceToleranceBasisPoints: policy.priceToleranceBasisPoints, taxTolerance: policy.taxTolerance, retentionTolerance: policy.retentionTolerance, totalTolerance: policy.totalTolerance },
        makerId: req.access!.userId,
      }).returning();
      let issues: string[];
      if (row.kind === "CREDIT_NOTE") {
        issues = await creditIssues(tx, row);
      } else issues = (await match(tx, row)).issues;
      const [updated] = await tx.update(vendorInvoicesTable).set({ status: issues.length ? "EXCEPTION" : "MATCHED", exceptions: issues }).where(eq(vendorInvoicesTable.id, id)).returning();
      await audit(tx, req, id, "VENDOR_MATCH", data.evidence, { issues, policyVersion: policy.version, receiptEventIds: data.receiptEventIds, values: { quantity: row.quantity, unitPrice: row.unitPrice, tax: row.tax, retention: row.retention, total: row.total } });
      return updated;
    });
    res.status(201).json(CreateVendorInvoiceResponse.parse(result));
  } catch (error) { errorResponse(error, res); }
});

router.post("/vendor-invoices/:invoiceId/decision", requirePermission("commitments:approve"), async (req, res) => {
  const body = DecideVendorInvoiceBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const [lookup] = await tx.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, String(req.params.invoiceId)));
      if (!lookup) fail(404, "Invoice vendor tidak ditemukan");
      if (!canAccessProject(req, lookup.projectId)) fail(403, "Proyek di luar penugasan");
      await lock(tx, lookup.commitmentId);
      const [row] = await tx.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, lookup.id));
      if (row.makerId === req.access!.userId) fail(403, "Pembuat invoice tidak dapat mereview sendiri");
      const action = body.data.action;
      if (!["EXCEPTION", "MATCHED"].includes(row.status) && !(action === "CANCEL" && row.status === "REVIEWED")) fail(409, "Keputusan invoice sudah final");
      if (action === "OVERRIDE" && req.access!.role !== "DIRECTOR") fail(403, "Override hanya oleh Director");
      if (action === "REVIEW" && row.status !== "MATCHED") fail(409, "Exception wajib dioverride oleh Director");
      if (action === "CANCEL") {
        const payments = await tx.select().from(vendorPaymentsTable).where(and(eq(vendorPaymentsTable.invoiceId, row.id), inArray(vendorPaymentsTable.status, ["REQUESTED", "APPROVED", "RELEASED"])));
        if (payments.length) fail(409, "Invoice dengan permintaan pembayaran tidak dapat dibatalkan");
      }
      let eligible = 0;
      if (action === "REVIEW" || action === "OVERRIDE") {
        if (row.kind === "INVOICE") {
          const { issues, base, line, commitment } = await match(tx, row);
      if (action === "REVIEW" && issues.length) fail(409, `Matching berubah: ${issues.join(", ")}`);
          if (issues.some((issue) => issue.includes("penerimaan") || issue.includes("PO/SPK belum") || issue.includes("Bukti penerimaan") || issue.includes("kumulatif") || issue.includes("sudah diinvoicing"))) fail(409, "Override tidak dapat melewati batas PO/SPK atau penerimaan");
          eligible = row.total;
          await tx.update(commitmentLinesTable).set({ invoicedAmount: line.invoicedAmount + base }).where(eq(commitmentLinesTable.id, line.id));
          await tx.insert(actualCostAllocationsTable).values({ id: randomUUID(), projectId: row.projectId, baselineId: commitment.baselineId, costCodeId: row.costCodeId, commitmentId: row.commitmentId, sourceType: "VENDOR_INVOICE", sourceId: row.id, amount: base });
        } else {
          const issues = await creditIssues(tx, row);
          if (issues.length) fail(409, `Nota kredit tidak eligible: ${issues.join(", ")}`);
          const [original] = await tx.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, row.originalInvoiceId ?? ""));
          const [line] = await tx.select().from(commitmentLinesTable).where(eq(commitmentLinesTable.id, row.lineId));
          const [commitment] = await tx.select().from(commitmentTable).where(eq(commitmentTable.id, row.commitmentId));
          const base = row.quantity * row.unitPrice;
          if (base > line.invoicedAmount) fail(409, "Nota kredit melebihi nilai posting");
          await tx.update(commitmentLinesTable).set({ invoicedAmount: line.invoicedAmount - base }).where(eq(commitmentLinesTable.id, line.id));
          await tx.insert(actualCostAllocationsTable).values({ id: randomUUID(), projectId: row.projectId, baselineId: commitment.baselineId, costCodeId: row.costCodeId, commitmentId: row.commitmentId, sourceType: "VENDOR_CREDIT", sourceId: row.id, amount: -base });
        }
      }
      if (action === "CANCEL" && row.kind === "CREDIT_NOTE" && row.status === "REVIEWED") fail(409, "Nota kredit yang telah direview tidak dapat dibatalkan");
      if (action === "CANCEL" && row.kind === "INVOICE" && row.status === "REVIEWED") {
        const [line] = await tx.select().from(commitmentLinesTable).where(eq(commitmentLinesTable.id, row.lineId));
        const [commitment] = await tx.select().from(commitmentTable).where(eq(commitmentTable.id, row.commitmentId));
        const credits = await tx.select().from(vendorInvoicesTable).where(and(eq(vendorInvoicesTable.originalInvoiceId, row.id), eq(vendorInvoicesTable.status, "REVIEWED")));
        if (credits.length) fail(409, "Invoice dengan nota kredit aktif tidak dapat dibatalkan");
        const base = row.quantity * row.unitPrice;
        await tx.update(commitmentLinesTable).set({ invoicedAmount: line.invoicedAmount - base }).where(eq(commitmentLinesTable.id, line.id));
        await tx.insert(actualCostAllocationsTable).values({ id: randomUUID(), projectId: row.projectId, baselineId: commitment.baselineId, costCodeId: row.costCodeId, commitmentId: row.commitmentId, sourceType: "VENDOR_CANCEL", sourceId: row.id, amount: -base });
      }
      const status = action === "REJECT" ? "REJECTED" : action === "CANCEL" ? "CANCELLED" : "REVIEWED";
      const [updated] = await tx.update(vendorInvoicesTable).set({ status, eligibleAmount: eligible, reviewerId: req.access!.userId, reviewEvidence: body.data.evidence.trim(), reviewedAt: new Date() }).where(eq(vendorInvoicesTable.id, row.id)).returning();
      await audit(tx, req, row.id, `VENDOR_${action}`, body.data.evidence, { previousStatus: row.status, exceptions: row.exceptions, eligibleAmount: eligible });
      return updated;
    });
    res.json(DecideVendorInvoiceResponse.parse(result));
  } catch (error) { errorResponse(error, res); }
});

router.get("/projects/:projectId/vendor-payments", requirePermission("commitments:view"), async (req, res) => {
  const projectId = String(req.params.projectId);
  if (!canAccessProject(req, projectId)) { res.sendStatus(403); return; }
  const invoices = await db.select({ id: vendorInvoicesTable.id }).from(vendorInvoicesTable).where(eq(vendorInvoicesTable.projectId, projectId));
  res.json(ListVendorPaymentsResponse.parse(invoices.length ? await db.select().from(vendorPaymentsTable).where(inArray(vendorPaymentsTable.invoiceId, invoices.map((row) => row.id))).orderBy(desc(vendorPaymentsTable.createdAt)) : []));
});
router.post("/vendor-invoices/:invoiceId/payments", requirePermission("commitments:write"), async (req, res) => {
  const body = RequestVendorPaymentBody.safeParse(req.body);
  if (!body.success || !safeMoney(body.data?.amount ?? NaN)) { res.status(400).json({ error: "Permintaan pembayaran tidak valid" }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const [lookup] = await tx.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, String(req.params.invoiceId)));
      if (!lookup) fail(404, "Invoice vendor tidak ditemukan");
      if (!canAccessProject(req, lookup.projectId)) fail(403, "Proyek di luar penugasan");
      await lock(tx, lookup.commitmentId);
      const [invoice] = await tx.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, lookup.id));
      if (!invoice) fail(404, "Invoice vendor tidak ditemukan");
      if (invoice.status !== "REVIEWED" || invoice.kind !== "INVOICE") fail(409, "Invoice belum eligible untuk pembayaran");
      if (invoice.reviewerId === req.access!.userId) fail(403, "Reviewer invoice tidak dapat membuat permintaan pembayaran yang sama");
      const credits = await tx.select().from(vendorInvoicesTable).where(and(eq(vendorInvoicesTable.originalInvoiceId, invoice.id), eq(vendorInvoicesTable.status, "REVIEWED")));
      const payments = await tx.select().from(vendorPaymentsTable).where(and(eq(vendorPaymentsTable.invoiceId, invoice.id), inArray(vendorPaymentsTable.status, ["REQUESTED", "APPROVED", "RELEASED"])));
      const available = invoice.eligibleAmount - credits.reduce((n, row) => n + row.total, 0) - payments.reduce((n, row) => n + row.amount, 0);
      if (body.data.amount > available) fail(409, `Sisa eligible hanya ${available}`);
      const [payment] = await tx.insert(vendorPaymentsTable).values({ id: randomUUID(), invoiceId: invoice.id, amount: body.data.amount, makerId: req.access!.userId, evidence: body.data.evidence.trim() }).returning();
      await audit(tx, req, payment.id, "VENDOR_PAYMENT_REQUEST", payment.evidence, { invoiceId: invoice.id, available, amount: payment.amount });
      return payment;
    });
    res.status(201).json(RequestVendorPaymentResponse.parse(result));
  } catch (error) { errorResponse(error, res); }
});
router.post("/vendor-payments/:paymentId/decision", requirePermission("commitments:approve"), async (req, res) => {
  const body = DecideVendorPaymentBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const [lookup] = await tx.select().from(vendorPaymentsTable).where(eq(vendorPaymentsTable.id, String(req.params.paymentId)));
      if (!lookup) fail(404, "Permintaan pembayaran tidak ditemukan");
      const [invoiceLookup] = await tx.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, lookup.invoiceId));
      if (!invoiceLookup) fail(404, "Invoice vendor tidak ditemukan");
      if (!canAccessProject(req, invoiceLookup.projectId)) fail(403, "Proyek di luar penugasan");
      await lock(tx, invoiceLookup.commitmentId);
      const [invoice] = await tx.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, lookup.invoiceId));
      if (!invoice) fail(404, "Invoice vendor tidak ditemukan");
      const [payment] = await tx.select().from(vendorPaymentsTable).where(eq(vendorPaymentsTable.id, lookup.id));
      if (invoice.status !== "REVIEWED") fail(409, "Invoice tidak lagi eligible");
      if (body.data.action === "RELEASE") {
        if (req.access!.role !== "FINANCE" && req.access!.role !== "DIRECTOR") fail(403, "Hanya Keuangan atau Director dapat melepas pembayaran");
        if (payment.status !== "APPROVED") fail(409, "Pembayaran belum disetujui");
        if ([payment.makerId, invoice.makerId, invoice.reviewerId, payment.approverId].includes(req.access!.userId)) fail(403, "Payment releaser harus berbeda dari maker, reviewer, dan approver");
      } else {
        if (payment.status !== "REQUESTED") fail(409, "Permintaan sudah diputuskan");
        if ([payment.makerId, invoice.makerId, invoice.reviewerId].includes(req.access!.userId)) fail(403, "Approver harus berbeda dari maker dan reviewer");
      }
      const status = body.data.action === "RELEASE" ? "RELEASED" : body.data.action === "APPROVE" ? "APPROVED" : "REJECTED";
      const [updated] = await tx.update(vendorPaymentsTable).set({
        status, ...(body.data.action === "RELEASE"
          ? { releaserId: req.access!.userId, releaseEvidence: body.data.evidence.trim() }
          : { approverId: req.access!.userId, approvalEvidence: body.data.evidence.trim() }),
      }).where(eq(vendorPaymentsTable.id, payment.id)).returning();
      await audit(tx, req, payment.id, `VENDOR_PAYMENT_${body.data.action}`, body.data.evidence, { invoiceId: invoice.id, amount: payment.amount, previousStatus: payment.status });
      return updated;
    });
    res.json(DecideVendorPaymentResponse.parse(result));
  } catch (error) { errorResponse(error, res); }
});

export default router;