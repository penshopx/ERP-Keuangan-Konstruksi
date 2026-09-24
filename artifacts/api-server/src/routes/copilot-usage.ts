import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { copilotLimitsTable, copilotUsageTable, db } from "@workspace/db";
import type { AiTool } from "./ai-control-plane";

const DEFAULT_ROLE_LIMIT = 100;
export type UsageContext = { role: string; projectId?: string };
export type CopilotAdmission = {
  reserve: (context: UsageContext) => Promise<string | null>;
  finish: (id: string, tool: AiTool | "planning", status: "SUCCESS" | "FAILED" | "TIMEOUT", durationMs: number) => Promise<void>;
};

export const copilotAdmission: CopilotAdmission = {
  async reserve({ role, projectId }) {
    return db.transaction(async (tx) => {
      // One short transaction-wide lock serializes limit edits and reservations across all API instances.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('copilot-daily-limits'))`);
      const day = new Date().toISOString().slice(0, 10);
      const limits = await tx.select().from(copilotLimitsTable);
      const roleLimit = limits.find((row) => row.scope === "role" && row.scopeId === role)?.dailyLimit ?? DEFAULT_ROLE_LIMIT;
      const projectLimit = projectId
        ? limits.find((row) => row.scope === "project" && row.scopeId === projectId)?.dailyLimit
        : undefined;
      const [roleCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(copilotUsageTable)
        .where(and(eq(copilotUsageTable.day, day), eq(copilotUsageTable.role, role)));
      if (roleCount.count >= roleLimit) return null;
      if (projectId && projectLimit !== undefined) {
        const [projectCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(copilotUsageTable)
          .where(and(eq(copilotUsageTable.day, day), eq(copilotUsageTable.projectId, projectId)));
        if (projectCount.count >= projectLimit) return null;
      }
      const id = randomUUID();
      await tx.insert(copilotUsageTable).values({ id, day, role, projectId, tool: "planning", status: "RUNNING" });
      return id;
    });
  },
  async finish(id, tool, status, durationMs) {
    await db.update(copilotUsageTable).set({ tool, status, durationMs })
      .where(eq(copilotUsageTable.id, id));
  },
};

export async function getCopilotUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [limits, rows, todayRows] = await Promise.all([
    db.select().from(copilotLimitsTable),
    db.select({
      tool: copilotUsageTable.tool,
      executions: sql<number>`count(*)::int`,
      failures: sql<number>`count(*) FILTER (WHERE ${copilotUsageTable.status} = 'FAILED')::int`,
      timeouts: sql<number>`count(*) FILTER (WHERE ${copilotUsageTable.status} = 'TIMEOUT')::int`,
      durationMs: sql<number>`coalesce(sum(${copilotUsageTable.durationMs}), 0)::double precision`,
    }).from(copilotUsageTable).where(gte(copilotUsageTable.day, since)).groupBy(copilotUsageTable.tool),
    db.select({
      role: copilotUsageTable.role,
      projectId: copilotUsageTable.projectId,
      count: sql<number>`count(*)::int`,
    }).from(copilotUsageTable).where(eq(copilotUsageTable.day, today))
      .groupBy(copilotUsageTable.role, copilotUsageTable.projectId),
  ]);
  return { today, since, defaultRoleDailyLimit: DEFAULT_ROLE_LIMIT, limits, tools: rows, todayUsage: todayRows };
}

export async function saveCopilotLimit(scope: "role" | "project", scopeId: string, dailyLimit: number) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('copilot-daily-limits'))`);
    await tx.insert(copilotLimitsTable).values({ scope, scopeId, dailyLimit })
      .onConflictDoUpdate({
        target: [copilotLimitsTable.scope, copilotLimitsTable.scopeId],
        set: { dailyLimit, updatedAt: new Date() },
      });
  });
}