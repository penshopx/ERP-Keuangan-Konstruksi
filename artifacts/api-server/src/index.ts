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
import {
  resolveOperationalAlertConfig,
  sendOperationalAlert,
} from "@workspace/db/operational-alert";
import { logRabImportLockTimeout } from "./lib/rab-import-config";

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

const rawFailureThreshold =
  process.env["INVITATION_RECONCILIATION_ALERT_FAILURE_THRESHOLD"] ?? "3";
const alertFailureThreshold = Number(rawFailureThreshold);
if (!Number.isInteger(alertFailureThreshold) || alertFailureThreshold <= 0) {
  throw new Error(
    "INVITATION_RECONCILIATION_ALERT_FAILURE_THRESHOLD must be a positive integer",
  );
}
const rawCompletionStaleAfterMs =
  process.env["INVITATION_RECONCILIATION_ALERT_STALE_AFTER_MS"] ?? "900000";
const completionStaleAfterMs = Number(rawCompletionStaleAfterMs);
if (!Number.isInteger(completionStaleAfterMs) || completionStaleAfterMs <= 0) {
  throw new Error(
    "INVITATION_RECONCILIATION_ALERT_STALE_AFTER_MS must be a positive integer",
  );
}
const invitationAlertConfig = resolveOperationalAlertConfig({
  channelWebhookUrl:
    process.env["INVITATION_RECONCILIATION_ALERT_WEBHOOK_URL"],
  channelTimeoutMs:
    process.env["INVITATION_RECONCILIATION_ALERT_TIMEOUT_MS"],
});

async function sendInvitationReconciliationAlert(
  alert: InvitationReconciliationAlert,
) {
  const result = await sendOperationalAlert({
    config: invitationAlertConfig,
    log: logger,
    alert: {
      source: "invitation-reconciliation",
      event: alert.type === "DEGRADED"
        ? "invitation_reconciliation_degraded"
        : "invitation_reconciliation_recovered",
      severity: alert.type === "DEGRADED" ? "error" : "info",
      message: alert.type === "DEGRADED"
        ? alert.reason === "NO_RECENT_COMPLETION"
          ? `Rekonsiliasi undangan belum menyelesaikan putaran dalam ${completionStaleAfterMs} ms`
          : `Rekonsiliasi undangan gagal ${alert.consecutiveFailures} kali berturut-turut`
        : "Rekonsiliasi undangan telah pulih",
      ...alert,
    },
  });
  if (!result.delivered && result.reason === "delivery_failed") throw result.error;
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
  logRabImportLockTimeout(logger, process.env);
});

const invitationReconciliation = schedulePendingInvitationReconciliation({
  getClerkInvitation: getClerkInvitationState,
  revokeClerkInvitation: clerkClient.invitations.revokeInvitation.bind(
    clerkClient.invitations,
  ),
  alerting: {
    failureThreshold: alertFailureThreshold,
    completionStaleAfterMs,
    notify: sendInvitationReconciliationAlert,
    onNotificationError: (err, alert) => {
      logger.error({ err, alertType: alert.type },
        "Invitation reconciliation alert delivery failed; it will be retried");
    },
  },
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

const shutdownTimeoutMs = 10_000;
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, shutdownTimeoutMs }, "Graceful shutdown started");

  const forcedExit = setTimeout(() => {
    logger.error(
      { signal, shutdownTimeoutMs },
      "Graceful shutdown timed out; forcing process exit",
    );
    process.exit(1);
  }, shutdownTimeoutMs);
  forcedExit.unref();

  server.close();
  await invitationReconciliation.stop();
  await new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.once("close", resolve);
    server.once("error", reject);
  });
  clearTimeout(forcedExit);
  logger.info({ signal }, "Graceful shutdown completed");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((err) => {
      logger.error({ err, signal }, "Graceful shutdown failed");
      process.exitCode = 1;
    });
  });
}
