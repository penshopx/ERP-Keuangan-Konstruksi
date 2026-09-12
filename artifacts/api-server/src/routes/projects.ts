import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
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
import { activity, projectDetail, projects, rabItems } from "../lib/demo-data";

const router: IRouter = Router();

router.get("/projects", (req, res) => {
  const parsed = ListProjectsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const search = parsed.data.search?.toLowerCase();
  const data = projects.filter((project) => {
    const statusMatch = !parsed.data.status || project.status === parsed.data.status;
    const searchMatch = !search || [project.code, project.name, project.owner].some((value) => value.toLowerCase().includes(search));
    return statusMatch && searchMatch;
  });
  res.json(ListProjectsResponse.parse(data));
});

router.post("/projects", (req, res) => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const project = {
    id: randomUUID(),
    ...parsed.data,
    budget: 0,
    actualCost: 0,
    progress: 0,
    status: "PERSIAPAN",
    health: "SEHAT",
  };
  projects.unshift(project);
  activity.unshift({
    id: randomUUID(),
    action: "DIBUAT",
    entity: "Proyek",
    detail: `${project.code} · ${project.name}`,
    user: "Admin Demo",
    timestamp: new Date().toISOString(),
    tone: "success",
  });
  res.status(201).json(CreateProjectResponse.parse(project));
});

router.get("/projects/:projectId", (req, res) => {
  const parsed = GetProjectParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const project = projects.find((item) => item.id === parsed.data.projectId);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan" });
    return;
  }
  res.json(GetProjectResponse.parse(projectDetail(project)));
});

router.patch("/projects/:projectId", (req, res) => {
  const params = UpdateProjectParams.safeParse(req.params);
  const body = UpdateProjectBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Data perubahan tidak valid" });
    return;
  }
  const project = projects.find((item) => item.id === params.data.projectId);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan" });
    return;
  }
  Object.assign(project, body.data);
  res.json(UpdateProjectResponse.parse(project));
});

router.get("/projects/:projectId/rab", (req, res) => {
  const parsed = GetProjectRabParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const project = projects.find((item) => item.id === parsed.data.projectId);
  if (!project) {
    res.status(404).json({ error: "Proyek tidak ditemukan" });
    return;
  }
  const items = rabItems.map((item) => ({
    ...item,
    variance: item.budget - item.actual,
    utilization: Number(((item.actual / item.budget) * 100).toFixed(1)),
  }));
  const totalBudget = items.reduce((sum, item) => sum + item.budget, 0);
  const committed = items.reduce((sum, item) => sum + item.committed, 0);
  const actual = items.reduce((sum, item) => sum + item.actual, 0);
  res.json(GetProjectRabResponse.parse({
    projectId: project.id,
    version: 3,
    status: "BASELINE DISETUJUI",
    totalBudget,
    committed,
    actual,
    remaining: totalBudget - actual,
    items,
  }));
});

export default router;