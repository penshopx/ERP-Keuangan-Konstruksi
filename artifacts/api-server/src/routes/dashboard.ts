import { Router, type IRouter, type Request, type Response } from "express";
import { GetDashboardSummaryResponse, ListBudgetAlertsResponse, AcknowledgeBudgetAlertResponse, ResolveBudgetAlertResponse } from "@workspace/api-zod";
import { actualCostAllocationsTable, auditLogsTable, budgetAlertsTable, commitmentLinesTable, commitmentTable, db, projectsTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requirePermission } from "../middlewares/access";
import { evaluateBudgetAlerts, listBudgetAlerts } from "../lib/budget-alerts";
import { randomUUID } from "node:crypto";

const router: IRouter = Router();

router.get("/dashboard/summary", requirePermission("projects:view"), async (req, res) => {
  const projects = await db.select().from(projectsTable).where(
    req.access?.role === "PROJECT_MANAGER"
      ? inArray(projectsTable.id, req.access.assignedProjectIds)
      : undefined,
  );
  const portfolioValue = projects.reduce((sum, item) => sum + item.contractValue, 0);
  const projectIds = projects.map((p) => p.id);
  const evaluatedAlerts = await evaluateBudgetAlerts(projectIds);
  const committedRows = projectIds.length ? await db.select({ total: sql<number>`coalesce(sum(${commitmentLinesTable.amount} - ${commitmentLinesTable.invoicedAmount}), 0)` }).from(commitmentLinesTable).innerJoin(commitmentTable, eq(commitmentTable.id, commitmentLinesTable.commitmentId)).where(and(inArray(commitmentTable.projectId, projectIds), eq(commitmentTable.status, "APPROVED"))) : [];
  const actualRows = projectIds.length ? await db.select({ total: sql<number>`coalesce(sum(${actualCostAllocationsTable.amount}), 0)` }).from(actualCostAllocationsTable).where(inArray(actualCostAllocationsTable.projectId, projectIds)) : [];
  const committedCost = Number(committedRows[0]?.total ?? 0) + Number(actualRows[0]?.total ?? 0);
  const totalBudget = projects.reduce((sum, item) => sum + item.budget, 0);
  const budgetUtilization = totalBudget ? (committedCost / totalBudget) * 100 : 0;
  const data = {
    activeProjects: projects.filter((item) => item.status === "BERJALAN").length,
    portfolioValue,
    committedCost,
    cashPosition: 8_420_000_000,
    budgetUtilization,
    alerts: evaluatedAlerts.map((alert) => {
      const evidence = alert.evidence as Record<string, unknown>;
      const params = new URLSearchParams({ alertId: alert.id });
      if (typeof evidence.primaryWbsCode === "string") params.set("wbs", evidence.primaryWbsCode);
      if (typeof evidence.primaryCostCodeId === "string") params.set("costCode", evidence.primaryCostCodeId);
      if (typeof evidence.primaryCommitmentId === "string") params.set("commitmentId", evidence.primaryCommitmentId);
      return { ...alert, action: `/portal/projects/${alert.projectId}/rab?${params.toString()}` };
    }),
    cashflow: [
      { month: "Apr", inflow: 7.8e9, outflow: 6.4e9, net: 1.4e9 },
      { month: "Mei", inflow: 5.2e9, outflow: 7.1e9, net: -1.9e9 },
      { month: "Jun", inflow: 8.9e9, outflow: 7.6e9, net: 1.3e9 },
      { month: "Jul", inflow: 6.4e9, outflow: 8.2e9, net: -1.8e9 },
      { month: "Agu", inflow: 10.7e9, outflow: 8.5e9, net: 2.2e9 },
      { month: "Sep", inflow: 9.2e9, outflow: 8.8e9, net: 0.4e9 },
      { month: "Okt", inflow: 7.4e9, outflow: 9.8e9, net: -2.4e9 },
    ],
  };
  res.json(GetDashboardSummaryResponse.parse(data));
});

router.get("/budget-alerts", requirePermission("projects:view"), async (req, res): Promise<void> => {
  const alerts = await listBudgetAlerts(req.access ?? {});
  const enriched = await Promise.all(alerts.map(async (alert) => ({
    ...alert,
    auditHistory: await db.select({ action: auditLogsTable.action, detail: auditLogsTable.detail, user: auditLogsTable.user, timestamp: auditLogsTable.timestamp }).from(auditLogsTable).where(eq(auditLogsTable.entityId, alert.id)),
  })));
  res.json(ListBudgetAlertsResponse.parse(enriched));
});

async function updateAlert(req: Request, res: Response, status: "ACKNOWLEDGED" | "RESOLVED"): Promise<void> {
  const [alert] = await db.select().from(budgetAlertsTable).where(eq(budgetAlertsTable.id, String(req.params.alertId))).limit(1);
  if (!alert) { res.status(404).json({ error: "Peringatan anggaran tidak ditemukan" }); return; }
  if (req.access?.role === "PROJECT_MANAGER" && !req.access.assignedProjectIds.includes(alert.projectId)) { res.status(403).json({ error: "Proyek berada di luar penugasan Anda" }); return; }
  if (req.access?.role !== "DIRECTOR" && (req.access?.role !== alert.owner || !req.access?.permissions.includes("budget-alerts:manage"))) { res.status(403).json({ error: "Anda bukan pemilik peringatan anggaran" }); return; }
  if (alert.status === status) {
    const history = await db.select({ action: auditLogsTable.action, detail: auditLogsTable.detail, user: auditLogsTable.user, timestamp: auditLogsTable.timestamp }).from(auditLogsTable).where(eq(auditLogsTable.entityId, alert.id));
    res.json(status === "ACKNOWLEDGED" ? AcknowledgeBudgetAlertResponse.parse({ ...alert, auditHistory: history }) : ResolveBudgetAlertResponse.parse({ ...alert, auditHistory: history }));
    return;
  }
  if (status === "ACKNOWLEDGED" && alert.status !== "OPEN") { res.status(409).json({ error: "Peringatan hanya dapat diakui dari status OPEN" }); return; }
  if (status === "RESOLVED" && !["OPEN", "ACKNOWLEDGED"].includes(alert.status)) { res.status(409).json({ error: "Peringatan sudah diselesaikan" }); return; }
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [next] = await tx.update(budgetAlertsTable).set(status === "ACKNOWLEDGED" ? { status, acknowledgedAt: now, acknowledgedBy: req.access!.userId } : { status, resolvedAt: now, resolvedBy: req.access!.userId }).where(eq(budgetAlertsTable.id, alert.id)).returning();
    await tx.insert(auditLogsTable).values({ id: randomUUID(), action: status === "ACKNOWLEDGED" ? "ALERT_DIAKUI" : "ALERT_DISELESAIKAN", entity: "BudgetAlert", entityId: alert.id, detail: next.detail, user: req.access!.displayName, actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info", metadata: { projectId: alert.projectId } });
    return next;
  });
  const auditHistory = await db.select({ action: auditLogsTable.action, detail: auditLogsTable.detail, user: auditLogsTable.user, timestamp: auditLogsTable.timestamp }).from(auditLogsTable).where(eq(auditLogsTable.entityId, alert.id));
  res.json(status === "ACKNOWLEDGED" ? AcknowledgeBudgetAlertResponse.parse({ ...updated, auditHistory }) : ResolveBudgetAlertResponse.parse({ ...updated, auditHistory }));
}
router.post("/budget-alerts/:alertId/acknowledge", requirePermission("budget-alerts:manage"), (req, res) => updateAlert(req, res, "ACKNOWLEDGED"));
router.post("/budget-alerts/:alertId/resolve", requirePermission("budget-alerts:manage"), (req, res) => updateAlert(req, res, "RESOLVED"));

export default router;