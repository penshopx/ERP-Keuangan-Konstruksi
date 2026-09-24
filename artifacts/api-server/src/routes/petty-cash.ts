import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  pettyCashExpensesTable,
  pettyCashExceptionsTable,
  pettyCashFundsTable,
  pettyCashFundEventsTable,
  pettyCashPolicyVersionsTable,
  pettyCashRequestsTable,
  rabBaselinesTable,
  rabItemsTable,
  projectCostCodesTable,
  actualCostAllocationsTable,
  commitmentLinesTable,
  commitmentTable,
  userRolesTable,
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
  ListPettyCashFundsResponse,
  ListPettyCashFundsQueryParams,
  CreatePettyCashFundBody,
  CreatePettyCashFundResponse,
  ReplenishPettyCashFundBody,
  ReplenishPettyCashFundParams,
  ReplenishPettyCashFundResponse,
  ListPettyCashPoliciesResponse,
  CreatePettyCashPolicyBody,
  CreatePettyCashPolicyResponse,
  ResolvePettyCashEvidenceBody,
  ResolvePettyCashEvidenceParams,
  ResolvePettyCashEvidenceResponse,
  VerifyPettyCashRequestParams,
  VerifyPettyCashRequestResponse,
  EvaluatePettyCashRequestBody,
  EvaluatePettyCashRequestParams,
  EvaluatePettyCashRequestResponse,
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
function todayInJakarta() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
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
    const exceptions = await db.select({
      id: pettyCashExceptionsTable.id,
      expenseId: pettyCashExceptionsTable.expenseId,
      ownerUserId: pettyCashExceptionsTable.ownerUserId,
      dueAt: pettyCashExceptionsTable.dueAt,
      status: pettyCashExceptionsTable.status,
    }).from(pettyCashExceptionsTable).where(eq(pettyCashExceptionsTable.requestId, request.id));
    return { ...request, expenses, exceptions };
  }));
}

async function getRequest(id: string) {
  const [request] = await db.select().from(pettyCashRequestsTable).where(eq(pettyCashRequestsTable.id, id)).limit(1);
  return request;
}

async function audit(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], req: Request, id: string, action: string, detail: string) {
  await tx.insert(auditLogsTable).values({
    id: randomUUID(), action, entity: "Kas Kecil", entityId: id, detail,
    user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info",
  });
}

router.get("/petty-cash/funds", requirePermission("petty-cash:view"), async (req, res): Promise<void> => {
  const params = ListPettyCashFundsQueryParams.safeParse(req.query);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const funds = await db.select().from(pettyCashFundsTable).where(and(
    params.data.projectId ? eq(pettyCashFundsTable.projectId, params.data.projectId) : undefined,
    req.access!.role === "PROJECT_MANAGER"
      ? req.access!.assignedProjectIds.length
        ? or(...req.access!.assignedProjectIds.map((id) => eq(pettyCashFundsTable.projectId, id)))
        : sql`false`
      : undefined,
  ));
  res.json(ListPettyCashFundsResponse.parse(funds));
});

router.post("/petty-cash/funds", requirePermission("petty-cash:manage"), async (req, res): Promise<void> => {
  const body = CreatePettyCashFundBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, body.data.projectId));
  if (!project) { res.status(404).json({ error: "Proyek tidak ditemukan" }); return; }
  const [custodian] = await db.select().from(userRolesTable).where(eq(userRolesTable.userId, body.data.custodianUserId));
  if (!custodian || custodian.role !== "FINANCE" || custodian.displayName !== body.data.custodianName) {
    res.status(422).json({ error: "Custodian harus pengguna Finance yang aktif" }); return;
  }
  const [existingFund] = await db.select().from(pettyCashFundsTable).where(and(
    eq(pettyCashFundsTable.projectId, project.id), eq(pettyCashFundsTable.location, body.data.location),
  )).limit(1);
  if (existingFund) { res.status(409).json({ error: "Lokasi ini sudah memiliki dana kas kecil" }); return; }
  const created = await db.transaction(async tx => {
    const [fund] = await tx.insert(pettyCashFundsTable).values({ id: randomUUID(), ...body.data })
      .onConflictDoNothing({ target: [pettyCashFundsTable.projectId, pettyCashFundsTable.location] }).returning();
    if (!fund) return null;
    await audit(tx, req, fund.id, "DANA_DIBUAT", `${project.code} · ${fund.location} · ${fund.custodianName}`);
    return fund;
  });
  if (!created) { res.status(409).json({ error: "Lokasi ini sudah memiliki dana kas kecil" }); return; }
  res.status(201).json(CreatePettyCashFundResponse.parse(created));
});

router.post("/petty-cash/funds/:fundId/replenish", requirePermission("petty-cash:manage"), async (req, res): Promise<void> => {
  const params = ReplenishPettyCashFundParams.safeParse(req.params);
  const body = ReplenishPettyCashFundBody.safeParse(req.body);
  if (!params.success || !body.success || !Number.isSafeInteger(body.data?.amount)) { res.status(400).json({ error: "Data isi ulang tidak valid" }); return; }
  const fund = await db.transaction(async tx => {
    const [updated] = await tx.update(pettyCashFundsTable).set({ bookBalance: sql`${pettyCashFundsTable.bookBalance} + ${body.data.amount}` })
      .where(eq(pettyCashFundsTable.id, params.data.fundId)).returning();
    if (!updated) return null;
    await tx.insert(pettyCashFundEventsTable).values({ id: randomUUID(), fundId: updated.id, kind: "REPLENISH", amount: body.data.amount, reference: body.data.reference, actorUserId: req.access!.userId });
    await audit(tx, req, updated.id, "DANA_DIISI", `${body.data.reference} · Rp${body.data.amount}`);
    return updated;
  });
  if (!fund) { res.status(404).json({ error: "Dana tidak ditemukan" }); return; }
  res.json(ReplenishPettyCashFundResponse.parse(fund));
});

router.get("/petty-cash/policies", requirePermission("petty-cash:view"), async (_req, res): Promise<void> => {
  res.json(ListPettyCashPoliciesResponse.parse(await db.select().from(pettyCashPolicyVersionsTable).orderBy(desc(pettyCashPolicyVersionsTable.effectiveFrom))));
});

router.post("/petty-cash/policies", requirePermission("petty-cash:manage"), async (req, res): Promise<void> => {
  const body = CreatePettyCashPolicyBody.safeParse(req.body);
  if (!body.success || !Number.isSafeInteger(body.data?.maxRequestAmount) || !Number.isSafeInteger(body.data?.directorApprovalAbove)
    || body.data.directorApprovalAbove > body.data.maxRequestAmount || (body.data.effectiveTo && body.data.effectiveTo < body.data.effectiveFrom)) {
    res.status(400).json({ error: "Kebijakan tidak valid" }); return;
  }
  const result = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('petty-cash-policy'))`);
    const overlap = await tx.select().from(pettyCashPolicyVersionsTable).where(and(
      lte(pettyCashPolicyVersionsTable.effectiveFrom, body.data.effectiveTo ?? "9999-12-31"),
      or(isNull(pettyCashPolicyVersionsTable.effectiveTo), gte(pettyCashPolicyVersionsTable.effectiveTo, body.data.effectiveFrom)),
    ));
    if (overlap.some(row => row.effectiveFrom >= body.data.effectiveFrom || row.effectiveTo !== null || body.data.effectiveTo !== undefined && body.data.effectiveTo !== null)) return null;
    if (overlap.length > 1) return null;
    if (overlap[0]) await tx.update(pettyCashPolicyVersionsTable).set({ effectiveTo: addCalendarDays(body.data.effectiveFrom, -1) })
      .where(eq(pettyCashPolicyVersionsTable.id, overlap[0].id));
    const [policy] = await tx.insert(pettyCashPolicyVersionsTable).values({ ...body.data, id: randomUUID() }).returning();
    await audit(tx, req, policy.id, "KEBIJAKAN_DIBUAT", policy.version);
    return policy;
  });
  if (!result) { res.status(409).json({ error: "Periode kebijakan tumpang tindih" }); return; }
  res.status(201).json(CreatePettyCashPolicyResponse.parse(result));
});

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
  const [fund] = await db.select().from(pettyCashFundsTable).where(and(eq(pettyCashFundsTable.id, parsed.data.fundId), eq(pettyCashFundsTable.projectId, project.id)));
  if (!fund) { res.status(422).json({ error: "Dana lokasi tidak ditemukan untuk proyek ini" }); return; }
  const [policy] = await db.select().from(pettyCashPolicyVersionsTable).where(and(
    lte(pettyCashPolicyVersionsTable.effectiveFrom, todayInJakarta()),
    or(isNull(pettyCashPolicyVersionsTable.effectiveTo), gte(pettyCashPolicyVersionsTable.effectiveTo, todayInJakarta())),
  )).orderBy(desc(pettyCashPolicyVersionsTable.effectiveFrom)).limit(1);
  if (!policy) {
    res.status(422).json({ error: "Tidak ada kebijakan kas kecil yang berlaku pada tanggal permintaan" });
    return;
  }
  if (parsed.data.requestedAmount > policy.maxRequestAmount) {
    res.status(422).json({ error: "Jumlah melampaui batas kebijakan kas kecil" }); return;
  }
  const id = randomUUID();
  const created = await db.transaction(async (tx) => {
    const [request] = await tx.insert(pettyCashRequestsTable).values({
      id,
      projectId: project.id,
      fundId: fund.id,
      projectCode: project.code,
      projectName: project.name,
      requesterUserId: req.access!.userId,
      requesterName: req.access!.displayName,
      purpose: parsed.data.purpose,
      costCode: parsed.data.costCode,
      requestedAmount: parsed.data.requestedAmount,
      requestedAt: parsed.data.requestedAt,
      evidenceDueAt: addCalendarDays(todayInJakarta(), policy.evidenceDueDays),
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
  res.status(201).json(CreatePettyCashRequestResponse.parse({ ...created, expenses: [], exceptions: [] }));
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
  const [policy] = await db.select().from(pettyCashPolicyVersionsTable).where(eq(pettyCashPolicyVersionsTable.id, request.policyVersionId));
  if (!policy) { res.status(422).json({ error: "Kebijakan transaksi tidak ditemukan" }); return; }
  const permittedRoles = body.data.approvedAmount! > policy.directorApprovalAbove
    ? [policy.highApproverRole]
    : [policy.standardApproverRole, policy.highApproverRole];
  if (body.data.decision === "APPROVE" && !permittedRoles.includes(req.access!.role)) {
    res.status(403).json({ error: `Jumlah ini memerlukan persetujuan ${body.data.approvedAmount! > policy.directorApprovalAbove ? policy.highApproverRole : policy.standardApproverRole}` }); return;
  }
  const [updated] = await db.transaction(async (tx) => {
    if (body.data.decision === "APPROVE") {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${request.projectId}))`);
      const [baseline] = await tx.select().from(rabBaselinesTable).where(and(
        eq(rabBaselinesTable.projectId, request.projectId), eq(rabBaselinesTable.status, "DISETUJUI"),
      )).orderBy(desc(rabBaselinesTable.version)).limit(1);
      const [code] = await tx.select().from(projectCostCodesTable).where(and(
        eq(projectCostCodesTable.projectId, request.projectId), eq(projectCostCodesTable.code, request.costCode),
      )).limit(1);
      if (!baseline || !code) { res.status(422).json({ error: "Cost code harus ada pada RAB yang disetujui" }); return [null]; }
      const [budget] = await tx.select({ amount: sql<number>`coalesce(sum(${rabItemsTable.budget}),0)` }).from(rabItemsTable)
        .where(and(eq(rabItemsTable.baselineId, baseline.id), eq(rabItemsTable.costCodeId, code.id)));
      const [actual] = await tx.select({ amount: sql<number>`coalesce(sum(${actualCostAllocationsTable.amount}),0)` }).from(actualCostAllocationsTable)
        .where(and(eq(actualCostAllocationsTable.projectId, request.projectId), eq(actualCostAllocationsTable.costCodeId, code.id)));
      const [committed] = await tx.select({ amount: sql<number>`coalesce(sum(${commitmentLinesTable.amount} - ${commitmentLinesTable.invoicedAmount}),0)` })
        .from(commitmentLinesTable).innerJoin(commitmentTable, eq(commitmentTable.id, commitmentLinesTable.commitmentId))
        .where(and(eq(commitmentTable.projectId, request.projectId), eq(commitmentLinesTable.costCodeId, code.id),
          or(eq(commitmentTable.status, "APPROVED"), eq(commitmentTable.status, "CLOSED"))));
      const existing = await tx.select({ approved: pettyCashRequestsTable.approvedAmount, spent: pettyCashRequestsTable.spentAmount, status: pettyCashRequestsTable.status })
        .from(pettyCashRequestsTable).where(and(eq(pettyCashRequestsTable.projectId, request.projectId), eq(pettyCashRequestsTable.costCode, request.costCode),
          sql`${pettyCashRequestsTable.status} IN ('DISETUJUI','DICAIRKAN','DIPERTANGGUNGJAWABKAN','DIVERIFIKASI','DIREKONSILIASI','DIEVALUASI')`));
      const reserved = existing.reduce((sum, row) => sum + (row.spent === null ? row.approved ?? 0 : 0), 0);
      if (Number(budget.amount) - Number(actual.amount) - Number(committed.amount) - reserved < body.data.approvedAmount!) {
        res.status(422).json({ error: "Saldo budget cost code tidak cukup untuk persetujuan ini" }); return [null];
      }
    }
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
  if (!updated) return;
  res.json(DecidePettyCashRequestResponse.parse({ ...updated, expenses: [], exceptions: [] }));
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
  if (request.requesterUserId === req.access!.userId) { res.status(409).json({ error: "Pemohon tidak boleh mencairkan dana sendiri" }); return; }
  const [assignedFund] = request.fundId ? await db.select().from(pettyCashFundsTable).where(eq(pettyCashFundsTable.id, request.fundId)) : [];
  // Requests created before funds were introduced retain their original cash-flow rules.
  // Never attach them to a new fund or invent an opening balance.
  if (request.fundId && (!assignedFund || assignedFund.custodianUserId !== req.access!.userId)) {
    res.status(403).json({ error: "Hanya custodian dana yang dapat mencairkan" }); return;
  }
  if (body.data.amount !== request.approvedAmount) { res.status(400).json({ error: "Jumlah pencairan harus sama dengan jumlah yang disetujui" }); return; }
  const [policy] = await db.select().from(pettyCashPolicyVersionsTable).where(eq(pettyCashPolicyVersionsTable.id, request.policyVersionId));
  if (!policy) { res.status(422).json({ error: "Kebijakan transaksi tidak ditemukan" }); return; }
  const [updated] = await db.transaction(async (tx) => {
    if (request.fundId) {
      const [fund] = await tx.update(pettyCashFundsTable).set({ bookBalance: sql`${pettyCashFundsTable.bookBalance} - ${body.data.amount}` })
        .where(and(eq(pettyCashFundsTable.id, request.fundId), gte(pettyCashFundsTable.bookBalance, body.data.amount))).returning();
      if (!fund) {
        res.status(409).json({ error: "Dana tidak cukup atau dana tidak ditemukan" }); return [null];
      }
    }
    const [stored] = await tx.update(pettyCashRequestsTable).set({
      status: "DICAIRKAN", disbursedAmount: body.data.amount,
      evidenceDueAt: addCalendarDays(todayInJakarta(), policy.evidenceDueDays),
      disburserUserId: req.access!.userId, disburserName: req.access!.displayName,
      disbursementReference: body.data.reference, disbursedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(pettyCashRequestsTable.id, request.id), eq(pettyCashRequestsTable.status, "DISETUJUI"))).returning();
    if (!stored) throw new Error("Permintaan berubah saat pencairan diproses");
    if (request.fundId) await tx.insert(pettyCashFundEventsTable).values({ id: randomUUID(), fundId: request.fundId, requestId: request.id, kind: "DISBURSE", amount: body.data.amount, reference: body.data.reference, actorUserId: req.access!.userId });
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "DICAIRKAN", entity: "Kas Kecil", entityId: request.id,
      detail: `${request.projectCode} · ${body.data.reference}`, user: req.access!.displayName,
      actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "success",
    });
    return [stored];
  });
  if (!updated) return;
  res.json(DisbursePettyCashRequestResponse.parse({ ...updated, expenses: [], exceptions: [] }));
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
  if (request.requesterUserId !== req.access!.userId) { res.status(403).json({ error: "Pertanggungjawaban harus diserahkan oleh pemohon" }); return; }
  const spentAmount = body.data.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  if (![spentAmount, body.data.returnedAmount].every(Number.isSafeInteger) || spentAmount + body.data.returnedAmount !== request.disbursedAmount) {
    res.status(400).json({ error: "Jumlah pengeluaran dan pengembalian harus sama dengan dana yang dicairkan" });
    return;
  }
  if (body.data.returnedAmount > 0 && !body.data.returnReference?.trim()) {
    res.status(400).json({ error: "Pengembalian sisa harus memiliki referensi serah terima" }); return;
  }
  const updated = await db.transaction(async (tx) => {
    const [stored] = await tx.update(pettyCashRequestsTable).set({
      status: "DIPERTANGGUNGJAWABKAN", spentAmount, returnedAmount: body.data.returnedAmount,
      settledAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(pettyCashRequestsTable.id, request.id), eq(pettyCashRequestsTable.status, "DICAIRKAN"))).returning();
    if (!stored) throw new Error("Permintaan berubah saat pertanggungjawaban diproses");
    const [baseline] = request.fundId ? await tx.select().from(rabBaselinesTable).where(and(
      eq(rabBaselinesTable.projectId, request.projectId), eq(rabBaselinesTable.status, "DISETUJUI"),
    )).orderBy(desc(rabBaselinesTable.version)).limit(1) : [];
    const [code] = request.fundId ? await tx.select().from(projectCostCodesTable).where(and(
      eq(projectCostCodesTable.projectId, request.projectId), eq(projectCostCodesTable.code, request.costCode),
    )).limit(1) : [];
    if (request.fundId && (!baseline || !code)) throw new Error("RAB atau cost code yang disetujui tidak ditemukan");
    const expenses = body.data.expenses.length ? await tx.insert(pettyCashExpensesTable).values(body.data.expenses.map((expense) => ({
      id: randomUUID(), requestId: request.id, ...expense, receiptReference: expense.receiptReference?.trim() || null,
    }))).returning() : [];
    if (expenses.length && baseline && code) await tx.insert(actualCostAllocationsTable).values(expenses.map(expense => ({
      id: randomUUID(), projectId: request.projectId, baselineId: baseline.id, costCodeId: code.id,
      sourceType: "PETTY_CASH", sourceId: expense.id, amount: expense.amount,
    })));
    if (request.fundId && body.data.returnedAmount > 0) {
      await tx.update(pettyCashFundsTable).set({ bookBalance: sql`${pettyCashFundsTable.bookBalance} + ${body.data.returnedAmount}` }).where(eq(pettyCashFundsTable.id, request.fundId));
      await tx.insert(pettyCashFundEventsTable).values({ id: randomUUID(), fundId: request.fundId, requestId: request.id, kind: "RETURN", amount: body.data.returnedAmount, reference: body.data.returnReference!, actorUserId: req.access!.userId });
    }
    const missing = expenses.filter(expense => !expense.receiptReference);
    if (missing.length) await tx.insert(pettyCashExceptionsTable).values(missing.map(expense => ({
      id: randomUUID(), requestId: request.id, expenseId: expense.id, ownerUserId: request.requesterUserId, dueAt: request.evidenceDueAt,
    })));
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "DIPERTANGGUNGJAWABKAN", entity: "Kas Kecil", entityId: request.id,
      detail: `${body.data.expenses.length} bukti · Rp${spentAmount.toLocaleString("id-ID")} digunakan`,
      user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info",
    });
    return stored;
  });
  res.json(SettlePettyCashRequestResponse.parse((await withExpenses([updated]))[0]));
});

router.post("/petty-cash/:requestId/evidence", requirePermission("petty-cash:settle"), async (req, res): Promise<void> => {
  const params = ResolvePettyCashEvidenceParams.safeParse(req.params);
  const body = ResolvePettyCashEvidenceBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Bukti tidak valid" }); return; }
  const request = await getRequest(params.data.requestId);
  if (!request) { res.status(404).json({ error: "Permintaan tidak ditemukan" }); return; }
  if (!canAccessProject(req, request.projectId) || request.requesterUserId !== req.access!.userId) { res.status(403).json({ error: "Bukti hanya dapat dilengkapi pemohon" }); return; }
  if (request.status !== "DIPERTANGGUNGJAWABKAN") { res.status(409).json({ error: "Bukti tidak dapat diubah pada tahap ini" }); return; }
  const resolved = await db.transaction(async tx => {
    const [exception] = await tx.update(pettyCashExceptionsTable).set({ status: "RESOLVED", resolvedAt: new Date(), resolvedBy: req.access!.userId })
      .where(and(eq(pettyCashExceptionsTable.requestId, request.id), eq(pettyCashExceptionsTable.expenseId, body.data.expenseId), eq(pettyCashExceptionsTable.status, "OPEN"))).returning();
    if (!exception) return false;
    await tx.update(pettyCashExpensesTable).set({ receiptReference: body.data.receiptReference }).where(eq(pettyCashExpensesTable.id, exception.expenseId));
    await audit(tx, req, request.id, "BUKTI_DILENGKAPI", `Pengeluaran ${exception.expenseId}`);
    return true;
  });
  if (!resolved) { res.status(409).json({ error: "Exception bukti tidak terbuka" }); return; }
  res.json(ResolvePettyCashEvidenceResponse.parse((await withExpenses([request]))[0]));
});

router.post("/petty-cash/:requestId/verify", requirePermission("petty-cash:verify"), async (req, res): Promise<void> => {
  const params = VerifyPettyCashRequestParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const request = await getRequest(params.data.requestId);
  if (!request) { res.status(404).json({ error: "Permintaan tidak ditemukan" }); return; }
  if (!canAccessProject(req, request.projectId)) { res.status(403).json({ error: "Proyek di luar penugasan" }); return; }
  if (request.status !== "DIPERTANGGUNGJAWABKAN") { res.status(409).json({ error: "Settlement belum siap diverifikasi" }); return; }
  if ([request.requesterUserId, request.approverUserId, request.disburserUserId].includes(req.access!.userId)) { res.status(409).json({ error: "Verifikator harus berbeda dari pemohon, penyetuju, dan custodian" }); return; }
  const pending = await db.select({ id: pettyCashExceptionsTable.id }).from(pettyCashExceptionsTable)
    .where(and(eq(pettyCashExceptionsTable.requestId, request.id), eq(pettyCashExceptionsTable.status, "OPEN"))).limit(1);
  if (pending.length) { res.status(409).json({ error: "Bukti yang belum dilengkapi harus ditindaklanjuti" }); return; }
  const updated = await db.transaction(async tx => {
    const [row] = await tx.update(pettyCashRequestsTable).set({ status: "DIVERIFIKASI", verifierUserId: req.access!.userId, verifierName: req.access!.displayName, verifiedAt: new Date() })
      .where(and(eq(pettyCashRequestsTable.id, request.id), eq(pettyCashRequestsTable.status, "DIPERTANGGUNGJAWABKAN"))).returning();
    if (!row) return null;
    await audit(tx, req, row.id, "DIVERIFIKASI", "Bukti settlement diperiksa");
    return row;
  });
  if (!updated) { res.status(409).json({ error: "Status berubah" }); return; }
  res.json(VerifyPettyCashRequestResponse.parse((await withExpenses([updated]))[0]));
});

router.post("/petty-cash/:requestId/evaluate", requirePermission("petty-cash:evaluate"), async (req, res): Promise<void> => {
  const params = EvaluatePettyCashRequestParams.safeParse(req.params);
  const body = EvaluatePettyCashRequestBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Evaluasi tidak valid" }); return; }
  const request = await getRequest(params.data.requestId);
  if (!request) { res.status(404).json({ error: "Permintaan tidak ditemukan" }); return; }
  if (!canAccessProject(req, request.projectId)) { res.status(403).json({ error: "Proyek di luar penugasan" }); return; }
  if (request.status !== "DIREKONSILIASI") { res.status(409).json({ error: "Rekonsiliasi belum selesai" }); return; }
  if ([request.requesterUserId, request.approverUserId, request.disburserUserId, request.verifierUserId, request.reconcilerUserId].includes(req.access!.userId)) {
    res.status(409).json({ error: "Evaluator harus independen dari tahapan sebelumnya" }); return;
  }
  const updated = await db.transaction(async tx => {
    const [row] = await tx.update(pettyCashRequestsTable).set({ status: "DIEVALUASI", evaluatorUserId: req.access!.userId, evaluatorName: req.access!.displayName, evaluationNote: body.data.note, evaluatedAt: new Date() })
      .where(and(eq(pettyCashRequestsTable.id, request.id), eq(pettyCashRequestsTable.status, "DIREKONSILIASI"))).returning();
    if (!row) return null;
    await audit(tx, req, row.id, "DIEVALUASI", body.data.note);
    return row;
  });
  if (!updated) { res.status(409).json({ error: "Status berubah" }); return; }
  res.json(EvaluatePettyCashRequestResponse.parse((await withExpenses([updated]))[0]));
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
  if (request.status !== "DIVERIFIKASI" && !(request.fundId === null && request.status === "DIPERTANGGUNGJAWABKAN")) {
    res.status(409).json({ error: "Pertanggungjawaban belum diverifikasi" }); return;
  }
  if ([request.requesterUserId, request.disburserUserId, request.verifierUserId].includes(req.access!.userId)) {
    res.status(409).json({ error: "Pemohon atau pencair dana tidak boleh merekonsiliasi transaksi yang sama" });
    return;
  }
  const updated = await db.transaction(async (tx) => {
    const [fund] = request.fundId ? await tx.select().from(pettyCashFundsTable).where(eq(pettyCashFundsTable.id, request.fundId)).for("update") : [];
    const bookBalance = request.fundId ? fund?.bookBalance : request.returnedAmount;
    if (bookBalance === undefined || bookBalance === null || body.data.physicalCashAmount !== bookBalance) {
      await audit(tx, req, request.id, "SELISIH_REKONSILIASI",
        `${request.fundId ? "Saldo buku" : "Sisa transaksi lama"} Rp${bookBalance ?? 0} · kas fisik Rp${body.data.physicalCashAmount} · ${body.data.note}`);
      res.status(409).json({ error: `Selisih saldo buku dan kas fisik${bookBalance !== undefined && bookBalance !== null ? `: Rp${bookBalance - body.data.physicalCashAmount}` : ""}` }); return null;
    }
    if (!request.fundId) {
      const pending = await tx.select({ id: pettyCashExceptionsTable.id }).from(pettyCashExceptionsTable)
        .where(and(eq(pettyCashExceptionsTable.requestId, request.id), eq(pettyCashExceptionsTable.status, "OPEN"))).limit(1);
      if (pending.length) { res.status(409).json({ error: "Bukti transaksi lama belum lengkap" }); return null; }
    }
    const [stored] = await tx.update(pettyCashRequestsTable).set({
      status: "DIREKONSILIASI", physicalCashAmount: body.data.physicalCashAmount,
      reconcilerUserId: req.access!.userId, reconcilerName: req.access!.displayName,
      reconciliationNote: body.data.note, reconciledAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(pettyCashRequestsTable.id, request.id), eq(pettyCashRequestsTable.status, request.status))).returning();
    if (!stored) throw new Error("Permintaan berubah saat rekonsiliasi diproses");
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "DIREKONSILIASI", entity: "Kas Kecil", entityId: request.id,
      detail: `${request.projectCode} · ${request.fundId ? "saldo buku" : "sisa transaksi lama"} Rp${bookBalance} · kas fisik Rp${body.data.physicalCashAmount}`, user: req.access!.displayName,
      actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "success",
    });
    return stored;
  });
  if (!updated) return;
  res.json(ReconcilePettyCashRequestResponse.parse((await withExpenses([updated]))[0]));
});

export default router;