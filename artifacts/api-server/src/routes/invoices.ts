import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invoicesTable,
  projectsTable,
  taxCalculationSnapshotsTable,
} from "@workspace/db";
import {
  CreateInvoiceBody,
  CreateInvoiceResponse,
  ListInvoicesQueryParams,
  ListInvoicesResponse,
} from "@workspace/api-zod";
const router: IRouter = Router();

router.get("/invoices", async (req, res) => {
  const parsed = ListInvoicesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [
    parsed.data.status ? eq(invoicesTable.status, parsed.data.status) : undefined,
    parsed.data.projectId ? eq(invoicesTable.projectId, parsed.data.projectId) : undefined,
  ].filter((filter) => filter !== undefined);
  const data = await db.select().from(invoicesTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(invoicesTable.createdAt));
  res.json(ListInvoicesResponse.parse(data));
});

router.post("/invoices", async (req, res) => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (
    !Number.isSafeInteger(parsed.data.dpp) ||
    parsed.data.dpp < 0 ||
    parsed.data.retentionPercent < 0 ||
    parsed.data.retentionPercent > 100 ||
    parsed.data.pphRate < 0 ||
    parsed.data.pphRate > 100
  ) {
    res.status(400).json({ error: "Nilai invoice atau tarif pajak tidak valid" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, parsed.data.projectId)).limit(1);
  if (!project) {
    res.status(400).json({ error: "Proyek tidak ditemukan" });
    return;
  }
  const dppLainRate = parsed.data.integrated ? 0.275 : 0.325;
  const pphRate = parsed.data.pphRate / 100;
  const ppn = Math.round(parsed.data.dpp * dppLainRate * 0.11);
  const pphFinal = Math.round(parsed.data.dpp * pphRate);
  const retention = Math.round(parsed.data.dpp * (parsed.data.retentionPercent / 100));
  const invoiceId = randomUUID();
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
    total: parsed.data.dpp + ppn - pphFinal - retention,
    status: "DRAF",
    issuedAt: new Date().toISOString().slice(0, 10),
  };
  const invoice = await db.transaction(async (tx) => {
    const [created] = await tx.insert(invoicesTable).values(invoiceDraft).returning();
    const number = `INV/${project.code}/IX/2026/${String(created.sequence).padStart(3, "0")}`;
    const [stored] = await tx.update(invoicesTable)
      .set({ number })
      .where(eq(invoicesTable.id, invoiceId))
      .returning();
    await tx.insert(taxCalculationSnapshotsTable).values({
      id: randomUUID(),
      invoiceId,
      dpp: parsed.data.dpp,
      integrated: parsed.data.integrated,
      dppLainRateBasisPoints: Math.round(dppLainRate * 10_000),
      ppnRateBasisPoints: 1100,
      pphRateBasisPoints: Math.round(parsed.data.pphRate * 100),
      retentionPercentBasisPoints: Math.round(parsed.data.retentionPercent * 100),
      ppn,
      pphFinal,
      retention,
    });
    await tx.insert(auditLogsTable).values({
      id: randomUUID(),
      action: "DIBUAT",
      entity: "Invoice",
      entityId: invoiceId,
      detail: `${number} · Pajak dihitung otomatis`,
      user: "Admin Demo",
      tone: "info",
    });
    return stored;
  });
  res.status(201).json(CreateInvoiceResponse.parse(invoice));
});

export default router;