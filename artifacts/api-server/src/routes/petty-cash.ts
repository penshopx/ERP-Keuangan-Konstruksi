import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  pettyCashExpensesTable,
  pettyCashPolicyVersionsTable,
  pettyCashRequestsTable,
  projectsTable,
} from "@workspace/db";
import {
  CreatePettyCashRequestBody,
  CreatePettyCashRequestResponse,
  DecidePettyCashRequestBody,
  DecidePettyCashRequestParams,
  DecidePettyCashRequestResponse,
  DisbursePettyCashRequestBody,
  DisbursePettyCashRequestParams,
  DisbursePettyCashRequestResponse,
  ListPettyCashRequestsQueryParams,
  ListPettyCashRequestsResponse,
  ReconcilePettyCashRequestBody,
  ReconcilePettyCashRequestParams,
  ReconcilePettyCashRequestResponse,
  SettlePettyCashRequestBody,
  SettlePettyCashRequestParams,
  SettlePettyCashRequestResponse,
} from "@workspace/api-zod";
import { canAccessProject, requirePermission } from "../middlewares/access";

const router: IRouter = Router();

function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

async function withExpenses(requests: (typeof pettyCashRequestsTable.$inferSelect)[]) {
  return Promise.all(requests.map(async (request) => {
    const expenses = await db.select({
      id: pettyCashExpensesTable.id,
      expenseDate: pettyCashExpensesTable.expenseDate,
      description: pettyCashExpensesTable.description,
      amount: pettyCashExpensesTable.amount,
      receiptReference: pettyCashExpensesTable.receiptReference,
    }).from(pettyCashExpensesTable).where(eq(pettyCashExpensesTable.requestId, request.id));
    return { ...request, expenses };
  }));
}

async function getRequest(id: string) {
  const [request] = await db.select().from(pettyCashRequestsTable).where(eq(pettyCashRequestsTable.id, id)).limit(1);
  return request;
}

router.get("/petty-cash", requirePermission("petty-cash:view"), async (req, res): Promise<void> => {
  const parsed = ListPettyCashRequestsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [
    parsed.data.projectId ? eq(pettyCashRequestsTable.projectId, parsed.data.projectId) : undefined,
    parsed.data.status ? eq(pettyCashRequestsTable.status, parsed.data.status) : undefined,
  ].filter((item) => item !== undefined);
  if (req.access?.role === "PROJECT_MANAGER") {
    if (req.access.assignedProjectIds.length === 0) {
      res.json(ListPettyCashRequestsResponse.parse([]));
      return;
    }
    filters.push(or(...req.access.assignedProjectIds.map((id) => eq(pettyCashRequestsTable.projectId, id)))!);
  }
  const requests = await db.select().from(pettyCashRequestsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(pettyCashRequestsTable.createdAt));
  res.json(ListPettyCashRequestsResponse.parse(await withExpenses(requests)));
});

router.post("/petty-cash", requirePermission("petty-cash:request"), async (req, res): Promise<void> => {
  const parsed = CreatePettyCashRequestBody.safeParse(req.body);
  if (!parsed.success || !Number.isSafeInteger(parsed.data?.requestedAmount)) {
    res.status(400).json({ error: parsed.success ? "Jumlah harus berupa rupiah bulat" : parsed.error.message });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, parsed.data.projectId)).limit(1);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan" });
    return;
  }
  if (!canAccessProject(req, project.id)) {
    res.status(403).json({ error: "Proyek berada di luar penugasan Anda" });
    return;
  }
  if (project.status !== "BERJALAN") {
    res.status(409).json({ error: "Kas kecil hanya dapat diajukan untuk proyek berjalan" });
    return;
  }
  const [policy] = await db.select().from(pettyCashPolicyVersionsTable).where(and(
    lte(pettyCashPolicyVersionsTable.effectiveFrom, parsed.data.requestedAt),
    or(isNull(pettyCashPolicyVersionsTable.effectiveTo), gte(pettyCashPolicyVersionsTable.effectiveTo, parsed.data.requestedAt)),
  )).orderBy(desc(pettyCashPolicyVersionsTable.effectiveFrom)).limit(1);
  if (!policy) {
    res.status(422).json({ error: "Tidak ada kebijakan kas kecil yang berlaku pada tanggal permintaan" });
    return;
  }
  const id = randomUUID();
  const created = await db.transaction(async (tx) => {
    const [request] = await tx.insert(pettyCashRequestsTable).values({
      id,
      projectId: project.id,
      projectCode: project.code,
      projectName: project.name,
      requesterUserId: req.access!.userId,
      requesterName: req.access!.displayName,
      purpose: parsed.data.purpose,
      costCode: parsed.data.costCode,
      requestedAmount: parsed.data.requestedAmount,
      requestedAt: parsed.data.requestedAt,
      evidenceDueAt: addCalendarDays(parsed.data.requestedAt, policy.evidenceDueDays),
      policyVersionId: policy.id,
      policyVersion: policy.version,
    }).returning();
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "DIAJUKAN", entity: "Kas Kecil", entityId: id,
      detail: `${project.code} · ${parsed.data.purpose} · Rp${parsed.data.requestedAmount.toLocaleString("id-ID")}`,
      user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info",
      metadata: { projectId: project.id, policyVersion: policy.version },
    });
    return request;
  });
  res.status(201).json(CreatePettyCashRequestResponse.parse({ ...created, expenses: [] }));
});

router.post("/petty-cash/:requestId/decision", requirePermission("petty-cash:approve"), async (req, res): Promise<void> => {
  const params = DecidePettyCashRequestParams.safeParse(req.params);
  const body = DecidePettyCashRequestBody.safeParse(req.body);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const request = await getRequest(params.data.requestId);
  if (!request) { res.status(404).json({ error: "Permintaan tidak ditemukan" }); return; }
  if (!canAccessProject(req, request.projectId)) { res.status(403).json({ error: "Proyek berada di luar penugasan Anda" }); return; }
  if (request.status !== "DIAJUKAN") { res.status(409).json({ error: "Permintaan ini sudah diputuskan" }); return; }
  if (request.requesterUserId === req.access!.userId) { res.status(409).json({ error: "Pemohon tidak boleh menyetujui permintaannya sendiri" }); return; }
  if (body.data.decision === "APPROVE" && (!Number.isSafeInteger(body.data.approvedAmount) || !body.data.approvedAmount || body.data.approvedAmount > request.requestedAmount)) {
    res.status(400).json({ error: "Jumlah persetujuan harus berupa rupiah bulat dan tidak melebihi permintaan" });
    return;
  }
  const [updated] = await db.transaction(async (tx) => {
    const [stored] = await tx.update(pettyCashRequestsTable).set({
      status: body.data.decision === "APPROVE" ? "DISETUJUI" : "DITOLAK",
      approvedAmount: body.data.decision === "APPROVE" ? body.data.approvedAmount : null,
      approverUserId: req.access!.userId,
      approverName: req.access!.displayName,
      approvalNote: body.data.note,
      approvedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(pettyCashRequestsTable.id, request.id), eq(pettyCashRequestsTable.status, "DIAJUKAN"))).returning();
    if (!stored) throw new Error("Permintaan berubah saat approval diproses");
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: body.data.decision === "APPROVE" ? "DISETUJUI" : "DITOLAK",
      entity: "Kas Kecil", entityId: request.id, detail: `${request.projectCode} · ${body.data.note}`,
      user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role,
      tone: body.data.decision === "APPROVE" ? "success" : "warning",
    });
    return [stored];
  });
  res.json(DecidePettyCashRequestResponse.parse({ ...updated, expenses: [] }));
});

router.post("/petty-cash/:requestId/disburse", requirePermission("petty-cash:disburse"), async (req, res): Promise<void> => {
  const params = DisbursePettyCashRequestParams.safeParse(req.params);
  const body = DisbursePettyCashRequestBody.safeParse(req.body);
  if (!params.success || !body.success || !Number.isSafeInteger(body.data?.amount)) {
    res.status(400).json({ error: "Data pencairan tidak valid" });
    return;
  }
  const request = await getRequest(params.data.requestId);
  if (!request) { res.status(404).json({ error: "Permintaan tidak ditemukan" }); return; }
  if (!canAccessProject(req, request.projectId)) { res.status(403).json({ error: "Proyek berada di luar penugasan Anda" }); return; }
  if (request.status !== "DISETUJUI") { res.status(409).json({ error: "Hanya permintaan disetujui yang dapat dicairkan" }); return; }
  if (request.approverUserId === req.access!.userId) { res.status(409).json({ error: "Penyetuju tidak boleh mencairkan permintaan yang sama" }); return; }
  if (body.data.amount !== request.approvedAmount) { res.status(400).json({ error: "Jumlah pencairan harus sama dengan jumlah yang disetujui" }); return; }
  const [updated] = await db.transaction(async (tx) => {
    const [stored] = await tx.update(pettyCashRequestsTable).set({
      status: "DICAIRKAN", disbursedAmount: body.data.amount,
      disburserUserId: req.access!.userId, disburserName: req.access!.displayName,
      disbursementReference: body.data.reference, disbursedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(pettyCashRequestsTable.id, request.id), eq(pettyCashRequestsTable.status, "DISETUJUI"))).returning();
    if (!stored) throw new Error("Permintaan berubah saat pencairan diproses");
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "DICAIRKAN", entity: "Kas Kecil", entityId: request.id,
      detail: `${request.projectCode} · ${body.data.reference}`, user: req.access!.displayName,
      actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "success",
    });
    return [stored];
  });
  res.json(DisbursePettyCashRequestResponse.parse({ ...updated, expenses: [] }));
});

router.post("/petty-cash/:requestId/settle", requirePermission("petty-cash:settle"), async (req, res): Promise<void> => {
  const params = SettlePettyCashRequestParams.safeParse(req.params);
  const body = SettlePettyCashRequestBody.safeParse(req.body);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const request = await getRequest(params.data.requestId);
  if (!request) { res.status(404).json({ error: "Permintaan tidak ditemukan" }); return; }
  if (!canAccessProject(req, request.projectId)) { res.status(403).json({ error: "Proyek berada di luar penugasan Anda" }); return; }
  if (request.status !== "DICAIRKAN") { res.status(409).json({ error: "Hanya dana yang telah dicairkan dapat dipertanggungjawabkan" }); return; }
  if (request.requesterUserId !== req.access!.userId && req.access!.role !== "DIRECTOR") { res.status(403).json({ error: "Pertanggungjawaban harus diserahkan oleh pemohon" }); return; }
  const spentAmount = body.data.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  if (![spentAmount, body.data.returnedAmount].every(Number.isSafeInteger) || spentAmount + body.data.returnedAmount !== request.disbursedAmount) {
    res.status(400).json({ error: "Jumlah pengeluaran dan pengembalian harus sama dengan dana yang dicairkan" });
    return;
  }
  const updated = await db.transaction(async (tx) => {
    await tx.insert(pettyCashExpensesTable).values(body.data.expenses.map((expense) => ({
      id: randomUUID(), requestId: request.id, ...expense,
    })));
    const [stored] = await tx.update(pettyCashRequestsTable).set({
      status: "DIPERTANGGUNGJAWABKAN", spentAmount, returnedAmount: body.data.returnedAmount,
      settledAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(pettyCashRequestsTable.id, request.id), eq(pettyCashRequestsTable.status, "DICAIRKAN"))).returning();
    if (!stored) throw new Error("Permintaan berubah saat pertanggungjawaban diproses");
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "DIPERTANGGUNGJAWABKAN", entity: "Kas Kecil", entityId: request.id,
      detail: `${body.data.expenses.length} bukti · Rp${spentAmount.toLocaleString("id-ID")} digunakan`,
      user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info",
    });
    return stored;
  });
  res.json(SettlePettyCashRequestResponse.parse((await withExpenses([updated]))[0]));
});

router.post("/petty-cash/:requestId/reconcile", requirePermission("petty-cash:reconcile"), async (req, res): Promise<void> => {
  const params = ReconcilePettyCashRequestParams.safeParse(req.params);
  const body = ReconcilePettyCashRequestBody.safeParse(req.body);
  if (!params.success || !body.success || !Number.isSafeInteger(body.data?.physicalCashAmount)) {
    res.status(400).json({ error: "Data rekonsiliasi tidak valid" });
    return;
  }
  const request = await getRequest(params.data.requestId);
  if (!request) { res.status(404).json({ error: "Permintaan tidak ditemukan" }); return; }
  if (!canAccessProject(req, request.projectId)) { res.status(403).json({ error: "Proyek berada di luar penugasan Anda" }); return; }
  if (request.status !== "DIPERTANGGUNGJAWABKAN") { res.status(409).json({ error: "Pertanggungjawaban belum siap direkonsiliasi" }); return; }
  if ([request.requesterUserId, request.disburserUserId].includes(req.access!.userId)) {
    res.status(409).json({ error: "Pemohon atau pencair dana tidak boleh merekonsiliasi transaksi yang sama" });
    return;
  }
  if (body.data.physicalCashAmount !== request.returnedAmount) {
    res.status(409).json({ error: "Kas fisik tidak sama dengan sisa yang dikembalikan" });
    return;
  }
  const updated = await db.transaction(async (tx) => {
    const [stored] = await tx.update(pettyCashRequestsTable).set({
      status: "DIREKONSILIASI", physicalCashAmount: body.data.physicalCashAmount,
      reconcilerUserId: req.access!.userId, reconcilerName: req.access!.displayName,
      reconciliationNote: body.data.note, reconciledAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(pettyCashRequestsTable.id, request.id), eq(pettyCashRequestsTable.status, "DIPERTANGGUNGJAWABKAN"))).returning();
    if (!stored) throw new Error("Permintaan berubah saat rekonsiliasi diproses");
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "DIREKONSILIASI", entity: "Kas Kecil", entityId: request.id,
      detail: `${request.projectCode} · saldo fisik sesuai`, user: req.access!.displayName,
      actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "success",
    });
    return stored;
  });
  res.json(ReconcilePettyCashRequestResponse.parse((await withExpenses([updated]))[0]));
});

export default router;