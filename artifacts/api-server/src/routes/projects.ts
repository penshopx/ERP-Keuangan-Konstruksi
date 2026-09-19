import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, max, or, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invoicesTable,
  projectsTable,
  rabBaselinesTable,
  rabItemsTable,
  rabTemplatesTable,
} from "@workspace/db";
import {
  CreateProjectBody,
  CreateProjectResponse,
  GetProjectParams,
  GetProjectRabParams,
  GetProjectRabResponse,
  GetProjectRabVersionParams,
  GetProjectRabVersionResponse,
  GetProjectResponse,
  ImportProjectRabTemplateBody,
  ImportProjectRabTemplateResponse,
  ListProjectRabVersionsParams,
  ListProjectRabVersionsResponse,
  ListProjectsQueryParams,
  ListProjectsResponse,
  UpdateProjectBody,
  UpdateProjectParams,
  UpdateProjectResponse,
} from "@workspace/api-zod";
import { canAccessProject, requirePermission } from "../middlewares/access";
import { getRabImportLockTimeoutMs } from "../lib/rab-import-config";

export type ProjectPersistenceHooks = {
  beforeBaselineInsert?: (projectId: string) => Promise<void>;
  beforeAuditInsert?: (projectId: string) => Promise<void>;
  beforeUpdateAuditInsert?: (projectId: string) => Promise<void>;
  beforeRabImportVersionLock?: (projectId: string, baselineId: string) => Promise<void>;
  beforeRabImportAuditInsert?: (projectId: string, baselineId: string, version: number) => Promise<void>;
  rabImportLockTimeoutMs?: number;
};

const configuredRabImportLockTimeoutMs = getRabImportLockTimeoutMs(process.env);

function isLockTimeout(error: unknown): boolean {
  let current = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && current.code === "55P03") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export function createProjectsRouter(hooks: ProjectPersistenceHooks = {}): IRouter {
const router: IRouter = Router();

function projectResponse(project: typeof projectsTable.$inferSelect) {
  const { wbsCount: _wbsCount, spiBasisPoints: _spi, cpiBasisPoints: _cpi, createdAt: _created, updatedAt: _updated, ...response } = project;
  return response;
}

async function rabSummary(projectId: string, baseline: typeof rabBaselinesTable.$inferSelect) {
  const storedItems = await db.select().from(rabItemsTable)
    .where(eq(rabItemsTable.baselineId, baseline.id))
    .orderBy(rabItemsTable.code);
  const items = storedItems.map((item) => ({
    ...item,
    quantity: item.quantityBasisPoints / 100,
    variance: item.budget - item.actual,
    utilization: item.budget === 0 ? 0 : Number(((item.actual / item.budget) * 100).toFixed(1)),
  }));
  const totalBudget = items.reduce((sum, item) => sum + item.budget, 0);
  const committed = items.reduce((sum, item) => sum + item.committed, 0);
  const actual = items.reduce((sum, item) => sum + item.actual, 0);
  return {
    projectId,
    version: baseline.version,
    status: baseline.status,
    totalBudget,
    committed,
    actual,
    remaining: totalBudget - actual,
    items,
  };
}

router.get("/projects", requirePermission("projects:view"), async (req, res) => {
  const parsed = ListProjectsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [];
  if (req.access?.role === "PROJECT_MANAGER") {
    if (req.access.assignedProjectIds.length === 0) {
      res.json(ListProjectsResponse.parse([]));
      return;
    }
    filters.push(or(...req.access.assignedProjectIds.map((id) => eq(projectsTable.id, id)))!);
  }
  if (parsed.data.status) filters.push(eq(projectsTable.status, parsed.data.status));
  if (parsed.data.search) {
    const searchFilter = or(
      ilike(projectsTable.code, `%${parsed.data.search}%`),
      ilike(projectsTable.name, `%${parsed.data.search}%`),
      ilike(projectsTable.owner, `%${parsed.data.search}%`),
    );
    if (searchFilter) filters.push(searchFilter);
  }
  const data = await db.select().from(projectsTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(projectsTable.createdAt));
  res.json(ListProjectsResponse.parse(data.map(projectResponse)));
});

router.post("/projects", requirePermission("projects:write"), async (req, res) => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!Number.isSafeInteger(parsed.data.contractValue) || parsed.data.contractValue < 0) {
    res.status(400).json({ error: "Nilai kontrak tidak valid" });
    return;
  }
  const projectId = randomUUID();
  const project = {
    id: projectId,
    ...parsed.data,
    budget: 0,
    actualCost: 0,
    progress: 0,
    status: "PERSIAPAN",
    health: "SEHAT",
  };
  await db.transaction(async (tx) => {
    await tx.insert(projectsTable).values(project);
    await hooks.beforeBaselineInsert?.(projectId);
    await tx.insert(rabBaselinesTable).values({
      id: randomUUID(),
      projectId,
      version: 1,
      status: "DRAF",
    });
    await hooks.beforeAuditInsert?.(projectId);
    await tx.insert(auditLogsTable).values({
      id: randomUUID(),
      action: "DIBUAT",
      entity: "Proyek",
      entityId: projectId,
      detail: `${project.code} · ${project.name}`,
      user: req.access!.displayName,
      actorUserId: req.access!.userId,
      actorRole: req.access!.role,
      tone: "success",
    });
  });
  res.status(201).json(CreateProjectResponse.parse(project));
});

router.get("/projects/:projectId", requirePermission("projects:view"), async (req, res) => {
  const parsed = GetProjectParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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
  const recentInvoices = await db.select().from(invoicesTable)
    .where(eq(invoicesTable.projectId, project.id))
    .orderBy(desc(invoicesTable.createdAt));
  const utilization = project.budget === 0 ? 0 : (project.actualCost / project.budget) * 100;
  res.json(GetProjectResponse.parse({
    ...projectResponse(project),
    wbsCount: project.wbsCount,
    budgetUtilization: Number(utilization.toFixed(1)),
    spi: project.spiBasisPoints / 100,
    cpi: project.cpiBasisPoints / 100,
    recentInvoices,
  }));
});

router.patch("/projects/:projectId", requirePermission("projects:write"), async (req, res) => {
  const params = UpdateProjectParams.safeParse(req.params);
  const body = UpdateProjectBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Data perubahan tidak valid" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, params.data.projectId)).limit(1);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan" });
    return;
  }
  if (!canAccessProject(req, project.id)) {
    res.status(403).json({ error: "Proyek berada di luar penugasan Anda" });
    return;
  }
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx.update(projectsTable).set(body.data).where(eq(projectsTable.id, project.id)).returning();
    await hooks.beforeUpdateAuditInsert?.(project.id);
    await tx.insert(auditLogsTable).values({
      id: randomUUID(),
      action: "DIPERBARUI",
      entity: "Proyek",
      entityId: project.id,
      detail: `${project.code} · ${project.name}`,
      user: req.access!.displayName,
      actorUserId: req.access!.userId,
      actorRole: req.access!.role,
      tone: "info",
      metadata: body.data,
    });
    return rows;
  });
  res.json(UpdateProjectResponse.parse(projectResponse(updated)));
});

router.get("/projects/:projectId/rab", requirePermission("projects:view"), async (req, res) => {
  const parsed = GetProjectRabParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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
  const [baseline] = await db.select().from(rabBaselinesTable)
    .where(eq(rabBaselinesTable.projectId, project.id))
    .orderBy(desc(rabBaselinesTable.version))
    .limit(1);
  if (!baseline) {
    res.status(404).json({ error: "Baseline RAB tidak ditemukan" });
    return;
  }
  res.json(GetProjectRabResponse.parse(await rabSummary(project.id, baseline)));
});

router.get("/projects/:projectId/rab/versions", requirePermission("projects:view"), async (req, res) => {
  const parsed = ListProjectRabVersionsParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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
  const baselines = await db.select({
    version: rabBaselinesTable.version,
    status: rabBaselinesTable.status,
    createdAt: rabBaselinesTable.createdAt,
    updatedAt: rabBaselinesTable.updatedAt,
  }).from(rabBaselinesTable)
    .where(eq(rabBaselinesTable.projectId, project.id))
    .orderBy(desc(rabBaselinesTable.version));
  res.json(ListProjectRabVersionsResponse.parse(baselines));
});

router.get("/projects/:projectId/rab/versions/:version", requirePermission("projects:view"), async (req, res) => {
  const parsed = GetProjectRabVersionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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
  const [baseline] = await db.select().from(rabBaselinesTable)
    .where(and(
      eq(rabBaselinesTable.projectId, project.id),
      eq(rabBaselinesTable.version, parsed.data.version),
    ))
    .limit(1);
  if (!baseline) {
    res.status(404).json({ error: "Versi RAB tidak ditemukan" });
    return;
  }
  res.json(GetProjectRabVersionResponse.parse(await rabSummary(project.id, baseline)));
});

router.post("/projects/:projectId/rab/import", requirePermission("projects:write"), async (req, res) => {
  const params = GetProjectRabParams.safeParse(req.params);
  const body = ImportProjectRabTemplateBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Pilihan template atau faktor harga tidak valid" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, params.data.projectId)).limit(1);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan" });
    return;
  }
  if (!canAccessProject(req, project.id)) {
    res.status(403).json({ error: "Proyek berada di luar penugasan Anda" });
    return;
  }
  const [template] = await db.select().from(rabTemplatesTable).where(eq(rabTemplatesTable.id, body.data.templateId)).limit(1);
  if (!template) {
    res.status(404).json({ error: "Template RAB tidak ditemukan" });
    return;
  }
  const baselineId = randomUUID();
  const factor = body.data.priceFactor;
  const importedItems = template.items.map((item) => {
    const unitPrice = Math.round(item.unitPrice * factor);
    return {
      id: randomUUID(),
      baselineId,
      code: item.code,
      name: item.name,
      category: item.category,
      parentCode: item.parentCode ?? null,
      level: item.level,
      unit: item.unit,
      quantityBasisPoints: Math.round(item.quantity * 100),
      unitPrice,
      materialCost: Math.round(item.materialCost * factor),
      laborCost: Math.round(item.laborCost * factor),
      equipmentCost: Math.round(item.equipmentCost * factor),
      budget: Math.round(item.quantity * unitPrice),
      committed: 0,
      actual: 0,
    };
  });
  const totalBudget = importedItems.reduce((sum, item) => sum + item.budget, 0);
  let version: number;
  try {
    version = await db.transaction(async (tx) => {
      const lockTimeoutMs = hooks.rabImportLockTimeoutMs ?? configuredRabImportLockTimeoutMs;
      await tx.execute(sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`);
      await hooks.beforeRabImportVersionLock?.(project.id, baselineId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${project.id}))`);
      const [{ nextVersion }] = await tx.select({
        nextVersion: max(rabBaselinesTable.version),
      }).from(rabBaselinesTable).where(eq(rabBaselinesTable.projectId, project.id));
      const lockedVersion = (nextVersion ?? 0) + 1;
      await tx.insert(rabBaselinesTable).values({ id: baselineId, projectId: project.id, version: lockedVersion, status: "DRAF" });
      await tx.insert(rabItemsTable).values(importedItems);
      await tx.update(projectsTable).set({ budget: totalBudget, wbsCount: importedItems.length }).where(eq(projectsTable.id, project.id));
      await hooks.beforeRabImportAuditInsert?.(project.id, baselineId, lockedVersion);
      await tx.insert(auditLogsTable).values({
        id: randomUUID(),
        action: "DIIMPOR",
        entity: "RAB",
        entityId: baselineId,
        detail: `${template.name} menjadi RAB ${project.code} versi ${lockedVersion}`,
        user: req.access!.displayName,
        actorUserId: req.access!.userId,
        actorRole: req.access!.role,
        tone: "info",
        metadata: { templateId: template.id, priceFactor: factor, itemCount: importedItems.length },
      });
      return lockedVersion;
    });
  } catch (error) {
    if (isLockTimeout(error)) {
      res.status(503).json({
        error: "Impor RAB sedang diproses oleh transaksi lain. Coba lagi beberapa saat.",
        retryable: true,
      });
      return;
    }
    throw error;
  }
  const responseItems = importedItems.map((item) => ({
    ...item,
    quantity: item.quantityBasisPoints / 100,
    variance: item.budget,
    utilization: 0,
  }));
  res.status(201).json(ImportProjectRabTemplateResponse.parse({
    projectId: project.id,
    version,
    status: "DRAF",
    totalBudget,
    committed: 0,
    actual: 0,
    remaining: totalBudget,
    items: responseItems,
  }));
});

return router;
}

export default createProjectsRouter();