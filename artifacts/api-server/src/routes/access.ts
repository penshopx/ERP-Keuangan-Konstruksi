import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { clerkClient } from "@clerk/express";
import { and, eq, inArray, sql } from "drizzle-orm";
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
  UpdateAccessUserBody,
  UpdateAccessUserParams,
  UpdateAccessUserResponse,
} from "@workspace/api-zod";
import { canAccessProject, requirePermission } from "../middlewares/access";

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
  const invitations = (await db.select().from(staffInvitationsTable))
    .filter((invite) => invite.status !== "ACCEPTED");
  const projects = await db.select().from(staffInvitationProjectsTable);
  const now = new Date();
  res.json(ListAccessInvitationsResponse.parse(invitations.map((invite) => ({
    id: invite.id,
    email: invite.email,
    displayName: invite.displayName,
    role: invite.role,
    assignedProjectIds: projects.filter((item) => item.invitationId === invite.id).map((item) => item.projectId),
    status: invite.status === "EXPIRED" || invite.expiresAt <= now ? "EXPIRED" : "PENDING",
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
  }))));
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
    const clerkInvitation = await clerkClient.invitations.createInvitation({
      emailAddress: email,
      expiresInDays: 30,
      ignoreExisting: true,
      publicMetadata: { source: "construction-erp" },
    });
    createdClerkInvitationId = clerkInvitation.id;
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
      await clerkClient.invitations.revokeInvitation(createdClerkInvitationId).catch(() => undefined);
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

export default router;