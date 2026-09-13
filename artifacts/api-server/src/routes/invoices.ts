import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invoicesTable,
  projectsTable,
  taxCalculationSnapshotsTable,
  taxRuleVersionsTable,
} from "@workspace/db";
import {
  CreateInvoiceBody,
  CreateInvoiceResponse,
  ListInvoicesQueryParams,
  ListInvoicesResponse,
} from "@workspace/api-zod";
import { buildInvoiceNumber } from "../domain/invoice-number";
import { taxRuleLockKey } from "../domain/tax-rule-lock";
import { canAccessProject, requirePermission } from "../middlewares/access";

export type InvoicePersistenceHooks = {
  beforeAuditInsert?: (invoiceId: string) => Promise<void>;
  beforeInvoiceInsert?: (invoiceId: string) => Promise<void>;
  afterTaxRuleSelection?: (taxRuleId: string) => Promise<void>;
  afterInvoiceNumberAllocated?: (invoice: {
    id: string;
    number: string;
    sequence: number;
  }) => Promise<void>;
};

export function createInvoicesRouter(hooks: InvoicePersistenceHooks = {}): IRouter {
const router: IRouter = Router();

router.get("/invoices", requirePermission("invoices:view"), async (req, res) => {
  const parsed = ListInvoicesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [
    parsed.data.status ? eq(invoicesTable.status, parsed.data.status) : undefined,
    parsed.data.projectId ? eq(invoicesTable.projectId, parsed.data.projectId) : undefined,
  ].filter((filter) => filter !== undefined);
  if (req.access?.role === "PROJECT_MANAGER") {
    if (req.access.assignedProjectIds.length === 0) {
      res.json(ListInvoicesResponse.parse([]));
      return;
    }
    filters.push(or(...req.access.assignedProjectIds.map((id) => eq(invoicesTable.projectId, id)))!);
  }
  const data = await db.select().from(invoicesTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(invoicesTable.createdAt));
  res.json(ListInvoicesResponse.parse(data));
});

router.post("/invoices", requirePermission("invoices:write"), async (req, res) => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (
    !Number.isSafeInteger(parsed.data.dpp) ||
    parsed.data.dpp < 0 ||
    parsed.data.retentionPercent < 0 ||
    parsed.data.retentionPercent > 100
  ) {
    res.status(400).json({ error: "Nilai invoice atau tarif pajak tidak valid" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, parsed.data.projectId)).limit(1);
  if (!project) {
    res.status(400).json({ error: "Proyek tidak ditemukan" });
    return;
  }
  if (!canAccessProject(req, project.id)) {
    res.status(403).json({ error: "Proyek berada di luar penugasan Anda" });
    return;
  }
  if (parsed.data.serviceType === "KONSTRUKSI" && parsed.data.qualification !== "TANPA_KUALIFIKASI" && !parsed.data.hasSbu) {
    res.status(400).json({ error: "SBU wajib untuk jasa konstruksi berkualifikasi" });
    return;
  }
  if (parsed.data.serviceType !== "KONSTRUKSI" && (parsed.data.hasSbu || parsed.data.qualification !== "TIDAK_BERLAKU")) {
    res.status(400).json({ error: "SBU dan kualifikasi konstruksi tidak berlaku untuk jenis jasa ini" });
    return;
  }
  if (parsed.data.serviceType !== "KONSTRUKSI" && parsed.data.integrated) {
    res.status(400).json({ error: "Opsi pekerjaan terintegrasi hanya berlaku untuk jasa konstruksi" });
    return;
  }
  const invoiceId = randomUUID();
  const result = await db.transaction(async (tx) => {
    const criteriaKey = taxRuleLockKey({
      serviceType: parsed.data.serviceType,
      qualification: parsed.data.serviceType === "KONSTRUKSI" ? parsed.data.qualification : null,
      requiresSbu: parsed.data.hasSbu,
      supplierPkp: parsed.data.supplierPkp,
      governmentCollector: parsed.data.governmentCollector,
      integrated: parsed.data.integrated,
    });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tax-rule:${criteriaKey}`}))`);
    const [rule] = await tx.select().from(taxRuleVersionsTable).where(and(
      eq(taxRuleVersionsTable.serviceType, parsed.data.serviceType),
      parsed.data.serviceType === "KONSTRUKSI"
        ? eq(taxRuleVersionsTable.qualification, parsed.data.qualification)
        : isNull(taxRuleVersionsTable.qualification),
      eq(taxRuleVersionsTable.requiresSbu, parsed.data.hasSbu),
      eq(taxRuleVersionsTable.supplierPkp, parsed.data.supplierPkp),
      eq(taxRuleVersionsTable.governmentCollector, parsed.data.governmentCollector),
      eq(taxRuleVersionsTable.integrated, parsed.data.integrated),
      lte(taxRuleVersionsTable.effectiveFrom, parsed.data.issuedAt),
      or(isNull(taxRuleVersionsTable.effectiveTo), gte(taxRuleVersionsTable.effectiveTo, parsed.data.issuedAt)),
    )).orderBy(desc(taxRuleVersionsTable.effectiveFrom)).limit(1);
    if (!rule) return { invoice: null };
    await hooks.afterTaxRuleSelection?.(rule.id);
    const taxableDpp = Math.round(parsed.data.dpp * rule.dppRateBasisPoints / 10_000);
    const ppn = parsed.data.supplierPkp ? Math.round(taxableDpp * rule.ppnRateBasisPoints / 10_000) : 0;
    const pphFinal = Math.round(parsed.data.dpp * rule.pphFinalRateBasisPoints / 10_000);
    const pph23 = Math.round(parsed.data.dpp * rule.pph23RateBasisPoints / 10_000);
    const retention = Math.round(parsed.data.dpp * (parsed.data.retentionPercent / 100));
    const invoiceDraft = {
      id: invoiceId,
      number: `PENDING/${invoiceId}`,
      projectId: project.id,
      projectCode: project.code,
      projectName: project.name,
      period: parsed.data.period,
      dpp: parsed.data.dpp,
      ppn,
      pphFinal,
      retention,
      pph23,
      total: parsed.data.dpp + (parsed.data.governmentCollector ? 0 : ppn) - pphFinal - pph23 - retention,
      status: "DRAF",
      issuedAt: parsed.data.issuedAt,
      taxRuleVersionId: rule.id,
    };
    await hooks.beforeInvoiceInsert?.(invoiceId);
    const [created] = await tx.insert(invoicesTable).values(invoiceDraft).returning();
    const number = buildInvoiceNumber(project.code, parsed.data.issuedAt, created.sequence);
    const [stored] = await tx.update(invoicesTable)
      .set({ number })
      .where(eq(invoicesTable.id, invoiceId))
      .returning();
    await hooks.afterInvoiceNumberAllocated?.({
      id: stored.id,
      number: stored.number,
      sequence: stored.sequence,
    });
    await tx.insert(taxCalculationSnapshotsTable).values({
      id: randomUUID(),
      invoiceId,
      taxRuleVersionId: rule.id,
      ruleVersion: rule.version,
      regulatorySource: rule.regulatorySource,
      ruleSnapshot: rule,
      dpp: parsed.data.dpp,
      serviceType: parsed.data.serviceType,
      qualification: parsed.data.qualification,
      hasSbu: parsed.data.hasSbu,
      supplierPkp: parsed.data.supplierPkp,
      governmentCollector: parsed.data.governmentCollector,
      integrated: parsed.data.integrated,
      dppLainRateBasisPoints: rule.dppRateBasisPoints,
      ppnRateBasisPoints: rule.ppnRateBasisPoints,
      pphRateBasisPoints: rule.pphFinalRateBasisPoints,
      retentionPercentBasisPoints: Math.round(parsed.data.retentionPercent * 100),
      ppn,
      pphFinal,
      pph23,
      retention,
    });
    await hooks.beforeAuditInsert?.(invoiceId);
    await tx.insert(auditLogsTable).values({
      id: randomUUID(),
      action: "DIBUAT",
      entity: "Invoice",
      entityId: invoiceId,
      detail: `${number} · Pajak dihitung otomatis`,
      user: req.access!.displayName,
      actorUserId: req.access!.userId,
      actorRole: req.access!.role,
      tone: "info",
    });
    return { invoice: stored };
  });
  if (!result.invoice) {
    res.status(422).json({ error: "Tidak ada aturan pajak yang berlaku untuk kombinasi invoice ini" });
    return;
  }
  res.status(201).json(CreateInvoiceResponse.parse(result.invoice));
});

return router;
}

export default createInvoicesRouter();