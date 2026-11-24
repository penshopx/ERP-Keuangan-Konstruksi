import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  accountsTable, auditLogsTable, db, financePeriodsTable, financeReportVersionsTable,
  journalEntriesTable, journalLinesTable,
} from "@workspace/db";
import { requirePermission } from "../middlewares/access";

const router: IRouter = Router();
const sections = ["bank", "ap", "ar", "pettyCash", "payroll", "tax", "missingDocuments"] as const;
type Section = typeof sections[number];
type Checklist = Record<Section, { done: boolean; note: string }>;
const emptyChecklist = (): Checklist => Object.fromEntries(sections.map((key) => [key, { done: false, note: "" }])) as Checklist;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const validMonth = (value: unknown): value is string => typeof value === "string" && monthPattern.test(value);
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 500;

function audit(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], actor: NonNullable<Express.Request["access"]>, action: string, month: string, metadata: Record<string, unknown>) {
  return tx.insert(auditLogsTable).values({
    id: randomUUID(), action, entity: "Periode Keuangan", entityId: month,
    detail: `${month} · ${action}`, user: actor.displayName, actorUserId: actor.userId,
    actorRole: actor.role, tone: "info", metadata,
  });
}

// This report only covers posted GL entries. Operational subledgers are not silently treated as posted.
async function buildReport(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], month: string) {
  const rows = await tx.select({
    entryId: journalEntriesTable.id, entryDate: journalEntriesTable.entryDate,
    sourceType: journalEntriesTable.sourceType, sourceId: journalEntriesTable.sourceId,
    cashFlowCategory: journalEntriesTable.cashFlowCategory,
    accountCode: accountsTable.code, accountName: accountsTable.name, type: accountsTable.type,
    isCash: accountsTable.isCash,
    debit: journalLinesTable.debit, credit: journalLinesTable.credit,
    projectId: journalLinesTable.projectId, wbs: journalLinesTable.wbs, costCode: journalLinesTable.costCode,
  }).from(journalLinesTable)
    .innerJoin(journalEntriesTable, eq(journalLinesTable.entryId, journalEntriesTable.id))
    .innerJoin(accountsTable, eq(journalLinesTable.accountCode, accountsTable.code))
    .where(lte(journalEntriesTable.period, month))
    .orderBy(journalEntriesTable.entryDate, journalEntriesTable.id, journalLinesTable.id);
  const current = rows.filter((r) => r.entryDate.slice(0, 7) === month);
  const group = (items: typeof rows, sign: (r: typeof rows[number]) => number, key: (r: typeof rows[number]) => string) => {
    const values = new Map<string, { amount: number; lines: typeof rows }>();
    for (const row of items) {
      const k = key(row);
      const bucket = values.get(k) ?? { amount: 0, lines: [] };
      bucket.amount += sign(row);
      bucket.lines.push(row);
      values.set(k, bucket);
    }
    return [...values].map(([key, value]) => ({ key, ...value }));
  };
  const normal = (r: typeof rows[number]) => ["ASSET", "EXPENSE"].includes(r.type) ? r.debit - r.credit : r.credit - r.debit;
  const balance = group(rows.filter((r) => ["ASSET", "LIABILITY", "EQUITY"].includes(r.type)), normal, (r) => `${r.accountCode} · ${r.accountName}`);
  const profitLoss = group(current.filter((r) => ["REVENUE", "EXPENSE"].includes(r.type)), normal, (r) => `${r.accountCode} · ${r.accountName}`);
  const projects = group(current.filter((r) => r.projectId && ["REVENUE", "EXPENSE"].includes(r.type)), normal,
    (r) => `${r.projectId} / ${r.wbs ?? "-"} / ${r.costCode ?? "-"} / ${r.type}`);
  // Categorize each cash movement at posting time, not by the bank account (which can serve multiple activities).
  const cashFlow = group(current.filter((r) => r.isCash), (r) => r.debit - r.credit, (r) => r.cashFlowCategory ?? "UNCLASSIFIED");
  const netIncome = profitLoss.reduce((sum, row) => sum + (row.lines[0]?.type === "REVENUE" ? row.amount : -row.amount), 0);
  const assets = balance.filter((r) => r.lines[0]?.type === "ASSET").reduce((s, r) => s + r.amount, 0);
  const liabilitiesEquity = balance.filter((r) => r.lines[0]?.type !== "ASSET").reduce((s, r) => s + r.amount, 0);
  const cumulativeIncome = rows.filter((r) => ["REVENUE", "EXPENSE"].includes(r.type))
    .reduce((s, r) => s + r.credit - r.debit, 0);
  return { period: month, basis: "posted-journals-only", balanceSheet: { accounts: balance, assets, liabilitiesEquity, unclosedIncome: cumulativeIncome },
    profitLoss: { accounts: profitLoss, netIncome }, cashFlow, projectProfitLoss: projects };
}

router.get("/finance/accounts", requirePermission("finance:view"), async (_req, res): Promise<void> => {
  res.json(await db.select().from(accountsTable).orderBy(accountsTable.code));
});
router.post("/finance/accounts", requirePermission("finance:post"), async (req, res): Promise<void> => {
  const { code, name, type, cashFlow, isCash } = req.body ?? {};
  if (!text(code) || !text(name) || !["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"].includes(type)
    || (cashFlow != null && !["OPERATING", "INVESTING", "FINANCING"].includes(cashFlow))
    || typeof isCash !== "boolean" || (isCash && type !== "ASSET")) {
    res.status(400).json({ error: "Akun dan klasifikasinya tidak valid." }); return;
  }
  const [created] = await db.insert(accountsTable).values({ code: code.trim(), name: name.trim(), type, cashFlow: cashFlow ?? null, isCash }).onConflictDoNothing().returning();
  if (!created) { res.status(409).json({ error: "Kode akun sudah digunakan." }); return; }
  res.status(201).json(created);
});
router.get("/finance/periods", requirePermission("finance:view"), async (_req, res): Promise<void> => {
  res.json(await db.select().from(financePeriodsTable).orderBy(financePeriodsTable.month));
});
router.post("/finance/periods", requirePermission("finance:post"), async (req, res): Promise<void> => {
  const { month } = req.body ?? {};
  if (!validMonth(month)) { res.status(400).json({ error: "Bulan harus YYYY-MM." }); return; }
  const [period] = await db.insert(financePeriodsTable).values({ month, checklist: emptyChecklist() }).onConflictDoNothing().returning();
  if (!period) { res.status(409).json({ error: "Periode sudah ada." }); return; }
  res.status(201).json(period);
});
router.post("/finance/journals", requirePermission("finance:post"), async (req, res): Promise<void> => {
  const { entryDate, kind, description, sourceType, sourceId, reversesId, cashFlowCategory, lines } = req.body ?? {};
  if (!validDate(entryDate) || !text(description) || !["NORMAL", "ADJUSTMENT", "REVERSAL"].includes(kind)
    || (sourceType != null && !text(sourceType)) || (sourceId != null && !text(sourceId))
    || (sourceType == null) !== (sourceId == null)
    || (kind !== "REVERSAL" && (!text(sourceType) || !text(sourceId)))
    || (cashFlowCategory != null && !["OPERATING", "INVESTING", "FINANCING"].includes(cashFlowCategory))
    || !Array.isArray(lines) || lines.length < 2 || lines.length > 100
    || lines.some((l) => !l || !text(l.accountCode) || !amount(l.debit) || !amount(l.credit)
      || (l.debit === 0) === (l.credit === 0) || (l.projectId != null && !text(l.projectId))
      || (l.wbs != null && !text(l.wbs)) || (l.costCode != null && !text(l.costCode)))) {
    res.status(400).json({ error: "Jurnal harus berisi dua atau lebih baris valid." }); return;
  }
  const debit = lines.reduce((n, l) => n + l.debit, 0);
  const credit = lines.reduce((n, l) => n + l.credit, 0);
  if (!Number.isSafeInteger(debit) || debit !== credit || debit === 0) {
    res.status(400).json({ error: "Jumlah debit dan kredit harus sama." }); return;
  }
  if (kind === "REVERSAL" ? !text(reversesId) : reversesId != null) {
    res.status(400).json({ error: "Reversal memerlukan ID jurnal asal; jurnal biasa tidak boleh memilikinya." }); return;
  }
  const period = entryDate.slice(0, 7);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('finance-ledger-issuance', 0))`);
    const [locked] = await tx.select().from(financePeriodsTable).where(eq(financePeriodsTable.month, period)).for("update");
    if (!locked) return { status: 404, error: "Periode belum dibuat." };
    if (!["OPEN", "REOPENED"].includes(locked.status)) return { status: 409, error: "Periode terkunci; gunakan adjustment atau reversal pada periode terbuka." };
    const [laterIssued] = await tx.select({ id: financeReportVersionsTable.id }).from(financeReportVersionsTable)
      .where(gt(financeReportVersionsTable.period, period)).limit(1);
    if (laterIssued) return { status: 409, error: "Periode berikutnya sudah diterbitkan; buat adjustment pada periode yang diizinkan." };
    const cashAccounts = await tx.select({ code: accountsTable.code }).from(accountsTable).where(eq(accountsTable.isCash, true));
    if (lines.some((l) => cashAccounts.some((a) => a.code === l.accountCode)) && !cashFlowCategory) {
      return { status: 400, error: "Kategori arus kas wajib untuk jurnal yang melibatkan kas/bank." };
    }
    if (kind === "REVERSAL") {
      const [origin] = await tx.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, reversesId));
      if (!origin || origin.entryDate > entryDate) return { status: 400, error: "Jurnal asal tidak tersedia atau bertanggal setelah reversal." };
      const previous = await tx.select().from(journalLinesTable).where(eq(journalLinesTable.entryId, reversesId));
      const reversed = previous.map((l) => ({ accountCode: l.accountCode, debit: l.credit, credit: l.debit,
        projectId: l.projectId, wbs: l.wbs, costCode: l.costCode }));
      const canonical = (a: typeof reversed) => JSON.stringify(a.map((l) => [l.accountCode, l.debit, l.credit, l.projectId ?? null, l.wbs ?? null, l.costCode ?? null]).sort());
      if (canonical(lines) !== canonical(reversed)) return { status: 400, error: "Reversal harus tepat membalik semua baris jurnal asal." };
      const [existing] = await tx.select({ id: journalEntriesTable.id }).from(journalEntriesTable).where(eq(journalEntriesTable.reversesId, reversesId));
      if (existing) return { status: 409, error: "Jurnal ini sudah dibalik." };
    }
    const id = randomUUID();
    await tx.insert(journalEntriesTable).values({ id, period, entryDate, kind, cashFlowCategory: cashFlowCategory ?? null, description: description.trim(),
      sourceType: sourceType ?? null, sourceId: sourceId ?? null, reversesId: reversesId ?? null, actorUserId: req.access!.userId });
    await tx.insert(journalLinesTable).values(lines.map((l) => ({
      id: randomUUID(), entryId: id, accountCode: l.accountCode, debit: l.debit, credit: l.credit,
      projectId: l.projectId ?? null, wbs: l.wbs ?? null, costCode: l.costCode ?? null,
    })));
    await audit(tx, req.access!, "JURNAL DIPOSTING", period, { id, kind, sourceType, sourceId, reversesId });
    return { status: 201, id };
  });
  res.status(result.status).json("error" in result ? { error: result.error } : { id: result.id });
});
router.get("/finance/journals", requirePermission("finance:view"), async (req, res): Promise<void> => {
  const month = req.query.period;
  if (!validMonth(month)) { res.status(400).json({ error: "Bulan harus YYYY-MM." }); return; }
  const entries = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.period, month)).orderBy(journalEntriesTable.entryDate);
  const lines = entries.length ? await db.select().from(journalLinesTable).where(inArray(journalLinesTable.entryId, entries.map((e) => e.id))) : [];
  res.json(entries.map((entry) => ({ ...entry, lines: lines.filter((l) => l.entryId === entry.id) })));
});
router.get("/finance/journals/:id", requirePermission("finance:view"), async (req, res): Promise<void> => {
  const [entry] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, req.params.id as string));
  if (!entry) { res.status(404).json({ error: "Jurnal asal tidak ditemukan." }); return; }
  const lines = await db.select().from(journalLinesTable).where(eq(journalLinesTable.entryId, entry.id));
  res.json({ ...entry, lines });
});
router.get("/finance/periods/:month/reports", requirePermission("finance:view"), async (req, res): Promise<void> => {
  const month = req.params.month;
  if (!validMonth(month)) { res.status(400).json({ error: "Bulan harus YYYY-MM." }); return; }
  const versions = await db.select().from(financeReportVersionsTable).where(eq(financeReportVersionsTable.period, month))
    .orderBy(financeReportVersionsTable.version);
  const [period] = await db.select().from(financePeriodsTable).where(eq(financePeriodsTable.month, month));
  if (!period) { res.status(404).json({ error: "Periode belum ada." }); return; }
  res.json({ status: period.status, versions, draft: period.status === "CLOSED" ? null : await db.transaction((tx) => buildReport(tx, month)) });
});
router.post("/finance/periods/:month/transition", requirePermission("finance:post"), async (req, res): Promise<void> => {
  const month = req.params.month;
  const { action, checklist, reason } = req.body ?? {};
  if (!validMonth(month) || !["REVIEW", "CLOSE", "REQUEST_REOPEN", "APPROVE_REOPEN"].includes(action)) {
    res.status(400).json({ error: "Transisi periode tidak valid." }); return;
  }
  if (action === "REVIEW" && (!checklist || typeof checklist !== "object" || sections.some((s) =>
    typeof checklist[s]?.done !== "boolean" || typeof checklist[s]?.note !== "string" || checklist[s].note.length > 500
    || (checklist[s].done !== true && !checklist[s].note.trim())))) {
    res.status(400).json({ error: "Lengkapi bank, AP, AR, kas kecil, payroll, pajak, dan dokumen kurang. Catat alasan item yang belum selesai." }); return;
  }
  if (action === "REQUEST_REOPEN" && !text(reason)) {
    res.status(400).json({ error: "Alasan reopen wajib diisi." }); return;
  }
  if (["CLOSE", "APPROVE_REOPEN"].includes(action) && !req.access?.permissions.includes("finance:approve")) {
    res.status(403).json({ error: "Persetujuan direktur diperlukan." }); return;
  }
  const result = await db.transaction(async (tx) => {
    if (action === "CLOSE") {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('finance-ledger-issuance', 0))`);
    }
    const [period] = await tx.select().from(financePeriodsTable).where(eq(financePeriodsTable.month, month)).for("update");
    if (!period) return { status: 404, error: "Periode belum ada." };
    const actor = req.access!;
    const director = actor.role === "DIRECTOR";
    if (action === "REVIEW" && ["OPEN", "REOPENED"].includes(period.status)) {
      await tx.update(financePeriodsTable).set({ status: "REVIEW", checklist, preparedBy: actor.userId, approvedBy: null, updatedAt: new Date() }).where(eq(financePeriodsTable.month, month));
    } else if (action === "CLOSE" && period.status === "REVIEW" && director && period.preparedBy !== actor.userId) {
      const items = period.checklist as Checklist;
      if (sections.some((s) => items[s]?.done !== true)) return { status: 409, error: "Semua item checklist harus selesai sebelum close." };
      const report = await buildReport(tx, month);
      const previous = await tx.select({ version: financeReportVersionsTable.version }).from(financeReportVersionsTable)
        .where(eq(financeReportVersionsTable.period, month)).orderBy(sql`${financeReportVersionsTable.version} desc`).limit(1);
      await tx.insert(financeReportVersionsTable).values({ id: randomUUID(), period: month, version: (previous[0]?.version ?? 0) + 1,
        approvedBy: actor.userId, report });
      await tx.update(financePeriodsTable).set({ status: "CLOSED", approvedBy: actor.userId, updatedAt: new Date() }).where(eq(financePeriodsTable.month, month));
    } else if (action === "REQUEST_REOPEN" && period.status === "CLOSED" && !period.reopenRequestedBy) {
      await tx.update(financePeriodsTable).set({ reopenReason: reason.trim(), reopenRequestedBy: actor.userId, updatedAt: new Date() }).where(eq(financePeriodsTable.month, month));
    } else if (action === "APPROVE_REOPEN" && period.status === "CLOSED" && period.reopenRequestedBy && director && period.reopenRequestedBy !== actor.userId) {
      await tx.update(financePeriodsTable).set({ status: "REOPENED", reopenReason: null, reopenRequestedBy: null, updatedAt: new Date() }).where(eq(financePeriodsTable.month, month));
    } else return { status: 409, error: "Status, izin, atau pemisahan pemohon dan pemberi persetujuan tidak sesuai." };
    await audit(tx, actor, `PERIODE ${action}`, month, { previousStatus: period.status, reason: action === "REQUEST_REOPEN" ? reason : period.reopenReason,
      requester: period.reopenRequestedBy, checklist: action === "REVIEW" ? checklist : undefined });
    return { status: 200 };
  });
  res.status(result.status).json("error" in result ? { error: result.error } : { ok: true });
});

export default router;