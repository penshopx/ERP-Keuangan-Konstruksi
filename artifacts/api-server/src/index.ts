import app from "./app";
import { assertRequiredDatabaseMigrations } from "@workspace/db";
import { logger } from "./lib/logger";
import { seedDemoData } from "./lib/demo-data";
import { seedRabTemplates } from "./lib/rab-template-data";
import { schedulePendingInvitationReconciliation } from "./lib/invitation-reconciliation";
import { getClerkInvitationState } from "./routes/access";

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

await assertRequiredDatabaseMigrations();
await seedRabTemplates();
if (process.env.NODE_ENV === "development") {
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
});

server.on("close", () => invitationReconciliation.stop());
