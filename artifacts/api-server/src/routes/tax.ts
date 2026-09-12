import { Router, type IRouter } from "express";
import { GetTaxSummaryQueryParams, GetTaxSummaryResponse } from "@workspace/api-zod";
import { db, invoicesTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/tax/summary", async (req, res) => {
  const parsed = GetTaxSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const invoices = await db.select().from(invoicesTable);
  const pphFinal = invoices.reduce((sum, item) => sum + item.pphFinal, 0);
  const ppn = invoices.reduce((sum, item) => sum + item.ppn, 0);
  const pph23 = 48_750_000;
  res.json(GetTaxSummaryResponse.parse({
    period: parsed.data.period ?? "September 2026",
    pphFinal,
    ppn,
    pph23,
    total: pphFinal + ppn + pph23,
    documents: 18,
    reconciliation: 99.8,
  }));
});

export default router;