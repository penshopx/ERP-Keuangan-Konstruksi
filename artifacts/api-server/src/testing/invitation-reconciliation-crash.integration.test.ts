import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  auditLogsTable,
  db,
  pool,
  staffInvitationsTable,
  userRolesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

const workerUrl = new URL(
  "./invitation-reconciliation-crash.worker.ts",
  import.meta.url,
);

type Worker = ReturnType<typeof startWorker>;

function startWorker(
  mode: "hold" | "run" | "reconcile-hold" | "reconcile",
  invitationId?: string,
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      workerUrl.pathname,
      mode,
      ...(invitationId ? [invitationId] : []),
    ],
    { cwd: process.cwd(), env: process.env },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, result, stdout: () => stdout, stderr: () => stderr };
}

after(async () => {
  await pool.end();
});

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
  read: () => string,
) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${JSON.stringify(expected)}; received ${JSON.stringify(read())}`,
        ),
      );
    }, 5_000);
    const onData = () => {
      if (!read().includes(expected)) return;
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(
        new Error(
          `Worker exited before ${JSON.stringify(expected)}; received ${JSON.stringify(read())}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.once("close", onClose);
    onData();
  });
}

async function killWorker(worker: Worker) {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill("SIGKILL");
  }
  return worker.result;
}

test("scheduled reconciliation resumes after the lock holder crashes", async () => {
  const holder = startWorker("hold");
  let successor: Worker | undefined;
  try {
    await waitForOutput(holder.child, "ACQUIRED", holder.stdout);

    const crashed = await killWorker(holder);
    assert.equal(crashed.signal, "SIGKILL");
    assert.equal(holder.stdout().includes("RELEASED"), false);

    const startedAt = Date.now();
    successor = startWorker("run");
    const completed = await successor.result;
    const elapsedMs = Date.now() - startedAt;

    assert.equal(completed.code, 0, successor.stderr());
    assert.match(successor.stdout(), /^COMPLETED \d+\n$/);
    assert.ok(
      elapsedMs < 2_500,
      `successor took ${elapsedMs}ms to continue reconciliation`,
    );
  } finally {
    await Promise.all([
      killWorker(holder),
      ...(successor ? [killWorker(successor)] : []),
    ]);
  }
});

test("crashing mid-reconciliation cannot split invitation status and audit", async () => {
  const runId = randomUUID();
  const userId = `reconciliation-crash-user-${runId}`;
  const invitationId = `reconciliation-crash-invitation-${runId}`;
  const auditWhere = and(
    eq(auditLogsTable.entityId, invitationId),
    eq(auditLogsTable.action, "STATUS UNDANGAN DIREKONSILIASI"),
  );
  let interrupted: Worker | undefined;
  const successors: Worker[] = [];

  try {
    await db.insert(userRolesTable).values({
      userId,
      role: "ADMIN",
      displayName: "Reconciliation Crash Test",
    });
    await db.insert(staffInvitationsTable).values({
      id: invitationId,
      clerkInvitationId: `clerk-${runId}`,
      email: `reconciliation-crash-${runId}@example.test`,
      displayName: "Reconciliation Crash Test",
      role: "STAFF",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 60_000),
      invitedByUserId: userId,
    });

    interrupted = startWorker("reconcile-hold", invitationId);
    await waitForOutput(
      interrupted.child,
      "STATUS_UPDATED",
      interrupted.stdout,
    );
    const crashed = await killWorker(interrupted);
    assert.equal(crashed.signal, "SIGKILL");

    const [afterCrash] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitationId));
    const auditsAfterCrash = await db.select().from(auditLogsTable)
      .where(auditWhere);
    assert.equal(afterCrash?.status, "PENDING");
    assert.equal(auditsAfterCrash.length, 0);

    const successor = startWorker("reconcile", invitationId);
    successors.push(successor);
    const completed = await successor.result;
    assert.equal(completed.code, 0, successor.stderr());
    assert.equal(successor.stdout(), "RECONCILED PENDING EXPIRED\n");

    const idempotentSuccessor = startWorker("reconcile", invitationId);
    successors.push(idempotentSuccessor);
    const idempotent = await idempotentSuccessor.result;
    assert.equal(idempotent.code, 0, idempotentSuccessor.stderr());
    assert.equal(idempotentSuccessor.stdout(), "RECONCILED EXPIRED EXPIRED\n");

    const [finalInvitation] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitationId));
    const finalAudits = await db.select().from(auditLogsTable)
      .where(auditWhere);
    assert.equal(finalInvitation?.status, "EXPIRED");
    assert.equal(finalAudits.length, 1);
    assert.equal(finalAudits[0]?.metadata?.outcome, "UPDATED");
  } finally {
    await Promise.all([
      ...(interrupted ? [killWorker(interrupted)] : []),
      ...successors.map(killWorker),
    ]);
    await db.delete(auditLogsTable).where(eq(auditLogsTable.entityId, invitationId));
    await db.delete(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitationId));
    await db.delete(userRolesTable).where(eq(userRolesTable.userId, userId));
  }
});