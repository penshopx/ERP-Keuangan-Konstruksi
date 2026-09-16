import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  CreateTaxRuleBody,
  CreateTaxRuleResponse,
  GetTaxSummaryQueryParams,
  GetTaxSummaryResponse,
  ListTaxRulesResponse,
} from "@workspace/api-zod";
import {
  auditLogsTable,
  db,
  invoicesTable,
  taxCalculationSnapshotsTable,
  taxRuleVersionsTable,
} from "@workspace/db";
import { taxRuleLockKey } from "../domain/tax-rule-lock";
import { requirePermission } from "../middlewares/access";

const router: IRouter = Router();

function isTaxRuleOverlapConstraint(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  return (candidate.code === "23P01" && candidate.constraint === "tax_rule_versions_no_overlapping_periods")
    || (candidate.cause?.code === "23P01" && candidate.cause.constraint === "tax_rule_versions_no_overlapping_periods");
}

function previousCalendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function currentCalendarPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

router.get("/tax/summary", requirePermission("tax:view"), async (req, res) => {
  const parsed = GetTaxSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const period = parsed.data.period ?? currentCalendarPeriod();
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    res.status(400).json({ error: "Periode harus menggunakan format YYYY-MM." });
    return;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const periodStart = `${match[1]}-${match[2]}-01`;
  const nextPeriodStart = month === 12
    ? `${year + 1}-01-01`
    : `${match[1]}-${String(month + 1).padStart(2, "0")}-01`;
  const [summary] = await db.select({
    pphFinal: sql<number>`coalesce(sum(${invoicesTable.pphFinal}), 0)`.mapWith(Number),
    ppn: sql<number>`coalesce(sum(${invoicesTable.ppn}), 0)`.mapWith(Number),
    pph23: sql<number>`coalesce(sum(${invoicesTable.pph23}), 0)`.mapWith(Number),
    subLedgerTotal: sql<number>`coalesce(sum(
      coalesce(${taxCalculationSnapshotsTable.pphFinal}, 0)
      + coalesce(${taxCalculationSnapshotsTable.ppn}, 0)
      + coalesce(${taxCalculationSnapshotsTable.pph23}, 0)
    ), 0)`.mapWith(Number),
    documents: sql<number>`count(${invoicesTable.id})::int`.mapWith(Number),
  }).from(invoicesTable)
    .leftJoin(
      taxCalculationSnapshotsTable,
      eq(taxCalculationSnapshotsTable.invoiceId, invoicesTable.id),
    )
    .where(and(
    gte(invoicesTable.issuedAt, periodStart),
    sql`${invoicesTable.issuedAt} < ${nextPeriodStart}`,
  ));
  const { pphFinal, ppn, pph23, subLedgerTotal, documents } = summary;
  const total = pphFinal + ppn + pph23;
  res.json(GetTaxSummaryResponse.parse({
    period,
    pphFinal,
    ppn,
    pph23,
    total,
    subLedgerTotal,
    documents,
    reconciliation: total === 0
      ? (subLedgerTotal === 0 ? 1 : 0)
      : subLedgerTotal / total,
  }));
});

router.get("/tax/rules", requirePermission("tax-rules:manage"), async (_req, res): Promise<void> => {
  const rules = await db.select({
    id: taxRuleVersionsTable.id,
    version: taxRuleVersionsTable.version,
    effectiveFrom: taxRuleVersionsTable.effectiveFrom,
    effectiveTo: taxRuleVersionsTable.effectiveTo,
    regulatorySource: taxRuleVersionsTable.regulatorySource,
    serviceType: taxRuleVersionsTable.serviceType,
    qualification: taxRuleVersionsTable.qualification,
    requiresSbu: taxRuleVersionsTable.requiresSbu,
    supplierPkp: taxRuleVersionsTable.supplierPkp,
    governmentCollector: taxRuleVersionsTable.governmentCollector,
    integrated: taxRuleVersionsTable.integrated,
    dppRateBasisPoints: taxRuleVersionsTable.dppRateBasisPoints,
    ppnRateBasisPoints: taxRuleVersionsTable.ppnRateBasisPoints,
    pphFinalRateBasisPoints: taxRuleVersionsTable.pphFinalRateBasisPoints,
    pph23RateBasisPoints: taxRuleVersionsTable.pph23RateBasisPoints,
    createdAt: taxRuleVersionsTable.createdAt,
    invoiceUsageCount: sql<number>`count(${invoicesTable.id})::int`,
  }).from(taxRuleVersionsTable)
    .leftJoin(invoicesTable, eq(invoicesTable.taxRuleVersionId, taxRuleVersionsTable.id))
    .groupBy(taxRuleVersionsTable.id)
    .orderBy(desc(taxRuleVersionsTable.effectiveFrom), desc(taxRuleVersionsTable.createdAt));
  res.json(ListTaxRulesResponse.parse(rules));
});

router.post("/tax/rules", requirePermission("tax-rules:manage"), async (req, res): Promise<void> => {
  const parsed = CreateTaxRuleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Data aturan pajak tidak valid. Sumber regulasi dan tanggal berlaku wajib diisi." });
    return;
  }
  const data = {
    ...parsed.data,
    version: parsed.data.version.trim(),
    regulatorySource: parsed.data.regulatorySource.trim(),
    effectiveTo: parsed.data.effectiveTo ?? null,
    qualification: parsed.data.qualification ?? null,
  };
  if (!data.version || !data.regulatorySource || (data.effectiveTo && data.effectiveTo < data.effectiveFrom)) {
    res.status(400).json({ error: "Versi, sumber regulasi, dan periode berlaku harus valid." });
    return;
  }
  if (data.serviceType === "JASA_LAIN" && (data.qualification !== null || data.requiresSbu || data.integrated)) {
    res.status(400).json({ error: "Kualifikasi, SBU, dan pekerjaan terintegrasi hanya berlaku untuk jasa konstruksi." });
    return;
  }
  if (data.serviceType === "KONSTRUKSI" && data.qualification === null) {
    res.status(400).json({ error: "Kualifikasi wajib diisi untuk jasa konstruksi." });
    return;
  }

  let result;
  try {
    result = await db.transaction(async (tx) => {
      const criteriaKey = taxRuleLockKey(data);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tax-rule:${criteriaKey}`}))`);
      const [sameVersion] = await tx.select({ id: taxRuleVersionsTable.id }).from(taxRuleVersionsTable)
        .where(eq(taxRuleVersionsTable.version, data.version)).limit(1);
      if (sameVersion) return { conflict: "version" as const };
      const overlaps = await tx.select({
        id: taxRuleVersionsTable.id,
        effectiveFrom: taxRuleVersionsTable.effectiveFrom,
        effectiveTo: taxRuleVersionsTable.effectiveTo,
      }).from(taxRuleVersionsTable)
        .where(and(
          eq(taxRuleVersionsTable.serviceType, data.serviceType),
          data.qualification === null
            ? isNull(taxRuleVersionsTable.qualification)
            : eq(taxRuleVersionsTable.qualification, data.qualification),
          eq(taxRuleVersionsTable.requiresSbu, data.requiresSbu),
          eq(taxRuleVersionsTable.supplierPkp, data.supplierPkp),
          eq(taxRuleVersionsTable.governmentCollector, data.governmentCollector),
          eq(taxRuleVersionsTable.integrated, data.integrated),
          or(isNull(taxRuleVersionsTable.effectiveTo), gte(taxRuleVersionsTable.effectiveTo, data.effectiveFrom)),
          data.effectiveTo ? lte(taxRuleVersionsTable.effectiveFrom, data.effectiveTo) : undefined,
        ));
      let supersededRuleId: string | undefined;
      if (overlaps.length > 0) {
        const [openEnded] = overlaps;
        const canSupersede = overlaps.length === 1
          && openEnded.effectiveTo === null
          && openEnded.effectiveFrom < data.effectiveFrom;
        if (!canSupersede) return { conflict: "period" as const };
        const [affectedInvoice] = await tx.select({ id: invoicesTable.id }).from(invoicesTable)
          .where(and(
            eq(invoicesTable.taxRuleVersionId, openEnded.id),
            gte(invoicesTable.issuedAt, data.effectiveFrom),
          )).limit(1);
        if (affectedInvoice) return { conflict: "historical" as const };
        await tx.update(taxRuleVersionsTable)
          .set({ effectiveTo: previousCalendarDate(data.effectiveFrom) })
          .where(eq(taxRuleVersionsTable.id, openEnded.id));
        supersededRuleId = openEnded.id;
      }
      const [created] = await tx.insert(taxRuleVersionsTable).values({
        id: randomUUID(),
        ...data,
      }).returning();
      await tx.insert(auditLogsTable).values({
        id: randomUUID(),
        action: "ATURAN PAJAK DITAMBAHKAN",
        entity: "Aturan Pajak",
        entityId: created.id,
        detail: `${created.version} · berlaku ${created.effectiveFrom}${created.effectiveTo ? ` s.d. ${created.effectiveTo}` : " dan seterusnya"}`,
        user: req.access!.displayName,
        actorUserId: req.access!.userId,
        actorRole: req.access!.role,
        tone: "info",
        metadata: { regulatorySource: created.regulatorySource },
      });
      return { created, supersededRuleId };
    });
  } catch (error) {
    if (!isTaxRuleOverlapConstraint(error)) throw error;
    result = { conflict: "period" as const };
  }
  if ("conflict" in result) {
    res.status(409).json({
      error: result.conflict === "version"
        ? "Nama versi aturan sudah digunakan."
        : result.conflict === "historical"
          ? "Tanggal berlaku akan mengubah aturan untuk invoice yang sudah dibuat."
        : "Periode berlaku tumpang tindih dengan aturan berkriteria sama.",
    });
    return;
  }
  res.status(201).json(CreateTaxRuleResponse.parse({ ...result.created, invoiceUsageCount: 0 }));
});

export default router;