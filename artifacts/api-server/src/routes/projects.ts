import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invoicesTable,
  projectsTable,
  rabBaselinesTable,
  rabItemsTable,
} from "@workspace/db";
import {
  CreateProjectBody,
  CreateProjectResponse,
  GetProjectParams,
  GetProjectRabParams,
  GetProjectRabResponse,
  GetProjectResponse,
  ListProjectsQueryParams,
  ListProjectsResponse,
  UpdateProjectBody,
  UpdateProjectParams,
  UpdateProjectResponse,
} from "@workspace/api-zod";
import { canAccessProject, requirePermission } from "../middlewares/access";
const router: IRouter = Router();

function projectResponse(project: typeof projectsTable.$inferSelect) {
  const { wbsCount: _wbsCount, spiBasisPoints: _spi, cpiBasisPoints: _cpi, createdAt: _created, updatedAt: _updated, ...response } = project;
  return response;
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
    await tx.insert(rabBaselinesTable).values({
      id: randomUUID(),
      projectId,
      version: 1,
      status: "DRAF",
    });
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
  const storedItems = await db.select().from(rabItemsTable)
    .where(eq(rabItemsTable.baselineId, baseline.id))
    .orderBy(rabItemsTable.code);
  const items = storedItems.map((item) => ({
    ...item,
    variance: item.budget - item.actual,
    utilization: Number(((item.actual / item.budget) * 100).toFixed(1)),
  }));
  const totalBudget = items.reduce((sum, item) => sum + item.budget, 0);
  const committed = items.reduce((sum, item) => sum + item.committed, 0);
  const actual = items.reduce((sum, item) => sum + item.actual, 0);
  res.json(GetProjectRabResponse.parse({
    projectId: project.id,
    version: baseline.version,
    status: baseline.status,
    totalBudget,
    committed,
    actual,
    remaining: totalBudget - actual,
    items,
  }));
});

export default router;