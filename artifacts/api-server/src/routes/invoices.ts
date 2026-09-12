import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  CreateInvoiceBody,
  CreateInvoiceResponse,
  ListInvoicesQueryParams,
  ListInvoicesResponse,
} from "@workspace/api-zod";
import { activity, invoices, projects } from "../lib/demo-data";

const router: IRouter = Router();

router.get("/invoices", (req, res) => {
  const parsed = ListInvoicesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = invoices.filter((invoice) =>
    (!parsed.data.status || invoice.status === parsed.data.status) &&
    (!parsed.data.projectId || invoice.projectId === parsed.data.projectId)
  );
  res.json(ListInvoicesResponse.parse(data));
});

router.post("/invoices", (req, res) => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const project = projects.find((item) => item.id === parsed.data.projectId);
  if (!project) {
    res.status(400).json({ error: "Proyek tidak ditemukan" });
    return;
  }
  const dppLainRate = parsed.data.integrated ? 0.275 : 0.325;
  const ppn = parsed.data.dpp * dppLainRate * 0.11;
  const pphFinal = parsed.data.dpp * parsed.data.pphRate;
  const retention = parsed.data.dpp * (parsed.data.retentionPercent / 100);
  const invoice = {
    id: randomUUID(),
    number: `INV/${project.code}/IX/2026/${String(invoices.length + 1).padStart(3, "0")}`,
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
  invoices.unshift(invoice);
  activity.unshift({
    id: randomUUID(),
    action: "DIBUAT",
    entity: "Invoice",
    detail: `${invoice.number} · Pajak dihitung otomatis`,
    user: "Admin Demo",
    timestamp: new Date().toISOString(),
    tone: "info",
  });
  res.status(201).json(CreateInvoiceResponse.parse(invoice));
});

export default router;