import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  staffInvitationsTable,
} from "@workspace/db";

export type ClerkInvitationState = {
  status: string;
};

type ReconciliationActor = {
  userId: string;
  displayName: string;
  role: string;
};

const inactiveClerkStatuses = new Set(["revoked", "expired"]);

export async function reconcileInvitationFromClerk(
  invitation: typeof staffInvitationsTable.$inferSelect,
  clerkState: ClerkInvitationState,
  actor: ReconciliationActor,
  reason: "LIST_REFRESH" | "PARTIAL_REVOKE_FAILURE",
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