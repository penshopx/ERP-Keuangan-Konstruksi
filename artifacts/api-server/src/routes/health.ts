import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getInvitationReconciliationHealth } from "../lib/invitation-reconciliation";
import { listOperationalAlertDeliveryStatuses } from "../lib/operational-alert-status";

const router: IRouter = Router();

router.get("/healthz", async (_req, res, next) => {
  try {
    const [invitationReconciliation, operationalAlerts] = await Promise.all([
      getInvitationReconciliationHealth(),
      listOperationalAlertDeliveryStatuses(),
    ]);
    const data = HealthCheckResponse.parse({
      status: invitationReconciliation.status === "HEALTHY" ? "ok" : "degraded",
      invitationReconciliation,
      operationalAlerts,
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
