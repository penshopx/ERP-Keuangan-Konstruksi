import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getInvitationReconciliationHealth } from "../lib/invitation-reconciliation";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const invitationReconciliation = getInvitationReconciliationHealth();
  const data = HealthCheckResponse.parse({
    status: invitationReconciliation.status === "HEALTHY" ? "ok" : "degraded",
    invitationReconciliation,
  });
  res.json(data);
});

export default router;
