import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { clerkClient } from "@clerk/express";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { auditLogsTable, db, invoicesTable, projectAssignmentsTable, projectsTable, staffInvitationProjectsTable, staffInvitationsTable, userRolesTable } from "@workspace/db";
import {
  DecideInvoiceBody,
  DecideInvoiceParams,
  DecideInvoiceResponse,
  GetCurrentUserResponse,
  CreateAccessInvitationBody,
  CreateAccessInvitationResponse,
  ListAccessInvitationsResponse,
  ListAccessUsersResponse,
  ResendAccessInvitationParams,
  ResendAccessInvitationResponse,
  RevokeAccessInvitationParams,
  RevokeAccessInvitationResponse,
  UpdateAccessUserBody,
  UpdateAccessUserParams,
  UpdateAccessUserResponse,
} from "@workspace/api-zod";
import { canAccessProject, requirePermission } from "../middlewares/access";
import {
  getLastSuccessfulClerkVerificationAt,
  reconcileInvitationFromClerk,
  recordInvitationPartialFailure,
  recordSuccessfulClerkVerification,
  type ClerkInvitationState,
} from "../lib/invitation-reconciliation";
import { logger } from "../lib/logger";

export type AccessRouterDependencies = {
  createClerkInvitation: typeof clerkClient.invitations.createInvitation;
  revokeClerkInvitation: typeof clerkClient.invitations.revokeInvitation;
  getClerkInvitation: (invitationId: string) => Promise<ClerkInvitationState>;
};

export async function getClerkInvitationState(
  invitationId: string,
): Promise<ClerkInvitationState> {
  for (const status of ["pending", "accepted", "revoked", "expired"] as const) {
    const result = await clerkClient.invitations.getInvitationList({
      query: invitationId,
      status,
      limit: 1,
    });
    const invitation = result.data.find(({ id }) => id === invitationId);
    if (invitation) return { status: invitation.status };
  }
  throw new Error(`Undangan Clerk ${invitationId} tidak ditemukan`);
}

export type AccessPersistenceHooks = {
  beforeInvitationInsert?: (clerkInvitationId: string) => Promise<void>;
  afterClerkInvitationRevoked?: (clerkInvitationId: string) => Promise<void>;
};

const serializeInvitation = (
  invitation: typeof staffInvitationsTable.$inferSelect,
  assignedProjectIds: string[],
  now = new Date(),
) => ({
  id: invitation.id,
  email: invitation.email,
  displayName: invitation.displayName,
  role: invitation.role,
  assignedProjectIds,
  status: invitation.status === "REVOKED"
    ? "REVOKED"
    : invitation.status === "EXPIRED" || invitation.expiresAt <= now
      ? "EXPIRED"
      : "PENDING",
  expiresAt: invitation.expiresAt.toISOString(),
  createdAt: invitation.createdAt.toISOString(),
});

export function createAccessRouter(
  dependencies: AccessRouterDependencies = {
    createClerkInvitation: clerkClient.invitations.createInvitation.bind(clerkClient.invitations),
    revokeClerkInvitation: clerkClient.invitations.revokeInvitation.bind(clerkClient.invitations),
    getClerkInvitation: getClerkInvitationState,
  },
  hooks: AccessPersistenceHooks = {},
): IRouter {
const router: IRouter = Router();

router.get("/me", (req, res) => {
  res.json(GetCurrentUserResponse.parse(req.access));
});

router.get("/access/users", async (req, res) => {
  if (req.access?.role !== "DIRECTOR") {
    res.status(403).json({ error: "Hanya Director yang dapat mengelola hak akses" });
    return;
  }
  const users = await db.select().from(userRolesTable);
  const assignments = await db.select().from(projectAssignmentsTable);
  res.json(ListAccessUsersResponse.parse(users.map((user) => ({
    userId: user.userId,
    displayName: user.displayName,
    role: user.role,
    assignedProjectIds: assignments.filter((item) => item.userId === user.userId).map((item) => item.projectId),
  }))));
});

router.get("/access/invitations", async (req, res) => {
  if (req.access?.role !== "DIRECTOR") {
    res.status(403).json({ error: "Hanya Director yang dapat melihat undangan" });
    return;
  }
  const storedInvitations = (await db.select().from(staffInvitationsTable))
    .filter((invite) => invite.status !== "ACCEPTED");
  const actor = {
    userId: req.access!.userId,
    displayName: req.access!.displayName,
    role: req.access!.role,
  };
  const requestLogger = req.log ?? logger;
  const verifiedInvitations: typeof storedInvitations = [];
  let verificationFailed = false;
  let clerkInvitationsChecked = 0;
  for (const invitation of storedInvitations) {
    if (invitation.status !== "PENDING") {
      verifiedInvitations.push(invitation);
      continue;
    }
    try {
      const clerkState = await dependencies.getClerkInvitation(invitation.clerkInvitationId);
      clerkInvitationsChecked += 1;
      verifiedInvitations.push(await reconcileInvitationFromClerk(
        invitation,
        clerkState,
        actor,
        "LIST_REFRESH",
      ));
    } catch (error) {
      verificationFailed = true;
      requestLogger.warn({
        err: error,
        invitationId: invitation.id,
        clerkInvitationId: invitation.clerkInvitationId,
      }, "Clerk invitation verification failed; unverified invitation omitted");
    }
  }
  if (!verificationFailed && clerkInvitationsChecked > 0) {
    recordSuccessfulClerkVerification();
  }
  const wasVerificationDegraded = req.app.locals.invitationListVerificationDegraded === true;
  if (verificationFailed && !wasVerificationDegraded) {
    requestLogger.warn({
      event: "clerk_invitation_verification_degraded",
    }, "Clerk invitation verification is degraded");
  } else if (!verificationFailed && wasVerificationDegraded) {
    requestLogger.info({
      event: "clerk_invitation_verification_recovered",
    }, "Clerk invitation verification recovered");
  }
  req.app.locals.invitationListVerificationDegraded = verificationFailed;
  const projects = await db.select().from(staffInvitationProjectsTable);
  const now = new Date();
  res.json(ListAccessInvitationsResponse.parse({
    invitations: verifiedInvitations.map((invite) => serializeInvitation(
      invite,
      projects.filter((item) => item.invitationId === invite.id).map((item) => item.projectId),
      now,
    )),
    verification: verificationFailed
      ? {
          status: "DEGRADED",
          message: "Sebagian status undangan tidak dapat diverifikasi. Undangan tersebut disembunyikan sementara agar status aktif yang belum pasti tidak ditampilkan.",
          lastSuccessfulVerificationAt: getLastSuccessfulClerkVerificationAt(),
        }
      : {
          status: "VERIFIED",
          message: "Semua status undangan telah diverifikasi.",
          lastSuccessfulVerificationAt: getLastSuccessfulClerkVerificationAt(),
        },
  }));
});

router.post("/access/invitations", async (req, res) => {
  if (req.access?.role !== "DIRECTOR") {
    res.status(403).json({ error: "Hanya Director yang dapat mengundang staf" });
    return;
  }
  const body = CreateAccessInvitationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Data undangan tidak valid" });
    return;
  }
  const email = body.data.email.trim().toLowerCase();
  if (body.data.assignedProjectIds.length > 0) {
    const projects = await db.select({ id: projectsTable.id }).from(projectsTable)
      .where(inArray(projectsTable.id, body.data.assignedProjectIds));
    if (projects.length !== new Set(body.data.assignedProjectIds).size) {
      res.status(400).json({ error: "Salah satu proyek penugasan tidak ditemukan" });
      return;
    }
  }
  let createdClerkInvitationId: string | undefined;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`erp-staff-invite:${email}`}))`);
    const existing = await tx.select().from(staffInvitationsTable)
      .where(and(eq(staffInvitationsTable.email, email), eq(staffInvitationsTable.status, "PENDING"))).limit(1);
    if (existing.some((invite) => invite.expiresAt > new Date())) return { conflict: true } as const;
    await tx.update(staffInvitationsTable).set({ status: "EXPIRED" })
      .where(and(eq(staffInvitationsTable.email, email), eq(staffInvitationsTable.status, "PENDING")));
    const clerkInvitation = await dependencies.createClerkInvitation({
      emailAddress: email,
      expiresInDays: 30,
      ignoreExisting: true,
      publicMetadata: { source: "construction-erp" },
    });
    createdClerkInvitationId = clerkInvitation.id;
    await hooks.beforeInvitationInsert?.(clerkInvitation.id);
    const id = randomUUID();
    const createdAt = new Date(clerkInvitation.createdAt);
    const expiresAt = new Date(createdAt.getTime() + 30 * 86_400_000);
    await tx.insert(staffInvitationsTable).values({
      id, clerkInvitationId: clerkInvitation.id, email, displayName: body.data.displayName.trim(),
      role: body.data.role, expiresAt, invitedByUserId: req.access!.userId,
    });
    if (body.data.assignedProjectIds.length) {
      await tx.insert(staffInvitationProjectsTable).values(body.data.assignedProjectIds.map((projectId) => ({ invitationId: id, projectId })));
    }
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "STAF DIUNDANG", entity: "Undangan", entityId: id,
      detail: `${body.data.displayName.trim()} · ${email} · ${body.data.role}`, user: req.access!.displayName,
      actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info",
      metadata: { email, role: body.data.role, assignedProjectIds: body.data.assignedProjectIds },
    });
    return { conflict: false, id, createdAt, expiresAt } as const;
  }).catch(async (error) => {
    if (createdClerkInvitationId) {
      await dependencies.revokeClerkInvitation(createdClerkInvitationId).catch(() => undefined);
    }
    throw error;
  });
  if (result.conflict) {
    res.status(409).json({ error: "Undangan aktif untuk email ini sudah ada" });
    return;
  }
  res.status(201).json(CreateAccessInvitationResponse.parse({
    id: result.id, email, displayName: body.data.displayName.trim(), role: body.data.role,
    assignedProjectIds: body.data.assignedProjectIds, status: "PENDING",
    expiresAt: result.expiresAt.toISOString(), createdAt: result.createdAt.toISOString(),
  }));
});

router.post("/access/invitations/:invitationId/revoke", async (req, res) => {
  if (req.access?.role !== "DIRECTOR") {
    res.status(403).json({ error: "Hanya Director yang dapat membatalkan undangan" });
    return;
  }
  const params = RevokeAccessInvitationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Undangan tidak valid" });
    return;
  }
  const [requestedInvitation] = await db.select().from(staffInvitationsTable)
    .where(eq(staffInvitationsTable.id, params.data.invitationId)).limit(1);
  if (!requestedInvitation) {
    res.status(404).json({ error: "Undangan tidak ditemukan" });
    return;
  }
  let revokedInvitation: typeof staffInvitationsTable.$inferSelect | undefined;
  let clerkRevoked = false;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`erp-staff-invite-id:${params.data.invitationId}`}))`);
    const [invitation] = await tx.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, params.data.invitationId)).limit(1);
    if (!invitation) return { outcome: "not-found" } as const;
    if (
      invitation.clerkInvitationId !== requestedInvitation.clerkInvitationId
      || invitation.status !== requestedInvitation.status
      || requestedInvitation.status !== "PENDING"
      || requestedInvitation.expiresAt <= new Date()
    ) {
      return { outcome: "not-pending" } as const;
    }
    await dependencies.revokeClerkInvitation(invitation.clerkInvitationId);
    clerkRevoked = true;
    revokedInvitation = invitation;
    await hooks.afterClerkInvitationRevoked?.(invitation.clerkInvitationId);
    const [updated] = await tx.update(staffInvitationsTable).set({ status: "REVOKED" })
      .where(and(
        eq(staffInvitationsTable.id, invitation.id),
        eq(staffInvitationsTable.status, "PENDING"),
      )).returning();
    if (!updated) throw new Error("Undangan berubah saat pembatalan diproses");
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "UNDANGAN STAF DIBATALKAN", entity: "Undangan", entityId: invitation.id,
      detail: `${invitation.displayName} · ${invitation.email} · ${invitation.role}`, user: req.access!.displayName,
      actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "warning",
      metadata: { email: invitation.email, role: invitation.role, previousStatus: invitation.status },
    });
    const projects = await tx.select({ projectId: staffInvitationProjectsTable.projectId })
      .from(staffInvitationProjectsTable).where(eq(staffInvitationProjectsTable.invitationId, invitation.id));
    return { outcome: "revoked", invitation: updated, projectIds: projects.map(({ projectId }) => projectId) } as const;
  }).catch(async (error) => {
    if (!clerkRevoked || !revokedInvitation) throw error;
    const actor = {
      userId: req.access!.userId,
      displayName: req.access!.displayName,
      role: req.access!.role,
    };
    await recordInvitationPartialFailure(revokedInvitation, actor, error);
    const reconciled = await reconcileInvitationFromClerk(
      revokedInvitation,
      { status: "revoked" },
      actor,
      "PARTIAL_REVOKE_FAILURE",
    );
    const projects = await db.select({ projectId: staffInvitationProjectsTable.projectId })
      .from(staffInvitationProjectsTable)
      .where(eq(staffInvitationProjectsTable.invitationId, revokedInvitation.id));
    return { outcome: "revoked", invitation: reconciled, projectIds: projects.map(({ projectId }) => projectId) } as const;
  });
  if (result.outcome === "not-found") {
    res.status(404).json({ error: "Undangan tidak ditemukan" });
    return;
  }
  if (result.outcome === "not-pending") {
    res.status(409).json({ error: "Hanya undangan tertunda yang dapat dibatalkan" });
    return;
  }
  res.json(RevokeAccessInvitationResponse.parse(serializeInvitation(result.invitation, result.projectIds)));
});

router.post("/access/invitations/:invitationId/resend", async (req, res) => {
  if (req.access?.role !== "DIRECTOR") {
    res.status(403).json({ error: "Hanya Director yang dapat mengirim ulang undangan" });
    return;
  }
  const params = ResendAccessInvitationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Undangan tidak valid" });
    return;
  }
  const [requestedInvitation] = await db.select().from(staffInvitationsTable)
    .where(eq(staffInvitationsTable.id, params.data.invitationId)).limit(1);
  if (!requestedInvitation) {
    res.status(404).json({ error: "Undangan tidak ditemukan" });
    return;
  }
  let createdClerkInvitationId: string | undefined;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`erp-staff-invite-id:${params.data.invitationId}`}))`);
    const [invitation] = await tx.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, params.data.invitationId)).limit(1);
    if (!invitation) return { outcome: "not-found" } as const;
    if (
      invitation.clerkInvitationId !== requestedInvitation.clerkInvitationId
      || invitation.status !== requestedInvitation.status
      || (requestedInvitation.status !== "EXPIRED"
        && !(requestedInvitation.status === "PENDING" && requestedInvitation.expiresAt <= new Date()))
    ) {
      return { outcome: "not-expired" } as const;
    }
    const clerkInvitation = await dependencies.createClerkInvitation({
      emailAddress: invitation.email,
      expiresInDays: 30,
      ignoreExisting: true,
      publicMetadata: { source: "construction-erp" },
    });
    createdClerkInvitationId = clerkInvitation.id;
    const expiresAt = new Date(new Date(clerkInvitation.createdAt).getTime() + 30 * 86_400_000);
    const [updated] = await tx.update(staffInvitationsTable).set({
      clerkInvitationId: clerkInvitation.id,
      status: "PENDING",
      expiresAt,
    }).where(and(
      eq(staffInvitationsTable.id, invitation.id),
      eq(staffInvitationsTable.clerkInvitationId, requestedInvitation.clerkInvitationId),
      or(
        eq(staffInvitationsTable.status, "EXPIRED"),
        and(eq(staffInvitationsTable.status, "PENDING"), sql`${staffInvitationsTable.expiresAt} <= now()`),
      ),
    )).returning();
    if (!updated) throw new Error("Undangan berubah saat pengiriman ulang diproses");
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "UNDANGAN STAF DIKIRIM ULANG", entity: "Undangan", entityId: invitation.id,
      detail: `${invitation.displayName} · ${invitation.email} · ${invitation.role}`, user: req.access!.displayName,
      actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info",
      metadata: {
        email: invitation.email,
        role: invitation.role,
        previousStatus: invitation.status,
        previousExpiresAt: invitation.expiresAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    });
    const projects = await tx.select({ projectId: staffInvitationProjectsTable.projectId })
      .from(staffInvitationProjectsTable).where(eq(staffInvitationProjectsTable.invitationId, invitation.id));
    return { outcome: "resent", invitation: updated, projectIds: projects.map(({ projectId }) => projectId) } as const;
  }).catch(async (error) => {
    if (createdClerkInvitationId) {
      await dependencies.revokeClerkInvitation(createdClerkInvitationId).catch(() => undefined);
    }
    throw error;
  });
  if (result.outcome === "not-found") {
    res.status(404).json({ error: "Undangan tidak ditemukan" });
    return;
  }
  if (result.outcome === "not-expired") {
    res.status(409).json({ error: "Hanya undangan kedaluwarsa yang dapat dikirim ulang" });
    return;
  }
  res.json(ResendAccessInvitationResponse.parse(serializeInvitation(result.invitation, result.projectIds)));
});

router.put("/access/users/:userId", async (req, res) => {
  if (req.access?.role !== "DIRECTOR") {
    res.status(403).json({ error: "Hanya Director yang dapat mengelola hak akses" });
    return;
  }
  const params = UpdateAccessUserParams.safeParse(req.params);
  const body = UpdateAccessUserBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Konfigurasi hak akses tidak valid" });
    return;
  }
  const [targetUser] = await db.select().from(userRolesTable).where(eq(userRolesTable.userId, params.data.userId)).limit(1);
  if (!targetUser) {
    res.status(404).json({ error: "Pengguna belum pernah masuk ke ERP" });
    return;
  }
  if (targetUser.role === "DIRECTOR" && body.data.role !== "DIRECTOR") {
    const directors = await db.select({ userId: userRolesTable.userId }).from(userRolesTable).where(eq(userRolesTable.role, "DIRECTOR"));
    if (directors.length === 1) {
      res.status(409).json({ error: "Minimal satu Director harus tetap aktif" });
      return;
    }
  }
  if (body.data.assignedProjectIds.length > 0) {
    const projects = await db.select({ id: projectsTable.id }).from(projectsTable)
      .where(inArray(projectsTable.id, body.data.assignedProjectIds));
    if (projects.length !== new Set(body.data.assignedProjectIds).size) {
      res.status(400).json({ error: "Salah satu proyek penugasan tidak ditemukan" });
      return;
    }
  }
  await db.transaction(async (tx) => {
    await tx.update(userRolesTable).set({ role: body.data.role, displayName: body.data.displayName })
      .where(eq(userRolesTable.userId, params.data.userId));
    await tx.delete(projectAssignmentsTable).where(eq(projectAssignmentsTable.userId, params.data.userId));
    if (body.data.assignedProjectIds.length > 0) {
      await tx.insert(projectAssignmentsTable).values(body.data.assignedProjectIds.map((projectId) => ({ userId: params.data.userId, projectId })));
    }
    await tx.insert(auditLogsTable).values({
      id: randomUUID(), action: "HAK AKSES DIPERBARUI", entity: "Pengguna", entityId: params.data.userId,
      detail: `${body.data.displayName} · ${body.data.role}`, user: req.access!.displayName,
      actorUserId: req.access!.userId, actorRole: req.access!.role, tone: "info",
      metadata: { role: body.data.role, assignedProjectIds: body.data.assignedProjectIds },
    });
  });
  res.json(UpdateAccessUserResponse.parse({ userId: params.data.userId, ...body.data }));
});

router.post("/invoices/:invoiceId/decision", requirePermission("invoices:approve"), async (req, res) => {
  const params = DecideInvoiceParams.safeParse(req.params);
  const body = DecideInvoiceBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Keputusan approval tidak valid" });
    return;
  }
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, params.data.invoiceId)).limit(1);
  if (!invoice) {
    res.status(404).json({ error: "Invoice tidak ditemukan" });
    return;
  }
  if (!canAccessProject(req, invoice.projectId)) {
    res.status(403).json({ error: "Invoice berada di luar proyek yang ditugaskan" });
    return;
  }
  const status = body.data.decision === "APPROVE" ? "DISETUJUI" : "DITOLAK";
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(invoicesTable).set({ status }).where(eq(invoicesTable.id, invoice.id)).returning();
    await tx.insert(auditLogsTable).values({
      id: randomUUID(),
      action: status,
      entity: "Invoice",
      entityId: invoice.id,
      detail: `${invoice.number}${body.data.note ? ` · ${body.data.note}` : ""}`,
      user: req.access!.displayName,
      actorUserId: req.access!.userId,
      actorRole: req.access!.role,
      tone: body.data.decision === "APPROVE" ? "success" : "warning",
      metadata: { decision: body.data.decision, note: body.data.note ?? null, previousStatus: invoice.status },
    });
    return row;
  });
  res.json(DecideInvoiceResponse.parse(updated));
});

return router;
}

export default createAccessRouter();