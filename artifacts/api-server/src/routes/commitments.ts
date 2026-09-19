import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  auditLogsTable, commitmentEventsTable, commitmentLinesTable, commitmentTable, actualCostAllocationsTable,
  db, projectCostCodesTable, projectsTable, rabBaselinesTable, rabItemsTable,
} from "@workspace/db";
import {
  CreateProjectCommitmentBody, TransitionProjectCommitmentBody, ListProjectCommitmentsResponse,
  CreateProjectCommitmentResponse, TransitionProjectCommitmentResponse,
} from "@workspace/api-zod";
import { canAccessProject, requirePermission } from "../middlewares/access";

const router: IRouter = Router();

async function findProject(projectId: string, req: Request, res: Response) {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  if (!project) { res.status(404).json({ error: "Proyek tidak ditemukan" }); return undefined; }
  if (!canAccessProject(req, projectId)) { res.status(403).json({ error: "Proyek berada di luar penugasan Anda" }); return undefined; }
  return project;
}
async function commitmentResponse(commitment: typeof commitmentTable.$inferSelect) {
  const lines = await db.select().from(commitmentLinesTable).where(eq(commitmentLinesTable.commitmentId, commitment.id)).orderBy(asc(commitmentLinesTable.createdAt));
  return { ...commitment, lines };
}

router.get("/projects/:projectId/commitments", requirePermission("commitments:view"), async (req, res): Promise<void> => {
  const projectId = String(req.params.projectId);
  if (!await findProject(projectId, req, res)) return;
  const rows = await db.select().from(commitmentTable).where(eq(commitmentTable.projectId, projectId)).orderBy(desc(commitmentTable.createdAt));
  res.json(ListProjectCommitmentsResponse.parse(await Promise.all(rows.map(commitmentResponse))));
});

router.post("/projects/:projectId/commitments", requirePermission("commitments:write"), async (req, res): Promise<void> => {
  const parsed = CreateProjectCommitmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const projectId = String(req.params.projectId);
  const project = await findProject(projectId, req, res); if (!project) return;
  const [baseline] = await db.select().from(rabBaselinesTable).where(and(eq(rabBaselinesTable.id, parsed.data.baselineId), eq(rabBaselinesTable.projectId, project.id))).limit(1);
  if (!baseline) { res.status(400).json({ error: "Baseline RAB bukan milik proyek" }); return; }
  const id = randomUUID();
  const totalAmount = parsed.data.lines.reduce((sum, line) => sum + line.amount, 0);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${project.id}))`);
      const validCodes = await tx.select({ id: projectCostCodesTable.id }).from(projectCostCodesTable)
        .where(eq(projectCostCodesTable.projectId, project.id));
      const validCodeIds = new Set(validCodes.map(({ id: costCodeId }) => costCodeId));
      const baselineItems = await tx.select({
        id: rabItemsTable.id,
        costCodeId: rabItemsTable.costCodeId,
      }).from(rabItemsTable).where(eq(rabItemsTable.baselineId, baseline.id));
      const baselineItemsById = new Map(baselineItems.map((item) => [item.id, item]));
      for (const line of parsed.data.lines) {
        if (!validCodeIds.has(line.costCodeId)) {
          throw Object.assign(new Error("Cost code bukan milik proyek"), { status: 400 });
        }
        if (line.rabItemId) {
          const item = baselineItemsById.get(line.rabItemId);
          if (!item || item.costCodeId !== line.costCodeId) {
            throw Object.assign(new Error("Item RAB tidak sesuai baseline atau cost code"), { status: 400 });
          }
        }
      }
      await tx.insert(commitmentTable).values({ id, projectId: project.id, baselineId: baseline.id, documentType: parsed.data.documentType, documentNumber: parsed.data.documentNumber, vendorName: parsed.data.vendorName, totalAmount, createdBy: req.access!.userId });
      await tx.insert(commitmentLinesTable).values(parsed.data.lines.map((line) => ({ id: randomUUID(), commitmentId: id, costCodeId: line.costCodeId, rabItemId: line.rabItemId ?? null, description: line.description, amount: line.amount })));
      await tx.insert(commitmentEventsTable).values({ id: randomUUID(), commitmentId: id, eventType: "CREATED", actorUserId: req.access!.userId, amount: totalAmount });
      await tx.insert(auditLogsTable).values({ id: randomUUID(), action: "DIBUAT", entity: "Commitment", entityId: id, detail: `${parsed.data.documentType} ${parsed.data.documentNumber}`, user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info", metadata: { projectId: project.id, totalAmount } });
    });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Komitmen gagal dibuat" });
    return;
  }
  res.status(201).json(CreateProjectCommitmentResponse.parse(await commitmentResponse((await db.select().from(commitmentTable).where(eq(commitmentTable.id, id)))[0])));
});

router.post("/projects/:projectId/commitments/:commitmentId/transition", requirePermission("commitments:write"), async (req, res): Promise<void> => {
  const parsed = TransitionProjectCommitmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const projectId = String(req.params.projectId);
  const project = await findProject(projectId, req, res); if (!project) return;
  const action = parsed.data.action;
  if (["APPROVE", "REJECT", "AMEND"].includes(action) && !req.access?.permissions.includes("commitments:approve")) {
    res.status(403).json({ error: "Jabatan Anda tidak memiliki hak approval komitmen" });
    return;
  }
  if (["RECEIVE", "INVOICE"].includes(action) && !req.access?.permissions.includes("commitments:post")) {
    res.status(403).json({ error: "Jabatan Anda tidak memiliki hak posting komitmen" });
    return;
  }
  let result: typeof commitmentTable.$inferSelect | undefined;
  try {
    await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${req.params.commitmentId}))`);
    const [current] = await tx.select().from(commitmentTable).where(and(eq(commitmentTable.id, String(req.params.commitmentId)), eq(commitmentTable.projectId, project.id))).limit(1);
    if (!current) throw Object.assign(new Error("Komitmen tidak ditemukan"), { status: 404 });
    const isFinancialAction = action === "RECEIVE" || action === "INVOICE";
    if (isFinancialAction && !parsed.data.idempotencyKey) {
      throw Object.assign(new Error("idempotencyKey wajib diisi untuk penerimaan atau invoice"), { status: 400 });
    }
    const sourceId = parsed.data.idempotencyKey ?? `${action}:${parsed.data.lineId ?? "commitment"}:${parsed.data.amount ?? current.totalAmount}`;
    const [existingEvent] = await tx.select().from(commitmentEventsTable).where(and(
      eq(commitmentEventsTable.commitmentId, current.id),
      eq(commitmentEventsTable.eventType, action),
      eq(commitmentEventsTable.sourceId, sourceId),
    )).limit(1);
    if (existingEvent) {
      [result] = await tx.select().from(commitmentTable).where(eq(commitmentTable.id, current.id)).limit(1);
      return;
    }
    const allowed: Record<string, string[]> = { SUBMIT: ["DRAFT"], APPROVE: ["PENDING_APPROVAL"], REJECT: ["PENDING_APPROVAL"], CANCEL: ["DRAFT", "PENDING_APPROVAL", "APPROVED"], RECEIVE: ["APPROVED"], INVOICE: ["APPROVED"], AMEND: ["APPROVED"] };
    if (!allowed[action]?.includes(current.status)) throw Object.assign(new Error("Transisi status komitmen tidak valid"), { status: 409 });
    if (action === "APPROVE" && current.createdBy === req.access!.userId) throw Object.assign(new Error("Pembuat komitmen tidak dapat menyetujui sendiri"), { status: 403 });
    if (action === "CANCEL" && current.status === "APPROVED" && !req.access!.permissions.includes("commitments:approve")) {
      throw Object.assign(new Error("Komitmen yang disetujui hanya dapat dibatalkan oleh approver"), { status: 403 });
    }
    let status = action === "SUBMIT" ? "PENDING_APPROVAL" : action === "APPROVE" ? "APPROVED" : action === "REJECT" ? "REJECTED" : action === "CANCEL" ? "CANCELLED" : current.status;
    const amount = parsed.data.amount ?? current.totalAmount;
    if ((action === "RECEIVE" || action === "INVOICE") && (amount <= 0 || amount > current.totalAmount)) throw Object.assign(new Error("Nilai penerimaan tidak valid"), { status: 400 });
    if (action === "AMEND") {
      const existingLines = await tx.select().from(commitmentLinesTable).where(eq(commitmentLinesTable.commitmentId, current.id));
      if (existingLines.some((line) => line.receivedAmount > 0 || line.invoicedAmount > 0)) {
        throw Object.assign(new Error("Komitmen yang sudah diterima atau diinvoicing tidak dapat diamend"), { status: 409 });
      }
      if (!parsed.data.lines?.length) throw Object.assign(new Error("Amendment wajib menyertakan baris biaya baru"), { status: 400 });
      const validCodes = await tx.select({ id: projectCostCodesTable.id }).from(projectCostCodesTable)
        .where(eq(projectCostCodesTable.projectId, current.projectId));
      const validCodeIds = new Set(validCodes.map(({ id }) => id));
      const baselineItems = await tx.select({
        id: rabItemsTable.id,
        costCodeId: rabItemsTable.costCodeId,
      }).from(rabItemsTable).where(eq(rabItemsTable.baselineId, current.baselineId));
      const baselineItemsById = new Map(baselineItems.map((item) => [item.id, item]));
      for (const line of parsed.data.lines) {
        if (!validCodeIds.has(line.costCodeId)) {
          throw Object.assign(new Error("Cost code amendemen bukan milik proyek"), { status: 400 });
        }
        if (line.rabItemId) {
          const item = baselineItemsById.get(line.rabItemId);
          if (!item || item.costCodeId !== line.costCodeId) {
            throw Object.assign(new Error("Item RAB amendemen tidak sesuai baseline atau cost code"), { status: 400 });
          }
        }
      }
      const [{ postedCount }] = await tx.select({
        postedCount: sql<number>`count(*)`,
      }).from(commitmentLinesTable).where(and(
        eq(commitmentLinesTable.commitmentId, current.id),
        sql`${commitmentLinesTable.receivedAmount} > 0 OR ${commitmentLinesTable.invoicedAmount} > 0`,
      ));
      if (Number(postedCount) > 0) {
        throw Object.assign(new Error("Komitmen yang sudah memiliki penerimaan atau invoice harus dibatalkan dan dibuat ulang"), { status: 409 });
      }
      const nextId = randomUUID();
      const total = parsed.data.lines.reduce((sum, line) => sum + line.amount, 0);
      await tx.insert(commitmentTable).values({ ...current, id: nextId, status: "DRAFT", version: current.version + 1, totalAmount: total, createdBy: req.access!.userId, approvedBy: null, approvedAt: null, createdAt: new Date(), updatedAt: new Date() });
      await tx.insert(commitmentLinesTable).values(parsed.data.lines.map((line) => ({ id: randomUUID(), commitmentId: nextId, costCodeId: line.costCodeId, rabItemId: line.rabItemId ?? null, description: line.description, amount: line.amount })));
      await tx.update(commitmentTable).set({ status: "CLOSED" }).where(eq(commitmentTable.id, current.id));
      await tx.insert(commitmentEventsTable).values({ id: randomUUID(), commitmentId: current.id, eventType: "AMENDED", actorUserId: req.access!.userId, amount: total, sourceId });
      await tx.insert(commitmentEventsTable).values({ id: randomUUID(), commitmentId: nextId, eventType: "CREATED", actorUserId: req.access!.userId, amount: total, sourceId });
      [result] = await tx.select().from(commitmentTable).where(eq(commitmentTable.id, nextId)).limit(1);
      return;
    }
    const lineId = parsed.data.lineId;
    if (isFinancialAction && !lineId) throw Object.assign(new Error("lineId wajib diisi untuk penerimaan atau invoice"), { status: 400 });
    const [targetLine] = lineId ? await tx.select().from(commitmentLinesTable).where(and(eq(commitmentLinesTable.id, lineId), eq(commitmentLinesTable.commitmentId, current.id))).limit(1) : [];
    if (isFinancialAction && !targetLine) throw Object.assign(new Error("Baris komitmen tidak ditemukan"), { status: 400 });
    if (targetLine && action === "RECEIVE" && targetLine.receivedAmount + amount > targetLine.amount) throw Object.assign(new Error("Penerimaan kumulatif melebihi nilai baris"), { status: 400 });
    if (targetLine && action === "INVOICE" && targetLine.invoicedAmount + amount > targetLine.amount) throw Object.assign(new Error("Invoice kumulatif melebihi nilai baris"), { status: 400 });
    if (action === "RECEIVE" || action === "INVOICE") {
      const [line] = targetLine ? [targetLine] : [];
      if (!line) throw Object.assign(new Error("Komitmen tidak memiliki baris biaya"), { status: 400 });
      await tx.update(commitmentLinesTable).set({
        receivedAmount: action === "RECEIVE" ? line.receivedAmount + amount : line.receivedAmount,
        invoicedAmount: action === "INVOICE" ? line.invoicedAmount + amount : line.invoicedAmount,
      }).where(eq(commitmentLinesTable.id, line.id));
      if (action === "INVOICE") {
        await tx.insert(actualCostAllocationsTable).values({
          id: randomUUID(), projectId: project.id, baselineId: current.baselineId, costCodeId: line.costCodeId,
          commitmentId: current.id, sourceType: "COMMITMENT_INVOICE", sourceId: `${current.id}:${sourceId}`, amount,
        }).onConflictDoNothing();
      }
    }
    if (action === "INVOICE") {
      const [remaining] = await tx.select({
        amount: sql<number>`coalesce(sum(${commitmentLinesTable.amount} - ${commitmentLinesTable.invoicedAmount}), 0)`,
      }).from(commitmentLinesTable).where(eq(commitmentLinesTable.commitmentId, current.id));
      if (Number(remaining.amount) === 0) status = "CLOSED";
    }
    [result] = await tx.update(commitmentTable).set({ status, approvedBy: action === "APPROVE" ? req.access!.userId : current.approvedBy, approvedAt: action === "APPROVE" ? new Date() : current.approvedAt }).where(eq(commitmentTable.id, current.id)).returning();
    await tx.insert(commitmentEventsTable).values({ id: randomUUID(), commitmentId: current.id, eventType: action, actorUserId: req.access!.userId, amount, sourceId, metadata: JSON.stringify({ note: parsed.data.note }) });
    await tx.insert(auditLogsTable).values({ id: randomUUID(), action, entity: "Commitment", entityId: current.id, detail: `${current.documentNumber}: ${current.status} → ${status}`, user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info", metadata: { amount, projectId: project.id } });
    });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Transisi komitmen gagal" });
    return;
  }
  res.json(TransitionProjectCommitmentResponse.parse(await commitmentResponse(result!)));
});

export default router;