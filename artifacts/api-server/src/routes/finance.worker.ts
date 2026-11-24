import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { db, pool } from "@workspace/db";
import { eq } from "drizzle-orm";
import { financeReportVersionsTable } from "@workspace/db";
import financeRouter from "./finance";
import { rolePermissions } from "../middlewares/access-policy";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const actor = req.header("x-actor") ?? "finance";
  const role = actor.startsWith("director") ? "DIRECTOR" : "FINANCE";
  req.access = { userId: actor, displayName: actor, role, assignedProjectIds: [], permissions: [...rolePermissions[role]] };
  next();
});
app.use("/api", financeRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/finance`;
type Reports = { versions: { report: {
  profitLoss: { netIncome: number; accounts: { lines: { sourceId: string | null }[] }[] };
  cashFlow: { amount: number }[]; projectProfitLoss: { amount: number }[];
} }[]; draft: unknown };
async function call<T = unknown>(path: string, actor = "finance", body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-actor": actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as T };
}
const checklist = Object.fromEntries(["bank", "ap", "ar", "pettyCash", "payroll", "tax", "missingDocuments"].map((s) => [s, { done: true, note: "Sudah diperiksa" }]));
const lines = (n: number) => [
  { accountCode: "100", debit: n, credit: 0 },
  { accountCode: "400", debit: 0, credit: n, projectId: "project-1", wbs: "1.1", costCode: "P1" },
];

try {
  await db.execute("INSERT INTO projects(id) VALUES ('project-1')");
  assert.equal((await call("/periods", "finance", { month: "2026-09" })).status, 201);
  assert.equal((await call("/periods", "finance", { month: "2026-10" })).status, 201);
  assert.equal((await call("/accounts", "finance", { code: "100", name: "Bank", type: "ASSET", isCash: true, cashFlow: "OPERATING" })).status, 201);
  assert.equal((await call("/accounts", "finance", { code: "400", name: "Pendapatan", type: "REVENUE", isCash: false })).status, 201);
  const journal = { entryDate: "2026-09-20", kind: "NORMAL", description: "Termin", cashFlowCategory: "OPERATING",
    sourceType: "INVOICE", sourceId: "INV-1", lines: lines(100) };
  assert.equal((await call("/journals", "finance", { ...journal, lines: [lines(100)[0], { ...lines(100)[1], credit: 99 }] })).status, 400);
  const posted = await call<{ id: string }>("/journals", "finance", journal);
  assert.equal(posted.status, 201);
  const entryId = posted.data.id;
  assert.equal((await call("/periods/2026-09/transition", "finance", { action: "REVIEW", checklist })).status, 200);
  assert.equal((await call("/journals", "finance", journal)).status, 409);
  assert.equal((await call("/periods/2026-09/transition", "finance", { action: "CLOSE" })).status, 403);
  assert.equal((await call("/periods/2026-09/transition", "director-1", { action: "CLOSE" })).status, 200);
  const first = await call<Reports>("/periods/2026-09/reports");
  assert.equal(first.data.versions.length, 1);
  assert.equal(first.data.draft, null);
  assert.equal(first.data.versions[0].report.profitLoss.netIncome, 100);
  assert.equal(first.data.versions[0].report.cashFlow[0].amount, 100);
  assert.equal(first.data.versions[0].report.projectProfitLoss[0].amount, 100);
  assert.equal(first.data.versions[0].report.profitLoss.accounts[0].lines[0].sourceId, "INV-1");
  assert.equal((await call("/journals", "finance", journal)).status, 409);
  await assert.rejects(pool.query(
    "INSERT INTO journal_entries(id, period, entry_date, description, actor_user_id) VALUES ('illegal', '2026-09', '2026-09-21', 'late', 'finance')",
  ), /locked/);
  await assert.rejects(pool.query("UPDATE journal_lines SET credit = 200 WHERE entry_id = $1", [entryId]), /immutable/);
  await assert.rejects(pool.query("UPDATE finance_report_versions SET report = '{}'::jsonb"), /immutable/);
  assert.equal((await call("/periods/2026-09/transition", "finance", { action: "REQUEST_REOPEN", reason: "Koreksi" })).status, 200);
  assert.equal((await call("/periods/2026-09/transition", "finance", { action: "APPROVE_REOPEN" })).status, 403);
  assert.equal((await call("/periods/2026-09/transition", "director-1", { action: "APPROVE_REOPEN" })).status, 200);
  const reversal = { ...journal, entryDate: "2026-10-01", kind: "REVERSAL", reversesId: entryId, description: "Balik termin",
    lines: lines(100).map((l) => ({ ...l, debit: l.credit, credit: l.debit })) };
  assert.equal((await call("/journals", "finance", reversal)).status, 201);
  assert.equal((await call("/journals", "finance", reversal)).status, 409);
  assert.equal((await call("/journals", "finance", { ...journal, kind: "ADJUSTMENT", lines: lines(20) })).status, 201);
  assert.equal((await call("/periods/2026-09/transition", "finance", { action: "REVIEW", checklist })).status, 200);
  assert.equal((await call("/periods/2026-09/transition", "director-1", { action: "CLOSE" })).status, 200);
  const second = await call<Reports>("/periods/2026-09/reports");
  assert.equal(second.data.versions.length, 2);
  assert.equal(second.data.versions[0].report.profitLoss.netIncome, 100);
  assert.equal(second.data.versions[1].report.profitLoss.netIncome, 120);
  assert.equal((await call("/periods/2026-10/transition", "finance", { action: "REVIEW", checklist })).status, 200);
  assert.equal((await call("/periods/2026-10/transition", "director-1", { action: "CLOSE" })).status, 200);
  assert.equal((await call("/periods/2026-09/transition", "finance", { action: "REQUEST_REOPEN", reason: "Terlambat" })).status, 200);
  assert.equal((await call("/periods/2026-09/transition", "director-1", { action: "APPROVE_REOPEN" })).status, 200);
  assert.equal((await call("/journals", "finance", journal)).status, 409);
  await assert.rejects(pool.query(
    "INSERT INTO journal_entries(id, period, entry_date, description, actor_user_id) VALUES ('older', '2026-09', '2026-09-22', 'older', 'finance')",
  ), /later period/);
  assert.equal((await db.select().from(financeReportVersionsTable).where(eq(financeReportVersionsTable.period, "2026-09"))).length, 2);

  // A separate database connection posts in January while an API request tries to issue
  // February's cumulative report. Issuance must wait for the posting commit.
  assert.equal((await call("/periods", "finance", { month: "2027-01" })).status, 201);
  assert.equal((await call("/periods", "finance", { month: "2027-02" })).status, 201);
  assert.equal((await call("/periods/2027-02/transition", "finance", { action: "REVIEW", checklist })).status, 200);
  const writer = await pool.connect();
  let writerOpen = false;
  try {
    await writer.query("BEGIN");
    writerOpen = true;
    await writer.query(`
      INSERT INTO journal_entries(id, period, entry_date, kind, cash_flow_category, description,
        source_type, source_id, actor_user_id)
      VALUES ('race-journal', '2027-01', '2027-01-15', 'NORMAL', 'OPERATING',
        'Termin Januari', 'INVOICE', 'INV-RACE', 'finance')
    `);
    await writer.query(`
      INSERT INTO journal_lines(id, entry_id, account_code, debit, credit)
      VALUES ('race-debit', 'race-journal', '100', 55, 0),
        ('race-credit', 'race-journal', '400', 0, 55)
    `);
    let closeSettled = false;
    const close = call("/periods/2027-02/transition", "director-1", { action: "CLOSE" })
      .finally(() => { closeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closeSettled, false, "issuance must wait for the earlier journal transaction");
    await writer.query("COMMIT");
    writerOpen = false;
    assert.equal((await close).status, 200);
  } finally {
    if (writerOpen) await writer.query("ROLLBACK");
    writer.release();
  }
  const february = await call<Reports>("/periods/2027-02/reports");
  assert.equal(february.data.versions.length, 1);
  assert.ok(february.data.versions[0].report.profitLoss.accounts.length === 0);
  const issued = await db.select().from(financeReportVersionsTable).where(eq(financeReportVersionsTable.period, "2027-02"));
  const issuedReport = issued[0].report as { balanceSheet: { accounts: { lines: { entryId: string }[] }[] } };
  assert.ok(issuedReport.balanceSheet.accounts.some((group) => group.lines.some((line) => line.entryId === "race-journal")));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}