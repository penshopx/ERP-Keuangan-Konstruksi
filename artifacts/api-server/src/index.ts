import app from "./app";
import { assertRequiredDatabaseMigrations } from "@workspace/db";
import { logger } from "./lib/logger";
import { seedDemoData } from "./lib/demo-data";
import { seedRabTemplates } from "./lib/rab-template-data";
import {
  type InvitationReconciliationAlert,
  schedulePendingInvitationReconciliation,
} from "./lib/invitation-reconciliation";
import { shouldSeedDemoData } from "./lib/demo-seeding";
import { getClerkInvitationState } from "./routes/access";
import { clerkClient } from "@clerk/express";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const alertWebhookUrl = process.env["INVITATION_RECONCILIATION_ALERT_WEBHOOK_URL"];
const rawFailureThreshold =
  process.env["INVITATION_RECONCILIATION_ALERT_FAILURE_THRESHOLD"] ?? "3";
const alertFailureThreshold = Number(rawFailureThreshold);
if (!Number.isInteger(alertFailureThreshold) || alertFailureThreshold <= 0) {
  throw new Error(
    "INVITATION_RECONCILIATION_ALERT_FAILURE_THRESHOLD must be a positive integer",
  );
}
const rawAlertTimeoutMs =
  process.env["INVITATION_RECONCILIATION_ALERT_TIMEOUT_MS"] ?? "5000";
const alertTimeoutMs = Number(rawAlertTimeoutMs);
if (!Number.isInteger(alertTimeoutMs) || alertTimeoutMs <= 0) {
  throw new Error(
    "INVITATION_RECONCILIATION_ALERT_TIMEOUT_MS must be a positive integer",
  );
}

async function sendInvitationReconciliationAlert(
  alert: InvitationReconciliationAlert,
) {
  if (!alertWebhookUrl) return;
  const response = await fetch(alertWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(alertTimeoutMs),
    body: JSON.stringify({
      source: "invitation-reconciliation",
      severity: alert.type === "DEGRADED" ? "error" : "info",
      message: alert.type === "DEGRADED"
        ? `Rekonsiliasi undangan gagal ${alert.consecutiveFailures} kali berturut-turut`
        : "Rekonsiliasi undangan telah pulih",
      ...alert,
    }),
  });
  if (!response.ok) {
    throw new Error(`Alert webhook returned HTTP ${response.status}`);
  }
}

await assertRequiredDatabaseMigrations();
await seedRabTemplates();
if (shouldSeedDemoData(process.env)) {
  await seedDemoData();
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

const invitationReconciliation = schedulePendingInvitationReconciliation({
  getClerkInvitation: getClerkInvitationState,
  revokeClerkInvitation: clerkClient.invitations.revokeInvitation.bind(
    clerkClient.invitations,
  ),
  alerting: alertWebhookUrl
    ? {
        failureThreshold: alertFailureThreshold,
        notify: sendInvitationReconciliationAlert,
        onNotificationError: (err, alert) => {
          logger.error({ err, alertType: alert.type },
            "Invitation reconciliation alert delivery failed; it will be retried");
        },
      }
    : undefined,
  onError: (err, invitation) => {
    logger.warn({
      err,
      invitationId: invitation.id,
      clerkInvitationId: invitation.clerkInvitationId,
    }, "Scheduled invitation reconciliation failed; it will be retried");
  },
  onRunError: (err) => {
    logger.warn({ err }, "Scheduled invitation reconciliation pass failed; it will be retried");
  },
  onRunEvent: (event) => {
    logger.info({
      event: "invitation_reconciliation_run",
      ...event,
    }, `Scheduled invitation reconciliation ${event.outcome.toLowerCase()}`);
  },
});

server.on("close", () => invitationReconciliation.stop());
