import { Router, type IRouter } from "express";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";
import { projects } from "../lib/demo-data";

const router: IRouter = Router();

router.get("/dashboard/summary", (_req, res) => {
  const portfolioValue = projects.reduce((sum, item) => sum + item.contractValue, 0);
  const committedCost = 63_760_000_000;
  const data = {
    activeProjects: projects.filter((item) => item.status === "BERJALAN").length,
    portfolioValue,
    committedCost,
    cashPosition: 8_420_000_000,
    budgetUtilization: 57.4,
    alerts: [
      { id: "alt-01", severity: "critical", title: "Cashflow JBT-014 berisiko negatif", detail: "Defisit Rp 2,4 M diproyeksikan pada Oktober 2026.", action: "Tinjau cashflow" },
      { id: "alt-02", severity: "warning", title: "Komitmen WBS hampir penuh", detail: "Pekerjaan pondasi JBT-014 sudah memakai 94% anggaran.", action: "Buka RAB" },
      { id: "alt-03", severity: "info", title: "Retensi segera jatuh tempo", detail: "Retensi RSU-008 senilai Rp 812,5 jt dapat ditagihkan dalam 24 hari.", action: "Siapkan tagihan" },
    ],
    cashflow: [
      { month: "Apr", inflow: 7.8e9, outflow: 6.4e9, net: 1.4e9 },
      { month: "Mei", inflow: 5.2e9, outflow: 7.1e9, net: -1.9e9 },
      { month: "Jun", inflow: 8.9e9, outflow: 7.6e9, net: 1.3e9 },
      { month: "Jul", inflow: 6.4e9, outflow: 8.2e9, net: -1.8e9 },
      { month: "Agu", inflow: 10.7e9, outflow: 8.5e9, net: 2.2e9 },
      { month: "Sep", inflow: 9.2e9, outflow: 8.8e9, net: 0.4e9 },
      { month: "Okt", inflow: 7.4e9, outflow: 9.8e9, net: -2.4e9 },
    ],
  };
  res.json(GetDashboardSummaryResponse.parse(data));
});

export default router;