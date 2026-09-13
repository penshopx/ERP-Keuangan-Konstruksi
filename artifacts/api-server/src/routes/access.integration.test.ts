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
    return { id, createdAt: Date.now() } as Awaited<ReturnType<AccessRouterDependencies["createClerkInvitation"]>>;
  },
  revokeClerkInvitation: async (id) => {
    revokedClerkIds.push(id);
    return {} as Awaited<ReturnType<AccessRouterDependencies["revokeClerkInvitation"]>>;
  },
};

function staticAccessMiddleware(): RequestHandler {
  return (req, _res, next) => {
    req.access = directorAccess;
    next();
  };
}

function clerkAccessMiddleware(
  users: Record<string, { email: string; name: string }>,
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
          verification: { status: "verified" },
        }],
      };
    }) as never,
  }, hooks);
}

async function startServer(
  accessMiddleware: RequestHandler,
  hooks: AccessPersistenceHooks = {},
) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(accessMiddleware, {}, {}, clerkDependencies, hooks));
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