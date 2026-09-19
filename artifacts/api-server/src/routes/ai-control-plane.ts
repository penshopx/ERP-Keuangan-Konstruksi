import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invoicesTable,
  projectsTable,
  rabBaselinesTable,
  taxRuleVersionsTable,
} from "@workspace/db";
import { canAccessProject } from "../middlewares/access";

/**
 * The copilot deliberately has a closed set of capabilities. Do not add a
 * generic query or command tool here: this is the control-plane boundary.
 */
export const AI_TOOLS = [
  "portfolio_summary",
  "project_context",
  "rab_versions",
  "invoices",
  "tax",
  "audit_search",
] as const;
export type AiTool = (typeof AI_TOOLS)[number];
const PROJECT_SCOPED_TOOLS: readonly AiTool[] = [
  "project_context", "rab_versions", "invoices", "tax", "audit_search",
];

const permissions: Record<AiTool, string> = {
  portfolio_summary: "projects:view",
  project_context: "projects:view",
  rab_versions: "projects:view",
  invoices: "invoices:view",
  tax: "tax:view",
  audit_search: "audit:view",
};

type Citation = { source: string; id?: string };
type ToolResult = { data: unknown; sources: Citation[] };
export type AiToolExecutor = (
  tool: AiTool,
  req: Parameters<typeof canAccessProject>[0],
  projectId?: string,
  asOf?: string,
) => Promise<ToolResult>;
export type AiControlPlaneDependencies = {
  executeTool?: AiToolExecutor;
  recordAudit?: (entry: {
    action: string;
    tool: AiTool;
    projectId?: string;
    userId: string;
    role: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
};

export function effectiveTaxRulesAt<T extends { effectiveFrom: string; effectiveTo: string | null }>(
  rules: readonly T[],
  asOf: string,
) {
  return rules.filter((rule) => rule.effectiveFrom <= asOf && (!rule.effectiveTo || rule.effectiveTo >= asOf));
}

/** Deterministic planner: prompt words are data only, never authority. */
export function planCopilotPrompt(prompt: string): AiTool | null {
  const text = prompt.toLocaleLowerCase("id-ID");
  if (/\b(sql|shell|bash|terminal|password|secret|token|hapus|ubah|buat)\b/.test(text)) return null;
  if (/(audit|jejak|aktivitas|log)/.test(text)) return "audit_search";
  if (/(pajak|ppn|pph|tax|tarif|aturan)/.test(text)) return "tax";
  if (/(invoice|tagihan|faktur|ppn invoice)/.test(text)) return "invoices";
  if (/(rab|anggaran|baseline|versi biaya)/.test(text)) return "rab_versions";
  if (/(konteks|detail proyek|profil proyek|progress|kemajuan)/.test(text)) return "project_context";
  if (/(portofolio|semua proyek|ringkasan proyek|proyek saya)/.test(text)) return "portfolio_summary";
  return null;
}

export function groundedCopilotAnswer(tool: AiTool, data: unknown, sources: readonly Citation[]) {
  const citations = sources.map((source) => `[${source.source}${source.id ? `:${source.id}` : ""}]`).join(" ");
  if (Array.isArray(data)) {
    return `${tool}: ${data.length} record ditemukan${citations ? ` ${citations}` : ""}.`;
  }
  if (data && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>)
      .filter(([key, value]) => key !== "rules" && value !== null && typeof value !== "object")
      .slice(0, 4)
      .map(([key, value]) => `${key}=${String(value)}`);
    return `${tool}: ${entries.join(", ") || "data tersedia"}${citations ? ` ${citations}` : ""}.`;
  }
  return `${tool}: ${data === null ? "tidak ada data" : String(data)}${citations ? ` ${citations}` : ""}.`;
}

function timeoutMs() {
  const value = Number(process.env.AI_COPILOT_TIMEOUT_MS ?? "5000");
  return Number.isFinite(value) && value > 0 ? Math.min(value, 30000) : 5000;
}

function enabled() {
  return (process.env.AI_COPILOT_ENABLED ?? "true").toLowerCase() !== "false";
}

function projectGuard(req: Parameters<typeof canAccessProject>[0], projectId: string | undefined) {
  if (!projectId || !canAccessProject(req, projectId)) {
    return false;
  }
  return true;
}

async function runTool(
  tool: AiTool,
  req: Parameters<typeof canAccessProject>[0],
  projectId?: string,
  requestedAsOf?: string,
): Promise<ToolResult> {
  const access = req.access!;
  if (["project_context", "rab_versions", "invoices", "tax", "audit_search"].includes(tool)
    && !projectGuard(req, projectId)) {
    throw Object.assign(new Error("Proyek tidak ditemukan atau Anda tidak memiliki akses"), { statusCode: 404 });
  }

  if (tool === "portfolio_summary") {
    const projects = await db.select().from(projectsTable);
    const visible = projects.filter((project) => canAccessProject(req, project.id));
    return {
      data: visible.map(({ id, code, name, status, progress, budget, actualCost, endDate }) =>
        ({ id, code, name, status, progress, budget, actualCost, endDate })),
      sources: visible.map((p) => ({ source: "projects", id: p.id })),
    };
  }
  if (tool === "project_context") {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId!)).limit(1);
    return {
      data: project ? { id: project.id, code: project.code, name: project.name, owner: project.owner,
        contractValue: project.contractValue, budget: project.budget, actualCost: project.actualCost,
        progress: project.progress, status: project.status, health: project.health, endDate: project.endDate } : null,
      sources: [{ source: "projects", id: projectId }],
    };
  }
  if (tool === "rab_versions") {
    const baselines = await db.select().from(rabBaselinesTable)
      .where(eq(rabBaselinesTable.projectId, projectId!)).orderBy(desc(rabBaselinesTable.version));
    return {
      data: baselines.map(({ id, projectId: _, version, status, createdAt, updatedAt }) =>
        ({ id, projectId, version, status, createdAt, updatedAt })),
      sources: baselines.map((b) => ({ source: "rab_baselines", id: b.id })),
    };
  }
  if (tool === "invoices") {
    const rows = await db.select().from(invoicesTable)
      .where(eq(invoicesTable.projectId, projectId!)).orderBy(desc(invoicesTable.issuedAt));
    return {
      data: rows.map(({ id, number, projectId: _, period, dpp, ppn, pphFinal, pph23, total, status, issuedAt, taxRuleVersionId }) =>
        ({ id, number, projectId, period, dpp, ppn, pphFinal, pph23, total, status, issuedAt, taxRuleVersionId })),
      sources: rows.map((row) => ({ source: "invoices", id: row.id })),
    };
  }
  if (tool === "tax") {
    const asOf = requestedAsOf ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      throw Object.assign(new Error("Tanggal efektif harus menggunakan format YYYY-MM-DD"), { statusCode: 400 });
    }
    const rules = await db.select().from(taxRuleVersionsTable).where(and(
      lte(taxRuleVersionsTable.effectiveFrom, asOf),
      or(isNull(taxRuleVersionsTable.effectiveTo), gte(taxRuleVersionsTable.effectiveTo, asOf)),
    )).orderBy(desc(taxRuleVersionsTable.effectiveFrom));
    const effectiveRules = effectiveTaxRulesAt(rules, asOf);
    return {
      data: { asOf, rules: effectiveRules },
      sources: effectiveRules.map((rule) => ({ source: "tax_rule_versions", id: rule.id })),
    };
  }
  // Audit records are project-scoped through their structured metadata. Records
  // without a project id are intentionally not exposed by this tool.
  // Resolve ownership in SQL before ordering/limiting. This prevents a busy
  // unrelated project from crowding target-project events out of the result.
  const auditProjectId = projectId!;
  const scopedRecords = await db.select({ audit: auditLogsTable })
    .from(auditLogsTable)
    .leftJoin(
      invoicesTable,
      and(eq(auditLogsTable.entity, "Invoice"), eq(auditLogsTable.entityId, invoicesTable.id)),
    )
    .leftJoin(
      rabBaselinesTable,
      and(eq(auditLogsTable.entity, "RAB"), eq(auditLogsTable.entityId, rabBaselinesTable.id)),
    )
    .where(and(
      or(
        sql`${auditLogsTable.metadata}->>'projectId' = ${auditProjectId}`,
        and(eq(auditLogsTable.entity, "Proyek"), eq(auditLogsTable.entityId, auditProjectId)),
        and(eq(auditLogsTable.entity, "Invoice"), eq(invoicesTable.projectId, auditProjectId)),
        and(eq(auditLogsTable.entity, "RAB"), eq(rabBaselinesTable.projectId, auditProjectId)),
      ),
    ))
    .orderBy(desc(auditLogsTable.timestamp))
    .limit(200);
  const visible = scopedRecords.map(({ audit }) => audit);
  return {
    data: visible.map(({ id, action, entity, detail, tone, timestamp, actorUserId }) =>
      ({ id, action, entity, detail, tone, timestamp, actorUserId })),
    sources: visible.map((record) => ({ source: "audit_logs", id: record.id })),
  };
}

async function recordAudit(entry: Parameters<NonNullable<AiControlPlaneDependencies["recordAudit"]>>[0]) {
  await db.insert(auditLogsTable).values({
    id: randomUUID(), action: entry.action, entity: entry.tool,
    entityId: entry.projectId ?? null, detail: `Tool ${entry.tool} dijalankan`,
    user: entry.userId, actorUserId: entry.userId, actorRole: entry.role,
    tone: entry.action.endsWith("FAILED") ? "warning" : "info", metadata: entry.metadata,
  });
}

export function createAiControlPlaneRouter(dependencies: AiControlPlaneDependencies = {}): IRouter {
  const router: IRouter = Router();
  const executeTool = dependencies.executeTool ?? runTool;
  const writeAudit = dependencies.recordAudit ?? recordAudit;
  router.get("/ai/tools", (_req, res) => res.json({ tools: AI_TOOLS }));
  router.post(["/ai/copilot", "/copilot"], async (req, res) => {
    if (!enabled()) {
      res.status(503).json({ error: "Copilot sedang dinonaktifkan oleh kill switch" });
      return;
    }
    const body = req.body;
    const allowedKeys = ["tool", "projectId", "asOf", "prompt"];
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !allowedKeys.includes(key))
      || (body.tool !== undefined && typeof body.tool !== "string")
      || (body.prompt !== undefined && typeof body.prompt !== "string")) {
      res.status(400).json({ error: "Input copilot tidak valid" });
      return;
    }
    const plannedTool = body.tool === undefined && typeof body.prompt === "string"
      ? planCopilotPrompt(body.prompt) : null;
    const tool = (body.tool ?? plannedTool) as AiTool;
    if (!tool || !AI_TOOLS.includes(tool)
      || (body.projectId !== undefined && typeof body.projectId !== "string")
      || (body.asOf !== undefined && (typeof body.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.asOf)))
      || (body.prompt !== undefined && typeof body.prompt !== "string")) {
      res.status(400).json({ error: "Tool copilot tidak diizinkan" });
      return;
    }
    const projectId = body.projectId as string | undefined;
    const asOf = body.asOf as string | undefined;
    if (PROJECT_SCOPED_TOOLS.includes(tool) && !projectId) {
      res.status(400).json({ error: "projectId wajib diisi untuk tool ini" });
      return;
    }
    if (projectId && !canAccessProject(req, projectId)) {
      res.status(404).json({ error: "Proyek tidak ditemukan atau Anda tidak memiliki akses" });
      return;
    }
    if (!req.access || !req.access.permissions.includes(permissions[tool])) {
      res.status(403).json({ error: "Jabatan Anda tidak memiliki hak untuk tool ini" });
      return;
    }
    const started = Date.now();
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          executeTool(tool, req, projectId, asOf),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error("Waktu tunggu copilot habis"), { statusCode: 504 })), timeoutMs());
          }),
        ]);
        const answer = groundedCopilotAnswer(tool, result.data, result.sources);
        await writeAudit({
          action: "AI_COPILOT_READ", tool, projectId, userId: req.access.userId, role: req.access.role,
          metadata: { projectId: projectId ?? null, durationMs: Date.now() - started, sources: result.sources },
        });
        res.json({ answer, tool, result: result.data, sources: result.sources });
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      const status = typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode: number }).statusCode) : 500;
      // Failure audits contain only operational metadata, never the prompt,
      // database payload, credentials, or model reasoning.
      if (req.access) {
        await writeAudit({
          action: "AI_COPILOT_FAILED", tool, projectId, userId: req.access.userId, role: req.access.role,
          metadata: { projectId: projectId ?? null, status },
        }).catch(() => undefined);
      }
      res.status(status).json({ error: error instanceof Error ? error.message : "Copilot gagal menjalankan tool" });
    }
  });
  return router;
}

export default createAiControlPlaneRouter();