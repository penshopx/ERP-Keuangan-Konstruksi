import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import { auditLogsTable, db, invoicesTable, projectAssignmentsTable, projectsTable, userRolesTable } from "@workspace/db";
import {
  DecideInvoiceBody,
  DecideInvoiceParams,
  DecideInvoiceResponse,
  GetCurrentUserResponse,
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