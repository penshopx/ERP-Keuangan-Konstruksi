import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  ahsComponentsTable,
  ahsTemplatesTable,
  auditLogsTable,
  competencyCatalogTable,
  db,
  estimatePreviewsTable,
  projectsTable,
  rabBaselinesTable,
  rabEstimateSnapshotsTable,
  rabItemsTable,
  resourcePricesTable,
  userCompetencyProfilesTable,
} from "@workspace/db";
import {
  CreateRabEstimateBaselineBody,
  CreateRabEstimateBaselineParams,
  GetCompetencyProfileParams,
  ListAhsTemplatesQueryParams,
  PreviewRabEstimateBody,
  PreviewRabEstimateParams,
  TransitionRabBaselineBody,
  TransitionRabBaselineParams,
  UpdateCompetencyProfileBody,
  UpdateCompetencyProfileParams,
} from "@workspace/api-zod";
import { canAccessProject, requirePermission, roleHasPermission } from "../middlewares/access";
import { calculateAhsEstimate, MissingEffectivePriceError } from "../lib/estimator-calculation";
import { cloneRabItems } from "../lib/rab-item-cloning";

const router: IRouter = Router();
const ACTIVE_PROJECT_STATUSES = new Set(["PERSIAPAN", "BERJALAN", "TERTUNDA"]);

function dateOrToday(value: string | undefined) {
  return value ?? new Date().toISOString().slice(0, 10);
}

async function activeProject(req: Parameters<typeof canAccessProject>[0], projectId: string) {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  if (!project || !ACTIVE_PROJECT_STATUSES.has(project.status) || !canAccessProject(req, projectId)) return null;
  return project;
}

function templateResponse(template: typeof ahsTemplatesTable.$inferSelect, components: Array<typeof ahsComponentsTable.$inferSelect>) {
  return { ...template, components };
}

router.get("/competencies/catalog", requirePermission("projects:view"), async (_req, res): Promise<void> => {
  const entries = await db.select().from(competencyCatalogTable).orderBy(competencyCatalogTable.schemeCode, competencyCatalogTable.level);
  res.json(entries);
});

router.get("/competencies/profiles/:userId", requirePermission("projects:view"), async (req, res): Promise<void> => {
  const parsed = GetCompetencyProfileParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (req.access?.role !== "DIRECTOR" && req.access?.userId !== parsed.data.userId) {
    res.status(403).json({ error: "Profil kompetensi hanya dapat dibaca oleh pemilik atau Director" });
    return;
  }
  const rows = await db.select({
    profile: userCompetencyProfilesTable,
    catalog: competencyCatalogTable,
  }).from(userCompetencyProfilesTable)
    .innerJoin(competencyCatalogTable, eq(competencyCatalogTable.id, userCompetencyProfilesTable.catalogEntryId))
    .where(eq(userCompetencyProfilesTable.userId, parsed.data.userId));
  res.json(rows.map(({ profile, catalog }) => ({ ...profile, catalog })));
});

router.put("/competencies/profiles/:userId", async (req, res): Promise<void> => {
  const params = UpdateCompetencyProfileParams.safeParse(req.params);
  const body = UpdateCompetencyProfileBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Profil kompetensi tidak valid" });
    return;
  }
  if (req.access?.role !== "DIRECTOR") {
    res.status(403).json({ error: "Hanya Director yang dapat memperbarui profil kompetensi" });
    return;
  }
  const [catalog] = await db.select().from(competencyCatalogTable).where(eq(competencyCatalogTable.id, body.data.catalogEntryId)).limit(1);
  if (!catalog) {
    res.status(404).json({ error: "Entri skema kompetensi tidak ditemukan" });
    return;
  }
  const [profile] = await db.insert(userCompetencyProfilesTable).values({
    id: randomUUID(),
    userId: params.data.userId,
    catalogEntryId: body.data.catalogEntryId,
    verificationStatus: body.data.verificationStatus,
    certificateReference: body.data.certificateReference ?? null,
    effectiveFrom: body.data.effectiveFrom?.toISOString().slice(0, 10) ?? null,
    expiresAt: body.data.expiresAt?.toISOString().slice(0, 10) ?? null,
    verifiedBy: body.data.verificationStatus === "VERIFIED" ? req.access.userId : null,
    verifiedAt: body.data.verificationStatus === "VERIFIED" ? new Date() : null,
  }).onConflictDoUpdate({
    target: [userCompetencyProfilesTable.userId, userCompetencyProfilesTable.catalogEntryId],
    set: {
      verificationStatus: body.data.verificationStatus,
      certificateReference: body.data.certificateReference ?? null,
      effectiveFrom: body.data.effectiveFrom?.toISOString().slice(0, 10) ?? null,
      expiresAt: body.data.expiresAt?.toISOString().slice(0, 10) ?? null,
      verifiedBy: body.data.verificationStatus === "VERIFIED" ? req.access.userId : null,
      verifiedAt: body.data.verificationStatus === "VERIFIED" ? new Date() : null,
    },
  }).returning();
  res.json({ ...profile, catalog });
});

router.get("/ahs/templates", requirePermission("rab:estimate"), async (req, res): Promise<void> => {
  const parsed = ListAhsTemplatesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const effectiveDate = dateOrToday(parsed.data.effectiveDate?.toISOString().slice(0, 10));
  const templates = await db.select().from(ahsTemplatesTable).where(and(
    eq(ahsTemplatesTable.status, "ACTIVE"),
    lte(ahsTemplatesTable.effectiveFrom, effectiveDate),
    or(isNull(ahsTemplatesTable.effectiveTo), gte(ahsTemplatesTable.effectiveTo, effectiveDate)),
  )).orderBy(ahsTemplatesTable.code, desc(ahsTemplatesTable.version));
  const components = await db.select().from(ahsComponentsTable);
  res.json(templates.map((template) => templateResponse(template, components.filter((component) => component.templateId === template.id))));
});

router.post("/projects/:projectId/estimates/preview", requirePermission("rab:estimate"), async (req, res): Promise<void> => {
  const params = PreviewRabEstimateParams.safeParse(req.params);
  const body = PreviewRabEstimateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await activeProject(req, params.data.projectId);
  if (!project) {
    res.status(403).json({ error: "Proyek tidak aktif atau berada di luar penugasan Anda" });
    return;
  }
  const effectiveDate = body.data.effectiveDate.toISOString().slice(0, 10);
  const [template] = await db.select().from(ahsTemplatesTable).where(and(
    eq(ahsTemplatesTable.id, body.data.templateId),
    eq(ahsTemplatesTable.status, "ACTIVE"),
    lte(ahsTemplatesTable.effectiveFrom, effectiveDate),
    or(isNull(ahsTemplatesTable.effectiveTo), gte(ahsTemplatesTable.effectiveTo, effectiveDate)),
  )).limit(1);
  if (!template) {
    res.status(404).json({ error: "Template AHS tidak aktif pada tanggal efektif tersebut" });
    return;
  }
  const components = await db.select().from(ahsComponentsTable).where(eq(ahsComponentsTable.templateId, template.id));
  const prices = await db.select().from(resourcePricesTable).where(and(
    lte(resourcePricesTable.effectiveFrom, effectiveDate),
    or(isNull(resourcePricesTable.effectiveTo), gte(resourcePricesTable.effectiveTo, effectiveDate)),
  ));
  let calculated;
  try {
    calculated = calculateAhsEstimate(components, prices);
  } catch (error) {
    if (error instanceof MissingEffectivePriceError) {
      res.status(422).json({ error: error.message });
      return;
    }
    throw error;
  }
  const { formula, unitPriceRupiah } = calculated;
  const totalBudgetRupiah = Math.round(body.data.volumeBasisPoints * unitPriceRupiah / 100);
  const [preview] = await db.insert(estimatePreviewsTable).values({
    id: randomUUID(), projectId: project.id, templateId: template.id,
    effectiveDate, volumeBasisPoints: body.data.volumeBasisPoints,
    unitPriceRupiah, totalBudgetRupiah, formulaSnapshot: { template, components: formula },
    createdBy: req.access!.userId,
  }).returning();
  res.json(preview);
});

router.post("/projects/:projectId/estimates/baseline", requirePermission("rab:estimate"), async (req, res): Promise<void> => {
  const params = CreateRabEstimateBaselineParams.safeParse(req.params);
  const body = CreateRabEstimateBaselineBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await activeProject(req, params.data.projectId);
  if (!project) {
    res.status(403).json({ error: "Proyek tidak aktif atau berada di luar penugasan Anda" });
    return;
  }
  const [preview] = await db.select().from(estimatePreviewsTable).where(and(eq(estimatePreviewsTable.id, body.data.previewId), eq(estimatePreviewsTable.projectId, project.id))).limit(1);
  if (!preview || preview.status !== "PREVIEW") {
    res.status(409).json({ error: "Preview tidak ditemukan atau sudah digunakan" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${project.id}))`);
    const [latest] = await tx.select().from(rabBaselinesTable).where(eq(rabBaselinesTable.projectId, project.id)).orderBy(desc(rabBaselinesTable.version)).limit(1);
    if (!latest || latest.version !== body.data.expectedLatestVersion) throw new Error("STALE_RAB_VERSION");
    const latestItems = await tx.select().from(rabItemsTable)
      .where(eq(rabItemsTable.baselineId, latest.id))
      .orderBy(rabItemsTable.code);
    const baselineId = randomUUID();
    const version = latest.version + 1;
    await tx.insert(rabBaselinesTable).values({ id: baselineId, projectId: project.id, version, status: "DRAF" });
    const clonedItems = cloneRabItems(latestItems, baselineId, randomUUID);
    const item = {
      id: randomUUID(), baselineId, code: `EST-${preview.id.slice(0, 8)}`, name: "Estimasi AHS",
      category: "ESTIMATOR", parentCode: null, costCodeId: null, level: 1, unit: "ls", quantityBasisPoints: preview.volumeBasisPoints,
      unitPrice: preview.unitPriceRupiah, materialCost: 0, laborCost: 0, equipmentCost: 0,
      budget: preview.totalBudgetRupiah, committed: 0, actual: 0,
    };
    await tx.insert(rabItemsTable).values([...clonedItems, item]);
    await tx.insert(rabEstimateSnapshotsTable).values({
      id: randomUUID(), baselineId, previewId: preview.id, formulaSnapshot: preview.formulaSnapshot, createdBy: req.access!.userId,
    });
    await tx.update(estimatePreviewsTable).set({ status: "USED" }).where(eq(estimatePreviewsTable.id, preview.id));
    const completeItems = [...clonedItems, item];
    const totalBudget = completeItems.reduce((sum, row) => sum + row.budget, 0);
    await tx.update(projectsTable).set({
      budget: totalBudget,
      wbsCount: completeItems.length,
    }).where(eq(projectsTable.id, project.id));
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "RAB DRAFT DIBUAT", entity: "RAB", entityId: baselineId,
      detail: `Estimasi AHS menjadi RAB ${project.code} versi ${version}`, user: req.access!.displayName,
      actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info",
      metadata: { previewId: preview.id, expectedLatestVersion: body.data.expectedLatestVersion },
    });
    return { baselineId, version, items: completeItems };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "STALE_RAB_VERSION") return null;
    throw error;
  });
  if (!result) {
    res.status(409).json({ error: "Versi RAB terbaru sudah berubah. Muat ulang sebelum membuat baseline." });
    return;
  }
  const [baseline] = await db.select().from(rabBaselinesTable).where(eq(rabBaselinesTable.id, result.baselineId)).limit(1);
  const items = result.items;
  const totalBudget = items.reduce((sum, item) => sum + item.budget, 0);
  const committed = items.reduce((sum, item) => sum + item.committed, 0);
  const actual = items.reduce((sum, item) => sum + item.actual, 0);
  res.status(201).json({
    projectId: project.id, baselineId: baseline.id, version: baseline.version, status: baseline.status,
    totalBudget, committed, remainingCommitment: committed, actual,
    availableBudget: totalBudget - committed - actual, remaining: totalBudget - actual,
    items: items.map((item) => ({
      ...item, quantity: item.quantityBasisPoints / 100, remainingCommitment: item.committed,
      availableBudget: item.budget - item.committed - item.actual,
      variance: item.budget - item.committed - item.actual,
      utilization: item.budget === 0 ? 0 : Number((((item.committed + item.actual) / item.budget) * 100).toFixed(1)),
      costCodeId: item.costCodeId ?? null,
    })),
    formulaSnapshot: preview.formulaSnapshot,
  });
});

router.post("/projects/:projectId/rab/transition", async (req, res): Promise<void> => {
  const params = TransitionRabBaselineParams.safeParse(req.params);
  const body = TransitionRabBaselineBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const requiredPermission = body.data.decision === "SUBMIT"
    ? "rab:estimate"
    : body.data.decision === "APPROVE"
      ? "rab:approve"
      : "rab:review";
  if (!req.access || !roleHasPermission(req.access.role, requiredPermission)) {
    res.status(403).json({ error: "Jabatan Anda tidak memiliki hak untuk transisi RAB ini" });
    return;
  }
  const project = await activeProject(req, params.data.projectId);
  if (!project) {
    res.status(403).json({ error: "Proyek tidak aktif atau berada di luar penugasan Anda" });
    return;
  }
  const [baseline] = await db.select().from(rabBaselinesTable).where(and(eq(rabBaselinesTable.id, body.data.baselineId), eq(rabBaselinesTable.projectId, project.id))).limit(1);
  if (!baseline) {
    res.status(404).json({ error: "Baseline RAB tidak ditemukan" });
    return;
  }
  const [snapshot] = await db.select().from(rabEstimateSnapshotsTable).where(eq(rabEstimateSnapshotsTable.baselineId, baseline.id)).limit(1);
  const [creationAudit] = snapshot ? [] : await db.select({ actorUserId: auditLogsTable.actorUserId })
    .from(auditLogsTable)
    .where(and(eq(auditLogsTable.entity, "RAB"), eq(auditLogsTable.entityId, baseline.id)))
    .orderBy(asc(auditLogsTable.timestamp))
    .limit(1);
  if (body.data.decision === "APPROVE" && (snapshot?.createdBy ?? creationAudit?.actorUserId) === req.access!.userId) {
    res.status(409).json({ error: "Pembuat baseline tidak dapat menyetujui baseline sendiri" });
    return;
  }
  const nextStatus = body.data.decision === "SUBMIT" ? "DIAJUKAN" : body.data.decision === "APPROVE" ? "DISETUJUI" : "DITOLAK";
  if ((body.data.decision === "APPROVE" && req.access?.role !== "DIRECTOR" && req.access?.role !== "QUANTITY_SURVEYOR")
    || (body.data.decision === "SUBMIT" && baseline.status !== "DRAF")
    || (body.data.decision === "APPROVE" && baseline.status !== "DIAJUKAN")) {
    res.status(409).json({ error: "Transisi atau kewenangan baseline tidak valid" });
    return;
  }
  const [updated] = await db.transaction(async (tx) => {
    const [row] = await tx.update(rabBaselinesTable).set({ status: nextStatus }).where(and(eq(rabBaselinesTable.id, baseline.id), eq(rabBaselinesTable.status, baseline.status))).returning();
    if (!row) throw new Error("RAB berubah saat transisi");
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: `RAB ${nextStatus}`, entity: "RAB", entityId: baseline.id,
      detail: `${project.code} versi ${baseline.version}${body.data.note ? ` · ${body.data.note}` : ""}`,
      user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role,
      tone: body.data.decision === "REJECT" ? "warning" : "success",
      metadata: { previousStatus: baseline.status, decision: body.data.decision, note: body.data.note ?? null },
    });
    return [row];
  });
  res.json(updated);
});

export default router;