import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  operationalStateTable,
  staffInvitationsTable,
  tryWithDatabaseAdvisoryLock,
} from "@workspace/db";

export type ClerkInvitationState = {
  status: string;
};

export type ReconciliationActor = {
  userId: string;
  displayName: string;
  role: string;
};

export type InvitationReconciliationReason =
  | "LIST_REFRESH"
  | "PARTIAL_REVOKE_FAILURE"
  | "SCHEDULED_CHECK";

export type ScheduledInvitationReconciliationDependencies = {
  getClerkInvitation: (invitationId: string) => Promise<ClerkInvitationState>;
  onError?: (
    error: unknown,
    invitation: typeof staffInvitationsTable.$inferSelect,
  ) => void;
  onRunError?: (error: unknown) => void;
  onRunEvent?: (event: InvitationReconciliationRunEvent) => void;
  alerting?: InvitationReconciliationAlerting;
};

export type InvitationReconciliationScheduleOptions = {
  intervalMs?: number;
  runImmediately?: boolean;
};

export type InvitationReconciliationHealth = {
  status: "HEALTHY" | "DEGRADED";
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRun: InvitationReconciliationRunEvent;
};

export type InvitationReconciliationRunEvent =
  | {
      outcome: "NEVER_RUN";
      occurredAt: null;
    }
  | {
      outcome: "RUNNING";
      occurredAt: string;
    }
  | {
      outcome: "SKIPPED";
      occurredAt: string;
      reason: "COORDINATION_LOCK_UNAVAILABLE";
    }
  | {
      outcome: "COMPLETED";
      occurredAt: string;
      checked: number;
      updated: number;
      failed: number;
    }
  | {
      outcome: "FAILED";
      occurredAt: string;
    };

export type InvitationReconciliationAlert = {
  type: "DEGRADED" | "RECOVERED";
  occurredAt: string;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
};

export type InvitationReconciliationAlerting = {
  failureThreshold: number;
  notify: (alert: InvitationReconciliationAlert) => Promise<void>;
  onNotificationError?: (
    error: unknown,
    alert: InvitationReconciliationAlert,
  ) => void;
};

let reconciliationHealth: InvitationReconciliationHealth = {
  status: "HEALTHY",
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  lastRun: {
    outcome: "NEVER_RUN",
    occurredAt: null,
  },
};

export const clerkInvitationVerificationStateKey =
  "clerk-invitation-verification";

function recordReconciliationFailure() {
  reconciliationHealth = {
    ...reconciliationHealth,
    status: "DEGRADED",
    consecutiveFailures: reconciliationHealth.consecutiveFailures + 1,
    lastFailureAt: new Date().toISOString(),
  };
}

function recordReconciliationSuccess() {
  reconciliationHealth = {
    ...reconciliationHealth,
    status: "HEALTHY",
    consecutiveFailures: 0,
    lastSuccessAt: new Date().toISOString(),
  };
}

type AlertIncidentState = {
  active: boolean;
  pendingDegraded: InvitationReconciliationAlert | null;
};

const alertIncidentStates =
  new WeakMap<InvitationReconciliationAlerting, AlertIncidentState>();

export async function updateInvitationReconciliationAlert(
  alerting: InvitationReconciliationAlerting | undefined,
  health: InvitationReconciliationHealth,
) {
  if (!alerting) return;

  const state = alertIncidentStates.get(alerting) ?? {
    active: false,
    pendingDegraded: null,
  };
  alertIncidentStates.set(alerting, state);

  if (
    !state.active
    && !state.pendingDegraded
    && health.consecutiveFailures >= alerting.failureThreshold
  ) {
    state.pendingDegraded = {
      type: "DEGRADED",
      occurredAt: new Date().toISOString(),
      consecutiveFailures: health.consecutiveFailures,
      lastFailureAt: health.lastFailureAt,
      lastSuccessAt: health.lastSuccessAt,
    };
  }

  if (state.pendingDegraded) {
    const pending = state.pendingDegraded;
    try {
      await alerting.notify(pending);
      state.pendingDegraded = null;
      state.active = true;
    } catch (error) {
      alerting.onNotificationError?.(error, pending);
      return;
    }
  }

  if (!state.active || health.status !== "HEALTHY") return;

  const recovered: InvitationReconciliationAlert = {
    type: "RECOVERED",
    occurredAt: new Date().toISOString(),
    consecutiveFailures: health.consecutiveFailures,
    lastFailureAt: health.lastFailureAt,
    lastSuccessAt: health.lastSuccessAt,
  };
  try {
    await alerting.notify(recovered);
    state.active = false;
  } catch (error) {
    alerting.onNotificationError?.(error, recovered);
  }
}

export function getInvitationReconciliationHealth(): InvitationReconciliationHealth {
  return { ...reconciliationHealth };
}

export async function recordSuccessfulClerkVerification(
  at = new Date(),
): Promise<string> {
  const [state] = await db.insert(operationalStateTable)
    .values({
      key: clerkInvitationVerificationStateKey,
      lastSuccessfulAt: at,
    })
    .onConflictDoUpdate({
      target: operationalStateTable.key,
      set: {
        lastSuccessfulAt: sql`greatest(${operationalStateTable.lastSuccessfulAt}, excluded.last_successful_at)`,
        updatedAt: new Date(),
      },
    })
    .returning({ lastSuccessfulAt: operationalStateTable.lastSuccessfulAt });
  if (!state) {
    throw new Error("Waktu verifikasi Clerk tidak dapat disimpan");
  }
  return state.lastSuccessfulAt.toISOString();
}

export async function getLastSuccessfulClerkVerificationAt(): Promise<string | null> {
  const [state] = await db.select({
    lastSuccessfulAt: operationalStateTable.lastSuccessfulAt,
  }).from(operationalStateTable)
    .where(eq(operationalStateTable.key, clerkInvitationVerificationStateKey))
    .limit(1);
  return state?.lastSuccessfulAt.toISOString() ?? null;
}

const scheduledActor: ReconciliationActor = {
  userId: "system:invitation-reconciliation",
  displayName: "Sistem Rekonsiliasi Undangan",
  role: "SYSTEM",
};

const inactiveClerkStatuses = new Set(["revoked", "expired"]);
export const scheduledReconciliationLockName =
  "api-server:scheduled-invitation-reconciliation";

export async function reconcileInvitationFromClerk(
  invitation: typeof staffInvitationsTable.$inferSelect,
  clerkState: ClerkInvitationState,
  actor: ReconciliationActor,
  reason: InvitationReconciliationReason,
) {
  const clerkStatus = clerkState.status.toLowerCase();
  if (invitation.status !== "PENDING" || !inactiveClerkStatuses.has(clerkStatus)) {
    return invitation;
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx.update(staffInvitationsTable)
      .set({ status: clerkStatus === "revoked" ? "REVOKED" : "EXPIRED" })
      .where(and(
        eq(staffInvitationsTable.id, invitation.id),
        eq(staffInvitationsTable.status, "PENDING"),
      ))
      .returning();
    if (!updated) {
      const [current] = await tx.select().from(staffInvitationsTable)
        .where(eq(staffInvitationsTable.id, invitation.id)).limit(1);
      return current ?? invitation;
    }

    const audit: typeof auditLogsTable.$inferInsert = {
      id: randomUUID(),
      action: "STATUS UNDANGAN DIREKONSILIASI",
      entity: "Undangan",
      entityId: invitation.id,
      detail: `${invitation.displayName} · ${invitation.email} · ${invitation.status} → ${updated.status}`,
      user: actor.displayName,
      actorUserId: actor.userId,
      actorRole: actor.role,
      tone: "warning",
      metadata: {
        reason,
        sourceOfTruth: "CLERK",
        clerkInvitationId: invitation.clerkInvitationId,
        clerkStatus,
        previousStatus: invitation.status,
        reconciledStatus: updated.status,
        outcome: "UPDATED",
      },
    };
    await tx.insert(auditLogsTable).values(audit);
    return updated;
  });
}

export async function reconcilePendingInvitations(
  dependencies: ScheduledInvitationReconciliationDependencies,
) {
  const pendingInvitations = await db.select().from(staffInvitationsTable)
    .where(eq(staffInvitationsTable.status, "PENDING"));
  let checked = 0;
  let updated = 0;
  let failed = 0;

  for (const invitation of pendingInvitations) {
    try {
      const clerkState = await dependencies.getClerkInvitation(invitation.clerkInvitationId);
      const reconciled = await reconcileInvitationFromClerk(
        invitation,
        clerkState,
        scheduledActor,
        "SCHEDULED_CHECK",
      );
      checked += 1;
      if (reconciled.status !== invitation.status) updated += 1;
    } catch (error) {
      failed += 1;
      dependencies.onError?.(error, invitation);
    }
  }

  if (failed > 0) {
    recordReconciliationFailure();
  } else {
    recordReconciliationSuccess();
  }
  return { checked, updated, failed };
}

export async function runScheduledInvitationReconciliation(
  dependencies: ScheduledInvitationReconciliationDependencies,
) {
  const runningEvent: InvitationReconciliationRunEvent = {
    outcome: "RUNNING",
    occurredAt: new Date().toISOString(),
  };
  reconciliationHealth = { ...reconciliationHealth, lastRun: runningEvent };
  dependencies.onRunEvent?.(runningEvent);

  const result = await tryWithDatabaseAdvisoryLock(
    scheduledReconciliationLockName,
    () => reconcilePendingInvitations(dependencies),
  );
  if (!result.acquired) {
    const skippedEvent: InvitationReconciliationRunEvent = {
      outcome: "SKIPPED",
      occurredAt: new Date().toISOString(),
      reason: "COORDINATION_LOCK_UNAVAILABLE",
    };
    reconciliationHealth = { ...reconciliationHealth, lastRun: skippedEvent };
    dependencies.onRunEvent?.(skippedEvent);
    return { skipped: true as const };
  }
  const completedEvent: InvitationReconciliationRunEvent = {
    outcome: "COMPLETED",
    occurredAt: new Date().toISOString(),
    ...result.value,
  };
  reconciliationHealth = { ...reconciliationHealth, lastRun: completedEvent };
  dependencies.onRunEvent?.(completedEvent);
  await updateInvitationReconciliationAlert(
    dependencies.alerting,
    reconciliationHealth,
  );
  return { skipped: false as const, ...result.value };
}

export function schedulePendingInvitationReconciliation(
  dependencies: ScheduledInvitationReconciliationDependencies,
  options: InvitationReconciliationScheduleOptions = {},
) {
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runScheduledInvitationReconciliation(dependencies);
    } catch (error) {
      recordReconciliationFailure();
      const failedEvent: InvitationReconciliationRunEvent = {
        outcome: "FAILED",
        occurredAt: new Date().toISOString(),
      };
      reconciliationHealth = { ...reconciliationHealth, lastRun: failedEvent };
      dependencies.onRunEvent?.(failedEvent);
      dependencies.onRunError?.(error);
      await updateInvitationReconciliationAlert(
        dependencies.alerting,
        reconciliationHealth,
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  if (options.runImmediately ?? true) void run();

  return {
    stop: () => clearInterval(timer),
    run,
  };
}

export async function recordInvitationPartialFailure(
  invitation: typeof staffInvitationsTable.$inferSelect,
  actor: ReconciliationActor,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  const audit: typeof auditLogsTable.$inferInsert = {
    id: randomUUID(),
    action: "KEGAGALAN PARSIAL PEMBATALAN UNDANGAN",
    entity: "Undangan",
    entityId: invitation.id,
    detail: `${invitation.displayName} · Clerk berhasil dibatalkan, pembaruan ERP gagal`,
    user: actor.displayName,
    actorUserId: actor.userId,
    actorRole: actor.role,
    tone: "warning",
    metadata: {
      operation: "REVOKE_INVITATION",
      clerkInvitationId: invitation.clerkInvitationId,
      clerkOutcome: "REVOKED",
      erpOutcome: "FAILED",
      error: message,
      reconciliationRequired: true,
    },
  };
  await db.insert(auditLogsTable).values(audit);
}