import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import express, { type RequestHandler } from "express";
import { eq, inArray, like, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  pool,
  projectAssignmentsTable,
  projectsTable,
  staffInvitationProjectsTable,
  staffInvitationsTable,
  userRolesTable,
} from "@workspace/db";
import {
  createRequireAccess,
  type AccessContext,
  type AccessProvisioningHooks,
} from "../middlewares/access";
import { createApiRouter } from "./index";
import type { AccessPersistenceHooks, AccessRouterDependencies } from "./access";

const runId = randomUUID();
const prefix = `access-test-${runId}`;
const directorId = `${prefix}-director`;
const projectId = `${prefix}-project`;
const createdClerkIds: string[] = [];
const revokedClerkIds: string[] = [];
const clerkStatuses = new Map<string, string>();
let clerkSequence = 0;

const directorAccess: AccessContext = {
  userId: directorId,
  displayName: "Integration Director",
  role: "DIRECTOR",
  assignedProjectIds: [],
  permissions: [],
};

const clerkDependencies: AccessRouterDependencies = {
  createClerkInvitation: async () => {
    const id = `${prefix}-clerk-${++clerkSequence}`;
    createdClerkIds.push(id);
    clerkStatuses.set(id, "pending");
    return { id, createdAt: Date.now() } as Awaited<ReturnType<AccessRouterDependencies["createClerkInvitation"]>>;
  },
  revokeClerkInvitation: async (id) => {
    revokedClerkIds.push(id);
    clerkStatuses.set(id, "revoked");
    return {} as Awaited<ReturnType<AccessRouterDependencies["revokeClerkInvitation"]>>;
  },
  getClerkInvitation: async (id) => ({ status: clerkStatuses.get(id) ?? "pending" }),
};

function staticAccessMiddleware(): RequestHandler {
  return (req, _res, next) => {
    req.access = directorAccess;
    next();
  };
}

function clerkAccessMiddleware(
  users: Record<string, { email: string; name: string; verified?: boolean }>,
  hooks: AccessProvisioningHooks = {},
) {
  return createRequireAccess({
    getAuth: ((req: express.Request) => ({
      userId: req.header("x-test-user-id") ?? null,
      sessionClaims: {},
    })) as never,
    getUser: (async (userId: string) => {
      const user = users[userId];
      if (!user) throw new Error(`Unknown test user ${userId}`);
      return {
        id: userId,
        firstName: user.name,
        lastName: null,
        primaryEmailAddress: { emailAddress: user.email },
        emailAddresses: [{
          emailAddress: user.email,
          verification: { status: user.verified === false ? "unverified" : "verified" },
        }],
      };
    }) as never,
  }, hooks);
}

async function startServer(
  accessMiddleware: RequestHandler,
  hooks: AccessPersistenceHooks = {},
  accessDependencies: AccessRouterDependencies = clerkDependencies,
) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(accessMiddleware, {}, {}, accessDependencies, hooks));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function inviteBody(email: string, assignedProjectIds: string[] = []) {
  return JSON.stringify({
    email,
    displayName: "Staf Undangan",
    role: "TAX_STAFF",
    assignedProjectIds,
  });
}

async function postInvite(baseUrl: string, email: string, assignedProjectIds: string[] = []) {
  return fetch(`${baseUrl}/access/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: inviteBody(email, assignedProjectIds),
  });
}

async function getMe(baseUrl: string, userId: string) {
  return fetch(`${baseUrl}/me`, { headers: { "x-test-user-id": userId } });
}

async function deleteTestAccessRows() {
  const invitations = await db.select({ id: staffInvitationsTable.id })
    .from(staffInvitationsTable).where(like(staffInvitationsTable.email, `${prefix}%`));
  const invitationIds = invitations.map(({ id }) => id);
  await db.delete(auditLogsTable).where(like(auditLogsTable.entityId, `${prefix}%`));
  if (invitationIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, invitationIds));
    await db.delete(staffInvitationProjectsTable)
      .where(inArray(staffInvitationProjectsTable.invitationId, invitationIds));
    await db.delete(staffInvitationsTable).where(inArray(staffInvitationsTable.id, invitationIds));
  }
  await db.delete(projectAssignmentsTable).where(like(projectAssignmentsTable.userId, `${prefix}%`));
  await db.delete(userRolesTable).where(like(userRolesTable.userId, `${prefix}%`));
}

after(async () => {
  await deleteTestAccessRows();
  await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
  await pool.end();
});

test("staff invitation concurrency and atomic provisioning", async (t) => {
  await db.insert(userRolesTable).values({
    userId: directorId,
    role: "DIRECTOR",
    displayName: "Integration Director",
  });
  await db.insert(projectsTable).values({
    id: projectId,
    code: `AT-${runId.slice(0, 8)}`,
    name: "Access Integration Project",
    owner: "Integration Test",
    contractValue: 1,
    endDate: "2099-12-31",
  });

  await t.test("concurrent first login creates exactly one bootstrap Director", async () => {
    const firstId = `${prefix}-bootstrap-a`;
    const secondId = `${prefix}-bootstrap-b`;
    const server = await startServer(clerkAccessMiddleware({
      [firstId]: { email: `${firstId}@example.test`, name: "Bootstrap A" },
      [secondId]: { email: `${secondId}@example.test`, name: "Bootstrap B" },
    }, {
      countProvisionedUsers: async (tx) => {
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` })
          .from(userRolesTable)
          .where(like(userRolesTable.userId, `${prefix}-bootstrap-%`));
        return count;
      },
    }));
    try {
      const responses = await Promise.all([getMe(server.baseUrl, firstId), getMe(server.baseUrl, secondId)]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 403]);
      const created = await db.select().from(userRolesTable)
        .where(inArray(userRolesTable.userId, [firstId, secondId]));
      assert.equal(created.length, 2);
      assert.equal(created.filter(({ role }) => role === "DIRECTOR").length, 1);
      assert.equal(created.filter(({ role }) => role === "UNASSIGNED").length, 1);
    } finally {
      await server.close();
    }
  });

  await t.test("only one active invitation can be created for an email", async () => {
    const email = `${prefix}-duplicate@example.test`;
    const before = createdClerkIds.length;
    const server = await startServer(staticAccessMiddleware());
    try {
      const responses = await Promise.all([
        postInvite(server.baseUrl, email),
        postInvite(server.baseUrl, email),
      ]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409]);
      assert.equal(createdClerkIds.length - before, 1);
      const stored = await db.select().from(staffInvitationsTable)
        .where(eq(staffInvitationsTable.email, email));
      assert.equal(stored.filter(({ status }) => status === "PENDING").length, 1);
    } finally {
      await server.close();
    }
  });

  await t.test("two concurrent claims grant the invited rights to only one user", async () => {
    const email = `${prefix}-claim@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email, [projectId]);
    assert.equal(created.status, 201);
    await creator.close();

    const firstId = `${prefix}-claim-a`;
    const secondId = `${prefix}-claim-b`;
    const server = await startServer(clerkAccessMiddleware({
      [firstId]: { email, name: "Claim A" },
      [secondId]: { email, name: "Claim B" },
    }));
    try {
      await Promise.all([getMe(server.baseUrl, firstId), getMe(server.baseUrl, secondId)]);
      const users = await db.select().from(userRolesTable)
        .where(inArray(userRolesTable.userId, [firstId, secondId]));
      assert.equal(users.filter(({ role }) => role === "TAX_STAFF").length, 1);
      assert.equal(users.filter(({ role }) => role === "UNASSIGNED").length, 1);
      const [invitation] = await db.select().from(staffInvitationsTable)
        .where(eq(staffInvitationsTable.email, email));
      assert.equal(invitation.status, "ACCEPTED");
      assert.ok([firstId, secondId].includes(invitation.acceptedUserId ?? ""));
    } finally {
      await server.close();
    }
  });

  await t.test("an unverified Clerk email cannot claim an active invitation", async () => {
    const email = `${prefix}-unverified@example.test`;
    const userId = `${prefix}-unverified-user`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email, [projectId]);
    assert.equal(created.status, 201);
    await creator.close();

    const server = await startServer(clerkAccessMiddleware({
      [userId]: { email, name: "Unverified User", verified: false },
    }));
    try {
      const response = await getMe(server.baseUrl, userId);
      assert.equal(response.status, 403);
    } finally {
      await server.close();
    }

    const [user] = await db.select().from(userRolesTable)
      .where(eq(userRolesTable.userId, userId));
    assert.equal(user.role, "UNASSIGNED");
    assert.equal((await db.select().from(projectAssignmentsTable)
      .where(eq(projectAssignmentsTable.userId, userId))).length, 0);
    const [invitation] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.email, email));
    assert.equal(invitation.status, "PENDING");
    assert.equal(invitation.acceptedUserId, null);
  });

  await t.test("an expired invitation cannot be claimed by a verified Clerk email", async () => {
    const email = `${prefix}-expired@example.test`;
    const userId = `${prefix}-expired-user`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email, [projectId]);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    await db.update(staffInvitationsTable).set({
      status: "EXPIRED",
      expiresAt: new Date(Date.now() - 1_000),
    }).where(eq(staffInvitationsTable.id, invitation.id));

    const server = await startServer(clerkAccessMiddleware({
      [userId]: { email, name: "Expired User" },
    }));
    try {
      const response = await getMe(server.baseUrl, userId);
      assert.equal(response.status, 403);
    } finally {
      await server.close();
    }

    const [user] = await db.select().from(userRolesTable)
      .where(eq(userRolesTable.userId, userId));
    assert.equal(user.role, "UNASSIGNED");
    assert.equal((await db.select().from(projectAssignmentsTable)
      .where(eq(projectAssignmentsTable.userId, userId))).length, 0);
    const [storedInvitation] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(storedInvitation.status, "EXPIRED");
    assert.equal(storedInvitation.acceptedUserId, null);
  });

  await t.test("database failure revokes the newly-created Clerk invitation", async () => {
    const email = `${prefix}-rollback@example.test`;
    const server = await startServer(staticAccessMiddleware(), {
      beforeInvitationInsert: async () => {
        throw new Error("Injected invitation persistence failure");
      },
    });
    try {
      const response = await postInvite(server.baseUrl, email);
      assert.equal(response.status, 500);
      const clerkId = createdClerkIds.at(-1);
      assert.ok(clerkId);
      assert.ok(revokedClerkIds.includes(clerkId));
      const stored = await db.select().from(staffInvitationsTable)
        .where(eq(staffInvitationsTable.email, email));
      assert.equal(stored.length, 0);
    } finally {
      await server.close();
    }
  });

  await t.test("partial revoke failure is reconciled and audited", async () => {
    const email = `${prefix}-reconcile@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    const failing = await startServer(staticAccessMiddleware(), {
      afterClerkInvitationRevoked: async () => {
        throw new Error("Injected ERP persistence failure after Clerk revoke");
      },
    });
    try {
      const response = await fetch(`${failing.baseUrl}/access/invitations/${invitation.id}/revoke`, {
        method: "POST",
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { status: string }).status, "REVOKED");
    } finally {
      await failing.close();
    }

    const [stored] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(stored.status, "REVOKED");
    const audits = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id));
    assert.ok(audits.some(({ action, metadata }) =>
      action === "KEGAGALAN PARSIAL PEMBATALAN UNDANGAN"
      && metadata?.clerkOutcome === "REVOKED"
      && metadata?.erpOutcome === "FAILED"));
    assert.ok(audits.some(({ action, metadata }) =>
      action === "STATUS UNDANGAN DIREKONSILIASI"
      && metadata?.sourceOfTruth === "CLERK"
      && metadata?.outcome === "UPDATED"));
  });

  await t.test("concurrent revoke and resend allow only the winning transition", async () => {
    const email = `${prefix}-revoke-resend-race@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    const [storedBefore] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    const expiredAt = new Date(Date.now() - 1_000);
    await db.update(staffInvitationsTable).set({
      status: "EXPIRED",
      expiresAt: expiredAt,
    }).where(eq(staffInvitationsTable.id, invitation.id));
    clerkStatuses.set(storedBefore.clerkInvitationId, "expired");

    let resendStarted!: () => void;
    let releaseResend!: () => void;
    const resendStartedPromise = new Promise<void>((resolve) => {
      resendStarted = resolve;
    });
    const resendCanFinish = new Promise<void>((resolve) => {
      releaseResend = resolve;
    });
    const gatedDependencies: AccessRouterDependencies = {
      ...clerkDependencies,
      createClerkInvitation: async (params) => {
        resendStarted();
        await resendCanFinish;
        return clerkDependencies.createClerkInvitation(params);
      },
    };
    const beforeCreatedCount = createdClerkIds.length;
    const beforeRevokedCount = revokedClerkIds.length;
    const server = await startServer(staticAccessMiddleware(), {}, gatedDependencies);
    try {
      const resendRequest = fetch(`${server.baseUrl}/access/invitations/${invitation.id}/resend`, {
        method: "POST",
      });
      await resendStartedPromise;
      const revokeRequest = fetch(`${server.baseUrl}/access/invitations/${invitation.id}/revoke`, {
        method: "POST",
      });
      releaseResend();

      const responses = await Promise.all([resendRequest, revokeRequest]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    } finally {
      await server.close();
    }

    const [storedAfter] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(storedAfter.status, "PENDING");
    assert.notEqual(storedAfter.clerkInvitationId, storedBefore.clerkInvitationId);
    assert.equal(createdClerkIds.length - beforeCreatedCount, 1);
    assert.equal(revokedClerkIds.length - beforeRevokedCount, 0);

    const audits = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id));
    const transitionAudits = audits.filter(({ action }) =>
      action === "UNDANGAN STAF DIKIRIM ULANG" || action === "UNDANGAN STAF DIBATALKAN");
    assert.equal(transitionAudits.length, 1);
    assert.equal(transitionAudits[0]?.action, "UNDANGAN STAF DIKIRIM ULANG");
    assert.equal((transitionAudits[0]?.metadata as { previousStatus?: string } | null)?.previousStatus, "EXPIRED");
  });

  await t.test("listing reconciles a Clerk-revoked pending invitation before Director sees it", async () => {
    const email = `${prefix}-list-reconcile@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    const invitation = await created.json() as { id: string };
    const [storedBefore] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    clerkStatuses.set(storedBefore.clerkInvitationId, "revoked");

    try {
      const response = await fetch(`${creator.baseUrl}/access/invitations`);
      assert.equal(response.status, 200);
      const listed = await response.json() as Array<{ id: string; status: string }>;
      assert.equal(listed.find(({ id }) => id === invitation.id)?.status, "REVOKED");
    } finally {
      await creator.close();
    }

    const [storedAfter] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(storedAfter.status, "REVOKED");
  });

  await t.test("invited role and projects are applied atomically on first login", async () => {
    const email = `${prefix}-atomic@example.test`;
    const userId = `${prefix}-atomic-user`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email, [projectId]);
    assert.equal(created.status, 201);
    await creator.close();

    const failing = await startServer(clerkAccessMiddleware({
      [userId]: { email, name: "Atomic User" },
    }, {
      beforeProjectAssignmentsInsert: async () => {
        throw new Error("Injected project assignment failure");
      },
    }));
    try {
      assert.equal((await getMe(failing.baseUrl, userId)).status, 500);
    } finally {
      await failing.close();
    }
    assert.equal((await db.select().from(userRolesTable).where(eq(userRolesTable.userId, userId))).length, 0);
    assert.equal((await db.select().from(projectAssignmentsTable).where(eq(projectAssignmentsTable.userId, userId))).length, 0);
    const [pending] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.email, email));
    assert.equal(pending.status, "PENDING");
    assert.equal(pending.acceptedUserId, null);

    const succeeding = await startServer(clerkAccessMiddleware({
      [userId]: { email, name: "Atomic User" },
    }));
    try {
      const response = await getMe(succeeding.baseUrl, userId);
      assert.equal(response.status, 200);
      const body = await response.json() as { role: string; assignedProjectIds: string[] };
      assert.equal(body.role, "TAX_STAFF");
      assert.deepEqual(body.assignedProjectIds, [projectId]);
    } finally {
      await succeeding.close();
    }
  });
});