import { clerkClient, getAuth } from "@clerk/express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db, projectAssignmentsTable, staffInvitationProjectsTable, staffInvitationsTable, userRolesTable } from "@workspace/db";
import { isRole, roleCanAccessProject, roleHasPermission, rolePermissions, roles, type Role } from "./access-policy";

export { roles, type Role } from "./access-policy";

export type AccessContext = {
  userId: string;
  displayName: string;
  role: Role;
  assignedProjectIds: string[];
  permissions: string[];
};

declare global {
  namespace Express {
    interface Request { access?: AccessContext }
  }
}

function displayNameFromClaims(claims: Record<string, unknown> | null | undefined) {
  const first = typeof claims?.first_name === "string" ? claims.first_name : "";
  const last = typeof claims?.last_name === "string" ? claims.last_name : "";
  return `${first} ${last}`.trim() || "Pengguna ERP";
}

export async function requireAccess(req: Request, res: Response, next: NextFunction) {
  const auth = getAuth(req);
  const userId = auth.userId;
  if (!userId) {
    res.status(401).json({ error: "Silakan masuk untuk mengakses data ERP" });
    return;
  }
  let [user] = await db.select().from(userRolesTable).where(eq(userRolesTable.userId, userId)).limit(1);
  if (!user) {
    const clerkUser = await clerkClient.users.getUser(userId);
    const clerkDisplayName = `${clerkUser.firstName ?? ""} ${clerkUser.lastName ?? ""}`.trim()
      || clerkUser.primaryEmailAddress?.emailAddress
      || displayNameFromClaims(auth.sessionClaims as Record<string, unknown>);
    const verifiedEmails = clerkUser.emailAddresses
      .filter((item) => item.verification?.status === "verified")
      .map((item) => item.emailAddress.toLowerCase());
    [user] = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp-access-provisioning'))`);
      const [existing] = await tx.select().from(userRolesTable).where(eq(userRolesTable.userId, userId)).limit(1);
      if (existing) return [existing];
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(userRolesTable);
      const fallbackRole = count === 0 ? "DIRECTOR" : "UNASSIGNED";
      const [invitation] = verifiedEmails.length ? await tx.select().from(staffInvitationsTable)
        .where(and(
          inArray(staffInvitationsTable.email, verifiedEmails),
          eq(staffInvitationsTable.status, "PENDING"),
          sql`${staffInvitationsTable.expiresAt} > now()`,
        )).orderBy(desc(staffInvitationsTable.createdAt)).limit(1) : [];
      const [created] = await tx.insert(userRolesTable).values({
        userId,
        role: invitation?.role ?? fallbackRole,
        displayName: invitation?.displayName ?? clerkDisplayName,
      }).returning();
      if (invitation) {
        const [claimed] = await tx.update(staffInvitationsTable)
          .set({ status: "ACCEPTED", acceptedAt: new Date(), acceptedUserId: userId })
          .where(and(
            eq(staffInvitationsTable.id, invitation.id),
            eq(staffInvitationsTable.status, "PENDING"),
            sql`${staffInvitationsTable.expiresAt} > now()`,
          )).returning();
        if (!claimed) throw new Error("Undangan tidak dapat diklaim");
        const prepared = await tx.select({ projectId: staffInvitationProjectsTable.projectId })
          .from(staffInvitationProjectsTable).where(eq(staffInvitationProjectsTable.invitationId, invitation.id));
        if (prepared.length) await tx.insert(projectAssignmentsTable).values(prepared.map(({ projectId }) => ({ userId, projectId })));
      }
      return [created];
    });
    if (!user) [user] = await db.select().from(userRolesTable).where(eq(userRolesTable.userId, userId)).limit(1);
  }
  if (!user || !isRole(user.role)) {
    res.status(403).json({ error: "Akun menunggu Director menetapkan jabatan dan proyek" });
    return;
  }
  const assigned = await db.select({ projectId: projectAssignmentsTable.projectId })
    .from(projectAssignmentsTable)
    .where(eq(projectAssignmentsTable.userId, userId));
  const role = user.role;
  req.access = { userId, displayName: user.displayName, role, assignedProjectIds: assigned.map((item) => item.projectId), permissions: [...rolePermissions[role]] };
  next();
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.access || !roleHasPermission(req.access.role, permission)) {
      res.status(403).json({ error: "Jabatan Anda tidak memiliki hak untuk tindakan ini" });
      return;
    }
    next();
  };
}

export function canAccessProject(req: Request, projectId: string) {
  return Boolean(req.access && roleCanAccessProject(req.access.role, req.access.assignedProjectIds, projectId));
}

export async function hasProjectAssignment(userId: string, projectId: string) {
  const [assignment] = await db.select().from(projectAssignmentsTable)
    .where(and(eq(projectAssignmentsTable.userId, userId), eq(projectAssignmentsTable.projectId, projectId))).limit(1);
  return Boolean(assignment);
}