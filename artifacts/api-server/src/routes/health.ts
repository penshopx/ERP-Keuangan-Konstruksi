import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getInvitationReconciliationHealth } from "../lib/invitation-reconciliation";

const router: IRouter = Router();

router.get("/healthz", async (_req, res, next) => {
  try {
    const invitationReconciliation = await getInvitationReconciliationHealth();
    const data = HealthCheckResponse.parse({
      status: invitationReconciliation.status === "HEALTHY" ? "ok" : "degraded",
      invitationReconciliation,
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
