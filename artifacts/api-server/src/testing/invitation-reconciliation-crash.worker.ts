import {
  db,
  pool,
  staffInvitationsTable,
  tryWithDatabaseAdvisoryLock,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  reconcileInvitationFromClerk,
  runScheduledInvitationReconciliation,
  scheduledReconciliationLockName,
} from "../lib/invitation-reconciliation";

const mode = process.argv[2];
const invitationId = process.argv[3];

const crashTestActor = {
  userId: "system:invitation-reconciliation-crash-test",
  displayName: "Sistem Rekonsiliasi Undangan",
  role: "SYSTEM",
};

async function loadInvitation() {
  if (!invitationId) throw new Error("Invitation id is required");
  const [invitation] = await db.select().from(staffInvitationsTable)
    .where(eq(staffInvitationsTable.id, invitationId))
    .limit(1);
  if (!invitation) throw new Error(`Invitation ${invitationId} was not found`);
  return invitation;
}

if (mode === "hold") {
  await tryWithDatabaseAdvisoryLock(
    scheduledReconciliationLockName,
    async () => {
      process.stdout.write("ACQUIRED\n");
      await new Promise(() => {});
    },
  );
} else if (mode === "reconcile-hold" || mode === "reconcile-graceful") {
  let releaseHold: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  if (mode === "reconcile-graceful") {
    process.once("SIGTERM", () => {
      process.stdout.write("SIGTERM_RECEIVED\n");
      releaseHold?.();
    });
  }
  try {
    await reconcileInvitationFromClerk(
      await loadInvitation(),
      { status: "expired" },
      crashTestActor,
      "SCHEDULED_CHECK",
      {
        afterStatusUpdate: async () => {
          process.stdout.write("STATUS_UPDATED\n");
          if (mode === "reconcile-hold") await new Promise(() => {});
          else await hold;
        },
      },
    );
    if (mode === "reconcile-graceful") {
      process.stdout.write("RECONCILIATION_COMPLETED\n");
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
} else if (mode === "reconcile") {
  try {
    const before = await loadInvitation();
    const after = await reconcileInvitationFromClerk(
      before,
      { status: "expired" },
      crashTestActor,
      "SCHEDULED_CHECK",
    );
    process.stdout.write(`RECONCILED ${before.status} ${after.status}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
} else if (mode === "run") {
  const deadline = Date.now() + 2_000;
  let attempts = 0;
  try {
    while (Date.now() < deadline) {
      attempts += 1;
      const result = await runScheduledInvitationReconciliation({
        getClerkInvitation: async () => ({ status: "pending" }),
      });
      if (!result.skipped) {
        process.stdout.write(`COMPLETED ${attempts}\n`);
        process.exitCode = 0;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (process.exitCode === undefined) {
      throw new Error("Reconciliation lock was not released within 2000ms");
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
} else {
  process.stderr.write(`Unknown worker mode: ${String(mode)}\n`);
  process.exitCode = 1;
  await pool.end();
}