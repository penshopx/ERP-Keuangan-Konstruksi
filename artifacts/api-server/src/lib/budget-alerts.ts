import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  actualCostAllocationsTable, auditLogsTable, budgetAlertsTable, budgetAlertThresholdsTable,
  commitmentLinesTable, commitmentTable, db, projectsTable, rabBaselinesTable, rabItemsTable,
} from "@workspace/db";
import { sendOperationalAlert, resolveOperationalAlertConfig } from "@workspace/db/operational-alert";
import { logger } from "./logger";
import { recordOperationalAlertDeliveryStatus } from "./operational-alert-status";

type Access = { role?: string; assignedProjectIds?: string[] };
type AlertType = "PROJECTED_EXPOSURE" | "ESTIMATE_AT_COMPLETION";
export type BudgetMeasures = {
  currentBudget: number; actual: number; remainingCommitment: number;
  estimateToComplete: number; projectedExposure: number; estimateAtCompletion: number;
};

export function calculateBudgetMeasures(currentBudget: number, actual: number, remainingCommitment: number, progress: number): BudgetMeasures {
  const estimateToComplete = Math.max(0, currentBudget * (100 - Math.min(100, Math.max(0, progress))) / 100);
  return { currentBudget, actual, remainingCommitment, estimateToComplete, projectedExposure: actual + remainingCommitment, estimateAtCompletion: actual + remainingCommitment + estimateToComplete };
}
export function determineAlertAction(breached: boolean, hasActiveAlert: boolean, changed: boolean): "CREATE" | "UPDATE" | "RESOLVE" | "NOOP" {
  if (!breached && hasActiveAlert) return "RESOLVE";
  if (!breached) return "NOOP";
  if (!hasActiveAlert) return "CREATE";
  return changed ? "UPDATE" : "NOOP";
}
/** Thresholds are breach limits, not inclusive targets: exactly 90/100% is still within budget. */
export function exceedsThreshold(measure: number, budget: number, thresholdPercent: number): boolean {
  return budget > 0 && measure > budget * thresholdPercent / 100;
}

function jsonChanged(a: unknown, b: unknown) { return JSON.stringify(a) !== JSON.stringify(b); }

async function audit(alertId: string, action: string, detail: string, projectId: string, user = "system") {
  await db.insert(auditLogsTable).values({ id: randomUUID(), action, entity: "BudgetAlert", entityId: alertId, detail, user, actorUserId: user === "system" ? null : user, actorRole: user === "system" ? "SYSTEM" : null, tone: action.includes("GAGAL") ? "warning" : "info", metadata: { projectId } });
}

async function notify(alert: { id: string; projectId: string; detail: string; severity: string }) {
  try {
    const result = await sendOperationalAlert({
      alert: { source: "budget-control", event: "BUDGET_ALERT", severity: alert.severity === "info" ? "info" : "error", message: alert.detail, projectId: alert.projectId, alertId: alert.id },
      config: resolveOperationalAlertConfig(),
      log: logger,
      recordDeliveryStatus: recordOperationalAlertDeliveryStatus,
    });
    if (!result.delivered && result.reason !== "not_configured") await audit(alert.id, "ALERT_DELIVERY_GAGAL", `Pengiriman kanal operasional gagal: ${result.reason}`, alert.projectId);
  } catch (error) {
    logger.error({ err: error, alertId: alert.id }, "Budget alert delivery failed");
    await audit(alert.id, "ALERT_DELIVERY_GAGAL", "Pengiriman kanal operasional gagal", alert.projectId);
  }
}

async function evaluateProject(project: typeof projectsTable.$inferSelect, thresholds: typeof budgetAlertThresholdsTable.$inferSelect[]) {
  const [baseline] = await db.select().from(rabBaselinesTable).where(eq(rabBaselinesTable.projectId, project.id)).orderBy(desc(rabBaselinesTable.version)).limit(1);
  if (!baseline) return [];
  const actualRows = await db.select({ costCodeId: actualCostAllocationsTable.costCodeId, commitmentId: actualCostAllocationsTable.commitmentId, sourceId: actualCostAllocationsTable.sourceId, amount: actualCostAllocationsTable.amount })
    .from(actualCostAllocationsTable).where(eq(actualCostAllocationsTable.projectId, project.id));
  const commitmentRows = await db.select({ costCodeId: commitmentLinesTable.costCodeId, rabItemId: commitmentLinesTable.rabItemId, commitmentId: commitmentTable.id, documentNumber: commitmentTable.documentNumber, amount: sql<number>`${commitmentLinesTable.amount} - ${commitmentLinesTable.invoicedAmount}` })
    .from(commitmentLinesTable).innerJoin(commitmentTable, eq(commitmentTable.id, commitmentLinesTable.commitmentId))
    .where(and(eq(commitmentTable.projectId, project.id), eq(commitmentTable.status, "APPROVED")));
  const actual = actualRows.reduce((sum, row) => sum + Number(row.amount), 0);
  const remainingCommitment = commitmentRows.reduce((sum, row) => sum + Number(row.amount), 0);
  const measures = calculateBudgetMeasures(project.budget, actual, remainingCommitment, project.progress);
  const byCause = new Map<string, { value: number; costCodeId: string; rabItemId: string | null; commitmentId: string | null; documentNumber?: string }>();
  for (const row of [...actualRows.map((r) => ({ ...r, rabItemId: null, documentNumber: undefined, value: Number(r.amount) })), ...commitmentRows.map((r) => ({ ...r, value: Number(r.amount) }))]) {
    const key = `${row.costCodeId}:${row.rabItemId ?? ""}:${row.commitmentId ?? ""}`;
    const current = byCause.get(key);
    byCause.set(key, { value: (current?.value ?? 0) + row.value, costCodeId: row.costCodeId, rabItemId: row.rabItemId ?? null, commitmentId: row.commitmentId ?? null, documentNumber: row.documentNumber });
  }
  const primary = [...byCause.values()].sort((a, b) => b.value - a.value)[0];
  const [primaryItem] = primary?.rabItemId ? await db.select({ code: rabItemsTable.code }).from(rabItemsTable).where(eq(rabItemsTable.id, primary.rabItemId)).limit(1) : [];
  const results = [];
  for (const measure of [
    { type: "PROJECTED_EXPOSURE" as const, value: measures.projectedExposure },
    { type: "ESTIMATE_AT_COMPLETION" as const, value: measures.estimateAtCompletion },
  ]) {
    const threshold = thresholds.filter((item) => item.alertType === measure.type).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const breached = Boolean(threshold && exceedsThreshold(measure.value, project.budget, Number(threshold.thresholdPercent)));
    const active = await db.select().from(budgetAlertsTable).where(and(eq(budgetAlertsTable.projectId, project.id), eq(budgetAlertsTable.baselineId, baseline.id), eq(budgetAlertsTable.alertType, measure.type), inArray(budgetAlertsTable.status, ["OPEN", "ACKNOWLEDGED"]))).limit(1);
    if (!breached) {
      if (active[0]) {
        const [resolved] = await db.update(budgetAlertsTable).set({ status: "RESOLVED", resolvedAt: new Date(), resolvedBy: "system", updatedAt: new Date() }).where(eq(budgetAlertsTable.id, active[0].id)).returning();
        await audit(resolved.id, "ALERT_AUTO_DISELESAIKAN", "Breached anggaran sudah tidak aktif", project.id);
      }
      continue;
    }
    const ratio = measure.value / project.budget * 100;
    const severity = ratio >= 110 ? "critical" : ratio >= 100 ? "warning" : "info";
    const title = measure.type === "PROJECTED_EXPOSURE" ? "Komitmen dan aktual mendekati anggaran" : "Forecast penyelesaian melampaui anggaran";
    const detail = `${project.code}: ${measure.type === "PROJECTED_EXPOSURE" ? "exposure terproyeksi" : "estimate at completion"} ${ratio.toFixed(1)}% dari budget berjalan.`;
    const evidence = { ...measures, thresholdPercent: Number(threshold!.thresholdPercent), baselineId: baseline.id, primaryWbsCode: primaryItem?.code ?? null, primaryCostCodeId: primary?.costCodeId ?? null, primaryCommitmentId: primary?.commitmentId ?? null, primaryDocumentNumber: primary?.documentNumber ?? null, primaryTransactionId: primary?.commitmentId ? null : (actualRows[0]?.sourceId ?? null) };
    if (active[0]) {
      const old = active[0];
      if (old.severity !== severity || old.detail !== detail || jsonChanged(old.evidence, evidence)) {
        const [updated] = await db.update(budgetAlertsTable).set({ severity, detail, evidence, updatedAt: new Date() }).where(eq(budgetAlertsTable.id, old.id)).returning();
        await audit(updated.id, "ALERT_DIPERBARUI", "Nilai exposure atau penyebab berubah", project.id);
        results.push(updated);
      } else results.push(old);
    } else {
      try {
        const [created] = await db.insert(budgetAlertsTable).values({ id: randomUUID(), projectId: project.id, baselineId: baseline.id, alertType: measure.type, severity, owner: threshold!.owner, title, detail, evidence }).returning();
        await audit(created.id, "ALERT_DIBUAT", detail, project.id);
        await notify(created);
        results.push(created);
      } catch (error) {
        // Two evaluators may observe no active row concurrently. The partial
        // unique index makes the loser harmless; return the winner instead.
        const [winner] = await db.select().from(budgetAlertsTable).where(and(eq(budgetAlertsTable.projectId, project.id), eq(budgetAlertsTable.baselineId, baseline.id), eq(budgetAlertsTable.alertType, measure.type), inArray(budgetAlertsTable.status, ["OPEN", "ACKNOWLEDGED"]))).limit(1);
        if (!winner) throw error;
        results.push(winner);
      }
    }
  }
  return results;
}

export async function evaluateBudgetAlerts(projectIds: string[]) {
  if (!projectIds.length) return [];
  const today = new Date().toISOString().slice(0, 10);
  const thresholds = await db.select().from(budgetAlertThresholdsTable).where(sql`${budgetAlertThresholdsTable.effectiveFrom} <= ${today} AND (${budgetAlertThresholdsTable.effectiveTo} IS NULL OR ${budgetAlertThresholdsTable.effectiveTo} >= ${today})`);
  const projects = await db.select().from(projectsTable).where(inArray(projectsTable.id, projectIds));
  return (await Promise.all(projects.map((project) => evaluateProject(project, thresholds)))).flat();
}

export async function listBudgetAlerts(access: Access) {
  const projects = access.role === "PROJECT_MANAGER" ? access.assignedProjectIds ?? [] : (await db.select({ id: projectsTable.id }).from(projectsTable)).map((p) => p.id);
  await evaluateBudgetAlerts(projects);
  return db.select().from(budgetAlertsTable).where(projects.length ? inArray(budgetAlertsTable.projectId, projects) : sql`false`).orderBy(desc(budgetAlertsTable.createdAt));
}