import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invitationReconciliationStateTable,
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

export type InvitationReconciliationTransactionHooks = {
  afterStatusUpdate?: () => Promise<void>;
};

export type ScheduledInvitationReconciliationDependencies = {
  getClerkInvitation: (invitationId: string) => Promise<ClerkInvitationState>;
  revokeClerkInvitation?: (invitationId: string) => Promise<unknown>;
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
  lastCompletedAt: string | null;
  completionOverdue: boolean;
  completionStaleAfterMs: number | null;
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
  reason: "CONSECUTIVE_FAILURES" | "NO_RECENT_COMPLETION";
  occurredAt: string;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastCompletedAt: string | null;
};

export type InvitationReconciliationAlerting = {
  failureThreshold: number;
  completionStaleAfterMs: number;
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
  lastCompletedAt: null,
  completionOverdue: false,
  completionStaleAfterMs: null,
  lastRun: {
    outcome: "NEVER_RUN",
    occurredAt: null,
  },
};
const reconciliationMonitoringStartedAt = Date.now();
const invitationReconciliationStateKey = "scheduled-invitation-reconciliation";

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
    status: reconciliationHealth.completionOverdue ? "DEGRADED" : "HEALTHY",
    consecutiveFailures: 0,
    lastSuccessAt: new Date().toISOString(),
  };
}

function recordReconciliationCompletion(occurredAt: string) {
  reconciliationHealth = {
    ...reconciliationHealth,
    status: reconciliationHealth.consecutiveFailures > 0 ? "DEGRADED" : "HEALTHY",
    lastCompletedAt: occurredAt,
    completionOverdue: false,
  };
}

function evaluateReconciliationCompletionFreshness(
  completionStaleAfterMs: number,
  now = Date.now(),
) {
  const baseline = reconciliationHealth.lastCompletedAt
    ? Date.parse(reconciliationHealth.lastCompletedAt)
    : reconciliationMonitoringStartedAt;
  const completionOverdue = now - baseline >= completionStaleAfterMs;
  reconciliationHealth = {
    ...reconciliationHealth,
    status: completionOverdue || reconciliationHealth.consecutiveFailures > 0
      ? "DEGRADED"
      : "HEALTHY",
    completionOverdue,
    completionStaleAfterMs,
  };
}

export async function updateInvitationReconciliationAlert(
  alerting: InvitationReconciliationAlerting | undefined,
  health: InvitationReconciliationHealth,
) {
  if (!alerting) return;

  await ensureSharedReconciliationState();
  const degraded = health.consecutiveFailures >= alerting.failureThreshold
    || health.completionOverdue;
  if (degraded) {
    await db.update(invitationReconciliationStateTable).set({
      alertIncidentActive: true,
      alertIncidentReason: health.completionOverdue
        ? "NO_RECENT_COMPLETION"
        : "CONSECUTIVE_FAILURES",
      degradedAlertSent: false,
      updatedAt: new Date(),
    }).where(and(
      eq(invitationReconciliationStateTable.key, invitationReconciliationStateKey),
      eq(invitationReconciliationStateTable.alertIncidentActive, false),
    ));
  }

  const deliver = async (type: InvitationReconciliationAlert["type"]) => {
    let attempted: InvitationReconciliationAlert | null = null;
    try {
      await db.transaction(async (tx) => {
      await tx.execute(sql`
        select 1
        from ${invitationReconciliationStateTable}
        where ${invitationReconciliationStateTable.key} = ${invitationReconciliationStateKey}
        for update
      `);
      const [state] = await tx.select().from(invitationReconciliationStateTable)
        .where(eq(
          invitationReconciliationStateTable.key,
          invitationReconciliationStateKey,
        ))
        .limit(1);
      if (!state?.alertIncidentActive) return;
      if (type === "DEGRADED" && state.degradedAlertSent) return;
      if (type === "RECOVERED" && !state.degradedAlertSent) return;

      const reason = (
        state.alertIncidentReason === "NO_RECENT_COMPLETION"
          ? state.alertIncidentReason
          : "CONSECUTIVE_FAILURES"
      );
      attempted = {
        type,
        reason,
        occurredAt: new Date().toISOString(),
        consecutiveFailures: health.consecutiveFailures,
        lastFailureAt: health.lastFailureAt,
        lastSuccessAt: health.lastSuccessAt,
        lastCompletedAt: health.lastCompletedAt,
      };
      await alerting.notify(attempted);
      if (type === "DEGRADED") {
        await tx.update(invitationReconciliationStateTable).set({
          degradedAlertSent: true,
          updatedAt: new Date(),
        }).where(eq(
          invitationReconciliationStateTable.key,
          invitationReconciliationStateKey,
        ));
      } else {
        await tx.update(invitationReconciliationStateTable).set({
          alertIncidentActive: false,
          alertIncidentReason: null,
          degradedAlertSent: false,
          updatedAt: new Date(),
        }).where(eq(
          invitationReconciliationStateTable.key,
          invitationReconciliationStateKey,
        ));
      }
      });
      return true;
    } catch (error) {
      if (attempted) alerting.onNotificationError?.(error, attempted);
      return false;
    }
  };

  const degradedDelivered = await deliver("DEGRADED");
  if (!degradedDelivered || health.status !== "HEALTHY") return;
  await deliver("RECOVERED");
}

async function ensureSharedReconciliationState() {
  await db.insert(invitationReconciliationStateTable).values({
    key: invitationReconciliationStateKey,
    monitoringStartedAt: new Date(reconciliationMonitoringStartedAt),
  }).onConflictDoNothing();
}

async function persistSharedRunEvent(event: InvitationReconciliationRunEvent) {
  if (event.outcome === "NEVER_RUN") return;
  const occurredAt = new Date(event.occurredAt);
  await ensureSharedReconciliationState();
  await db.update(invitationReconciliationStateTable).set({
    lastRunAt: occurredAt,
    lastRun: event,
    updatedAt: new Date(),
  }).where(and(
    eq(invitationReconciliationStateTable.key, invitationReconciliationStateKey),
    sql`(
      ${invitationReconciliationStateTable.lastRunAt} is null
      or ${invitationReconciliationStateTable.lastRunAt} <= ${occurredAt}
    )`,
  ));
}

async function persistSharedReconciliationFailure(at: Date) {
  await ensureSharedReconciliationState();
  await db.update(invitationReconciliationStateTable).set({
    consecutiveFailures: sql`${invitationReconciliationStateTable.consecutiveFailures} + 1`,
    lastFailureAt: sql`greatest(
      ${invitationReconciliationStateTable.lastFailureAt},
      ${at}
    )`,
    updatedAt: new Date(),
  }).where(eq(
    invitationReconciliationStateTable.key,
    invitationReconciliationStateKey,
  ));
}

async function persistSharedReconciliationSuccess(at: Date) {
  await ensureSharedReconciliationState();
  await db.update(invitationReconciliationStateTable).set({
    consecutiveFailures: 0,
    lastSuccessAt: sql`greatest(
      ${invitationReconciliationStateTable.lastSuccessAt},
      ${at}
    )`,
    updatedAt: new Date(),
  }).where(eq(
    invitationReconciliationStateTable.key,
    invitationReconciliationStateKey,
  ));
}

async function persistSharedReconciliationCompletion(
  event: Extract<InvitationReconciliationRunEvent, { outcome: "COMPLETED" }>,
  completedAt: Date,
) {
  await ensureSharedReconciliationState();
  await db.update(invitationReconciliationStateTable).set({
    lastCompletedAt: sql`greatest(
      ${invitationReconciliationStateTable.lastCompletedAt},
      ${completedAt}
    )`,
    updatedAt: new Date(),
  }).where(eq(
    invitationReconciliationStateTable.key,
    invitationReconciliationStateKey,
  ));
  await persistSharedRunEvent(event);
}

export async function getInvitationReconciliationHealth(): Promise<InvitationReconciliationHealth> {
  await ensureSharedReconciliationState();
  const [shared] = await db.select().from(invitationReconciliationStateTable)
    .where(eq(
      invitationReconciliationStateTable.key,
      invitationReconciliationStateKey,
    ))
    .limit(1);
  if (!shared) throw new Error("Status rekonsiliasi bersama tidak tersedia");

  const completionStaleAfterMs = reconciliationHealth.completionStaleAfterMs;
  const baseline = shared.lastCompletedAt ?? shared.monitoringStartedAt;
  const completionOverdue = completionStaleAfterMs !== null
    && Date.now() - baseline.getTime() >= completionStaleAfterMs;
  return {
    status: completionOverdue || shared.consecutiveFailures > 0
      ? "DEGRADED"
      : "HEALTHY",
    consecutiveFailures: shared.consecutiveFailures,
    lastFailureAt: shared.lastFailureAt?.toISOString() ?? null,
    lastSuccessAt: shared.lastSuccessAt?.toISOString() ?? null,
    lastCompletedAt: shared.lastCompletedAt?.toISOString() ?? null,
    completionOverdue,
    completionStaleAfterMs,
    lastRun: (shared.lastRun as InvitationReconciliationRunEvent | null) ?? {
      outcome: "NEVER_RUN",
      occurredAt: null,
    },
  };
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
const replacementRevokeFailureAction =
  "KEGAGALAN PARSIAL KOMPENSASI KIRIM ULANG UNDANGAN";
export const scheduledReconciliationLockName =
  "api-server:scheduled-invitation-reconciliation";

export async function reconcileInvitationFromClerk(
  invitation: typeof staffInvitationsTable.$inferSelect,
  clerkState: ClerkInvitationState,
  actor: ReconciliationActor,
  reason: InvitationReconciliationReason,
  transactionHooks: InvitationReconciliationTransactionHooks = {},
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
    await transactionHooks.afterStatusUpdate?.();

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

  if (dependencies.revokeClerkInvitation) {
    const partialFailures = await db.select().from(auditLogsTable)
      .where(and(
        eq(auditLogsTable.action, replacementRevokeFailureAction),
        sql`${auditLogsTable.metadata}->>'reconciliationRequired' = 'true'`,
      ));
    for (const partialFailure of partialFailures) {
      const metadata = partialFailure.metadata;
      if (
        metadata?.reconciliationRequired !== true
        || typeof metadata.replacementClerkInvitationId !== "string"
      ) {
        continue;
      }
      try {
        const clerkState = await dependencies.getClerkInvitation(
          metadata.replacementClerkInvitationId,
        );
        const clerkStatus = clerkState.status.toLowerCase();
        if (!inactiveClerkStatuses.has(clerkStatus)) {
          await dependencies.revokeClerkInvitation(
            metadata.replacementClerkInvitationId,
          );
        }
        await db.update(auditLogsTable).set({
          metadata: {
            ...metadata,
            reconciliationRequired: false,
            reconciliationOutcome: inactiveClerkStatuses.has(clerkStatus)
              ? "ALREADY_INACTIVE"
              : "REVOKED",
            clerkStatusBeforeReconciliation: clerkStatus,
            reconciledAt: new Date().toISOString(),
          },
        }).where(and(
          eq(auditLogsTable.id, partialFailure.id),
          sql`${auditLogsTable.metadata}->>'reconciliationRequired' = 'true'`,
        ));
        checked += 1;
        updated += 1;
      } catch (error) {
        failed += 1;
        const [invitation] = partialFailure.entityId
          ? await db.select().from(staffInvitationsTable)
            .where(eq(staffInvitationsTable.id, partialFailure.entityId)).limit(1)
          : [];
        if (invitation) dependencies.onError?.(error, invitation);
      }
    }
  }

  if (failed > 0) {
    recordReconciliationFailure();
    await persistSharedReconciliationFailure(new Date());
  } else {
    recordReconciliationSuccess();
    await persistSharedReconciliationSuccess(new Date());
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
    await persistSharedRunEvent(skippedEvent);
    dependencies.onRunEvent?.(skippedEvent);
    if (dependencies.alerting) {
      evaluateReconciliationCompletionFreshness(
        dependencies.alerting.completionStaleAfterMs,
      );
      await updateInvitationReconciliationAlert(
        dependencies.alerting,
        reconciliationHealth,
      );
    }
    return { skipped: true as const };
  }
  const completedEvent: InvitationReconciliationRunEvent = {
    outcome: "COMPLETED",
    occurredAt: runningEvent.occurredAt,
    ...result.value,
  };
  const completedAt = new Date();
  reconciliationHealth = { ...reconciliationHealth, lastRun: completedEvent };
  recordReconciliationCompletion(completedAt.toISOString());
  await persistSharedReconciliationCompletion(completedEvent, completedAt);
  if (dependencies.alerting) {
    reconciliationHealth = {
      ...reconciliationHealth,
      status: reconciliationHealth.consecutiveFailures > 0 ? "DEGRADED" : "HEALTHY",
      completionOverdue: false,
      completionStaleAfterMs: dependencies.alerting.completionStaleAfterMs,
    };
  }
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
  let stopping = false;
  let activeRun: Promise<void> | null = null;
  let alertUpdate = Promise.resolve();

  const checkCompletionFreshness = () => {
    if (!dependencies.alerting) return alertUpdate;
    alertUpdate = alertUpdate.then(async () => {
      if (stopping) return;
      evaluateReconciliationCompletionFreshness(
        dependencies.alerting!.completionStaleAfterMs,
      );
      await updateInvitationReconciliationAlert(
        dependencies.alerting,
        reconciliationHealth,
      );
    });
    return alertUpdate;
  };

  const run = async () => {
    if (stopping) return;
    if (running) {
      await checkCompletionFreshness();
      return;
    }
    running = true;
    const runStartedAt = new Date().toISOString();
    activeRun = (async () => {
      try {
        await runScheduledInvitationReconciliation(dependencies);
      } catch (error) {
        recordReconciliationFailure();
        const failedEvent: InvitationReconciliationRunEvent = {
          outcome: "FAILED",
          occurredAt: runStartedAt,
        };
        reconciliationHealth = { ...reconciliationHealth, lastRun: failedEvent };
        await persistSharedReconciliationFailure(new Date(failedEvent.occurredAt));
        await persistSharedRunEvent(failedEvent);
        dependencies.onRunEvent?.(failedEvent);
        dependencies.onRunError?.(error);
        await updateInvitationReconciliationAlert(
          dependencies.alerting,
          reconciliationHealth,
        );
      } finally {
        running = false;
      }
    })();
    try {
      await activeRun;
    } finally {
      activeRun = null;
    }
  };

  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  if (options.runImmediately ?? true) void run();

  return {
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      await activeRun;
      await alertUpdate;
    },
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

export async function recordReplacementRevokePartialFailure(
  invitation: typeof staffInvitationsTable.$inferSelect,
  replacementClerkInvitationId: string,
  actor: ReconciliationActor,
  persistenceError: unknown,
  revokeError: unknown,
) {
  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  await db.insert(auditLogsTable).values({
    id: randomUUID(),
    action: replacementRevokeFailureAction,
    entity: "Undangan",
    entityId: invitation.id,
    detail: `${invitation.displayName} · penyimpanan resend dan pembatalan undangan pengganti gagal`,
    user: actor.displayName,
    actorUserId: actor.userId,
    actorRole: actor.role,
    tone: "warning",
    metadata: {
      operation: "RESEND_INVITATION_COMPENSATION",
      previousClerkInvitationId: invitation.clerkInvitationId,
      replacementClerkInvitationId,
      erpOutcome: "FAILED",
      clerkCompensationOutcome: "FAILED",
      persistenceError: errorMessage(persistenceError),
      revokeError: errorMessage(revokeError),
      reconciliationRequired: true,
    },
  });
}