import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express, { type RequestHandler } from "express";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  invitationReconciliationStateTable,
  invoicesTable,
  operationalStateTable,
  pool,
  projectAssignmentsTable,
  projectsTable,
  rabBaselinesTable,
  staffInvitationProjectsTable,
  staffInvitationsTable,
  taxCalculationSnapshotsTable,
  taxRuleVersionsTable,
  userRolesTable,
} from "@workspace/db";
import {
  createRequireAccess,
  type AccessContext,
  type AccessProvisioningHooks,
} from "../middlewares/access";
import { createApiRouter } from "./index";
import type { AccessPersistenceHooks, AccessRouterDependencies } from "./access";
import {
  clerkInvitationVerificationStateKey,
  type InvitationReconciliationAlert,
  getInvitationReconciliationHealth,
  reconcilePendingInvitations,
  runScheduledInvitationReconciliation,
  schedulePendingInvitationReconciliation,
} from "../lib/invitation-reconciliation";
import {
  acquirePersistenceDatabaseSuiteLock,
  describeDatabaseSuiteError,
  releasePersistenceDatabaseSuiteLock,
  runDatabaseSuiteOperation,
  setDatabaseSuitePoolStatementTimeout,
  type DatabaseSuiteLockClient,
} from "../testing/database-suite-lock";
import { getAccessDatabaseSuiteConfig } from "../testing/database-suite-config";

const runId = randomUUID();
const prefix = `access-test-${runId}`;
const directorId = `${prefix}-director`;
const projectId = `${prefix}-project`;
const otherProjectId = `${prefix}-other-project`;
const unassignedId = `${prefix}-unassigned`;
const projectManagerId = `${prefix}-project-manager`;
const siteManagerId = `${prefix}-site-manager`;
const taxStaffId = `${prefix}-tax-staff`;
const financeId = `${prefix}-finance`;
const procurementId = `${prefix}-procurement`;
const createdClerkIds: string[] = [];
const revokedClerkIds: string[] = [];
const clerkStatuses = new Map<string, string>();
let clerkSequence = 0;
let databaseSuiteLockClient: DatabaseSuiteLockClient | undefined;
const {
  suiteName: databaseSuiteName,
  statementTimeoutMs: databaseStatementTimeoutMs,
} = getAccessDatabaseSuiteConfig();

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
  users: Record<string, {
    email: string;
    name: string;
    verified?: boolean;
    emailAddresses?: Array<{ email: string; verified: boolean }>;
  }>,
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
        emailAddresses: (user.emailAddresses ?? [{
          email: user.email,
          verified: user.verified !== false,
        }]).map((email) => ({
          emailAddress: email.email,
          verification: { status: email.verified ? "verified" : "unverified" },
        })),
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
  await db.delete(auditLogsTable).where(like(auditLogsTable.actorUserId, "access-test-%"));
  if (invitationIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, invitationIds));
    await db.delete(staffInvitationProjectsTable)
      .where(inArray(staffInvitationProjectsTable.invitationId, invitationIds));
    await db.delete(staffInvitationsTable).where(inArray(staffInvitationsTable.id, invitationIds));
  }
  await db.delete(projectAssignmentsTable).where(like(projectAssignmentsTable.userId, `${prefix}%`));
  await db.delete(userRolesTable).where(like(userRolesTable.userId, `${prefix}%`));
  const invoices = await db.select({ id: invoicesTable.id }).from(invoicesTable)
    .where(like(invoicesTable.period, `${prefix}%`));
  if (invoices.length) {
    await db.delete(taxCalculationSnapshotsTable)
      .where(inArray(taxCalculationSnapshotsTable.invoiceId, invoices.map(({ id }) => id)));
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoices.map(({ id }) => id)));
  }
  await db.delete(taxRuleVersionsTable).where(like(taxRuleVersionsTable.version, `${prefix}%`));
}

before(async () => {
  setDatabaseSuitePoolStatementTimeout(databaseSuiteName, databaseStatementTimeoutMs);
  await runDatabaseSuiteOperation(async () => {
    databaseSuiteLockClient = await acquirePersistenceDatabaseSuiteLock();
  }, databaseSuiteName, databaseStatementTimeoutMs);
});

after(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    try {
      await deleteTestAccessRows();
      await db.delete(projectsTable).where(inArray(projectsTable.id, [projectId, otherProjectId]));
    } catch (error) {
      cleanupErrors.push(describeDatabaseSuiteError(error, databaseSuiteName, databaseStatementTimeoutMs));
    }
  } finally {
    if (databaseSuiteLockClient) {
      try {
        await releasePersistenceDatabaseSuiteLock(databaseSuiteLockClient);
      } catch (error) {
        cleanupErrors.push(describeDatabaseSuiteError(error, databaseSuiteName, databaseStatementTimeoutMs));
      }
      databaseSuiteLockClient = undefined;
    }
    await pool.end();
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `${databaseSuiteName} cleanup or lock release failed`);
  }
});

test("staff invitation concurrency and atomic provisioning", async (t) => {
  await runDatabaseSuiteOperation(async () => {
  await db.insert(userRolesTable).values({
    userId: directorId,
    role: "DIRECTOR",
    displayName: "Integration Director",
  });
  await db.insert(projectsTable).values([
    {
      id: projectId,
      code: `AT-${runId.slice(0, 8)}`,
      name: "Access Integration Project",
      owner: "Integration Test",
      contractValue: 1,
      endDate: "2099-12-31",
    },
    {
      id: otherProjectId,
      code: `AT-OTHER-${runId.slice(0, 8)}`,
      name: "Other Team Project",
      owner: "Other Integration Team",
      contractValue: 2,
      endDate: "2099-12-31",
    },
  ]);

  await db.insert(userRolesTable).values({
    userId: unassignedId,
    role: "UNASSIGNED",
    displayName: "Integration Unassigned",
  });

  await db.insert(userRolesTable).values([
    {
      userId: projectManagerId,
      role: "PROJECT_MANAGER",
      displayName: "Integration Project Manager",
    },
    {
      userId: siteManagerId,
      role: "SITE_MANAGER",
      displayName: "Integration Site Manager",
    },
    {
      userId: taxStaffId,
      role: "TAX_STAFF",
      displayName: "Integration Tax Staff",
    },
    {
      userId: financeId,
      role: "FINANCE",
      displayName: "Integration Finance",
    },
    {
      userId: procurementId,
      role: "PROCUREMENT",
      displayName: "Integration Procurement",
    },
  ]);
  await db.insert(projectAssignmentsTable).values({
    userId: projectManagerId,
    projectId,
  });

  await t.test("assigned staff mutations follow the production permission matrix", async () => {
    const users = {
      [projectManagerId]: {
        email: `${projectManagerId}@example.test`,
        name: "Integration Project Manager",
      },
      [siteManagerId]: {
        email: `${siteManagerId}@example.test`,
        name: "Integration Site Manager",
      },
      [taxStaffId]: {
        email: `${taxStaffId}@example.test`,
        name: "Integration Tax Staff",
      },
      [financeId]: {
        email: `${financeId}@example.test`,
        name: "Integration Finance",
      },
      [procurementId]: {
        email: `${procurementId}@example.test`,
        name: "Integration Procurement",
      },
    };
    const server = await startServer(clerkAccessMiddleware(users));
    const [supersededFinanceRule] = await db.select().from(taxRuleVersionsTable).where(and(
      eq(taxRuleVersionsTable.serviceType, "JASA_LAIN"),
      isNull(taxRuleVersionsTable.qualification),
      eq(taxRuleVersionsTable.requiresSbu, false),
      eq(taxRuleVersionsTable.supplierPkp, false),
      eq(taxRuleVersionsTable.governmentCollector, false),
      eq(taxRuleVersionsTable.integrated, false),
      isNull(taxRuleVersionsTable.effectiveTo),
    )).limit(1);
    const financeRuleVersion = `${prefix}-finance-rule`;
    const financeInvoicePeriod = `${prefix}-finance-invoice`;
    const headers = (userId: string) => ({
      "content-type": "application/json",
      "x-test-user-id": userId,
    });
    const projectMutation = (
      userId: string,
      name: string,
      status?: "BERJALAN",
      targetProjectId = projectId,
    ) => fetch(
      `${server.baseUrl}/projects/${targetProjectId}`,
      {
        method: "PATCH",
        headers: headers(userId),
        body: JSON.stringify({ name, status }),
      },
    );
    const invoiceMutation = (userId: string, period: string) => fetch(
      `${server.baseUrl}/invoices`,
      {
        method: "POST",
        headers: headers(userId),
        body: JSON.stringify({
          projectId,
          period,
          issuedAt: "2099-01-15",
          dpp: 10_000,
          retentionPercent: 0,
          integrated: false,
          serviceType: "JASA_LAIN",
          qualification: "TIDAK_BERLAKU",
          hasSbu: false,
          supplierPkp: false,
          governmentCollector: false,
        }),
      },
    );
    const taxRuleMutation = (userId: string, version: string) => fetch(
      `${server.baseUrl}/tax/rules`,
      {
        method: "POST",
        headers: headers(userId),
        body: JSON.stringify({
          version,
          effectiveFrom: "2099-01-01",
          regulatorySource: "Integration access matrix",
          serviceType: "JASA_LAIN",
          qualification: null,
          requiresSbu: false,
          supplierPkp: false,
          governmentCollector: false,
          integrated: false,
          dppRateBasisPoints: 10_000,
          ppnRateBasisPoints: 0,
          pphFinalRateBasisPoints: 0,
          pph23RateBasisPoints: 200,
        }),
      },
    );
    const assertForbiddenWithoutDatabaseChanges = async (
      userId: string,
      request: () => Promise<Response>,
      readState: () => Promise<unknown>,
    ) => {
      const beforeState = await readState();
      const beforeAudits = await db.select().from(auditLogsTable)
        .where(eq(auditLogsTable.actorUserId, userId));
      const response = await request();
      assert.equal(response.status, 403);
      assert.deepEqual(await readState(), beforeState);
      assert.deepEqual(
        await db.select().from(auditLogsTable).where(eq(auditLogsTable.actorUserId, userId)),
        beforeAudits,
      );
    };

    try {
      const projectManagerName = `${prefix}-pm-project`;
      assert.equal(
        (await projectMutation(projectManagerId, projectManagerName, "BERJALAN")).status,
        200,
      );
      assert.equal(
        (await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)))[0]?.name,
        projectManagerName,
      );

      const otherProjectName = `${prefix}-pm-other-project`;
      await assertForbiddenWithoutDatabaseChanges(
        projectManagerId,
        () => projectMutation(projectManagerId, otherProjectName, undefined, otherProjectId),
        async () => ({
          project: await db.select().from(projectsTable).where(eq(projectsTable.id, otherProjectId)),
          audits: await db.select().from(auditLogsTable).where(and(
            eq(auditLogsTable.entity, "Proyek"),
            eq(auditLogsTable.entityId, otherProjectId),
          )),
        }),
      );

      const pmInvoicePeriod = `${prefix}-pm-invoice`;
      await assertForbiddenWithoutDatabaseChanges(
        projectManagerId,
        () => invoiceMutation(projectManagerId, pmInvoicePeriod),
        () => db.select().from(invoicesTable).where(eq(invoicesTable.period, pmInvoicePeriod)),
      );
      const pmTaxVersion = `${prefix}-pm-tax`;
      await assertForbiddenWithoutDatabaseChanges(
        projectManagerId,
        () => taxRuleMutation(projectManagerId, pmTaxVersion),
        () => db.select().from(taxRuleVersionsTable).where(eq(taxRuleVersionsTable.version, pmTaxVersion)),
      );

      for (const [userId, label] of [
        [siteManagerId, "site-manager"],
        [procurementId, "procurement"],
      ] as const) {
        const projectName = `${prefix}-${label}-project`;
        await assertForbiddenWithoutDatabaseChanges(
          userId,
          () => projectMutation(userId, projectName),
          () => db.select().from(projectsTable).where(eq(projectsTable.id, projectId)),
        );
        const invoicePeriod = `${prefix}-${label}-invoice`;
        await assertForbiddenWithoutDatabaseChanges(
          userId,
          () => invoiceMutation(userId, invoicePeriod),
          () => db.select().from(invoicesTable).where(eq(invoicesTable.period, invoicePeriod)),
        );
        const taxRuleVersion = `${prefix}-${label}-tax`;
        await assertForbiddenWithoutDatabaseChanges(
          userId,
          () => taxRuleMutation(userId, taxRuleVersion),
          () => db.select().from(taxRuleVersionsTable)
            .where(eq(taxRuleVersionsTable.version, taxRuleVersion)),
        );
      }

      const taxStaffProjectName = `${prefix}-tax-project`;
      await assertForbiddenWithoutDatabaseChanges(
        taxStaffId,
        () => projectMutation(taxStaffId, taxStaffProjectName),
        () => db.select().from(projectsTable).where(eq(projectsTable.id, projectId)),
      );
      const taxStaffInvoicePeriod = `${prefix}-tax-invoice`;
      await assertForbiddenWithoutDatabaseChanges(
        taxStaffId,
        () => invoiceMutation(taxStaffId, taxStaffInvoicePeriod),
        () => db.select().from(invoicesTable).where(eq(invoicesTable.period, taxStaffInvoicePeriod)),
      );
      const taxStaffRuleVersion = `${prefix}-tax-staff-rule`;
      await assertForbiddenWithoutDatabaseChanges(
        taxStaffId,
        () => taxRuleMutation(taxStaffId, taxStaffRuleVersion),
        () => db.select().from(taxRuleVersionsTable)
          .where(eq(taxRuleVersionsTable.version, taxStaffRuleVersion)),
      );

      const financeProjectName = `${prefix}-finance-project`;
      await assertForbiddenWithoutDatabaseChanges(
        financeId,
        () => projectMutation(financeId, financeProjectName),
        () => db.select().from(projectsTable).where(eq(projectsTable.id, projectId)),
      );

      assert.equal((await taxRuleMutation(financeId, financeRuleVersion)).status, 201);
      assert.equal(
        (await db.select().from(taxRuleVersionsTable)
          .where(eq(taxRuleVersionsTable.version, financeRuleVersion))).length,
        1,
      );

      assert.equal((await invoiceMutation(financeId, financeInvoicePeriod)).status, 201);
      const financeInvoices = await db.select().from(invoicesTable)
        .where(eq(invoicesTable.period, financeInvoicePeriod));
      assert.equal(financeInvoices.length, 1);
    } finally {
      const financeInvoices = await db.select({ id: invoicesTable.id }).from(invoicesTable)
        .where(eq(invoicesTable.period, financeInvoicePeriod));
      if (financeInvoices.length) {
        await db.delete(taxCalculationSnapshotsTable)
          .where(inArray(taxCalculationSnapshotsTable.invoiceId, financeInvoices.map(({ id }) => id)));
        await db.delete(invoicesTable)
          .where(inArray(invoicesTable.id, financeInvoices.map(({ id }) => id)));
      }
      await db.delete(taxRuleVersionsTable)
        .where(eq(taxRuleVersionsTable.version, financeRuleVersion));
      if (supersededFinanceRule) {
        await db.update(taxRuleVersionsTable)
          .set({ effectiveTo: supersededFinanceRule.effectiveTo })
          .where(eq(taxRuleVersionsTable.id, supersededFinanceRule.id));
      }
      await server.close();
    }
  });

  await t.test("an unassigned user cannot read protected data endpoints", async () => {
    const server = await startServer(clerkAccessMiddleware({
      [unassignedId]: {
        email: `${unassignedId}@example.test`,
        name: "Integration Unassigned",
      },
    }));
    try {
      const endpoints = ["/projects", "/invoices", "/access/users"];
      const responses = await Promise.all(endpoints.map((endpoint) =>
        fetch(`${server.baseUrl}${endpoint}`, {
          headers: { "x-test-user-id": unassignedId },
        })));

      for (const response of responses) {
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), {
          error: "Akun menunggu Director menetapkan jabatan dan proyek",
        });
      }
    } finally {
      await server.close();
    }
  });

  await t.test("an unassigned user cannot mutate projects, invoices, or administration data", async () => {
    const blockedProjectCode = `${prefix}-blocked-project`;
    const blockedInvitationEmail = `${prefix}-blocked-invitation@example.test`;
    const before = {
      projects: await db.select().from(projectsTable)
        .where(eq(projectsTable.code, blockedProjectCode)),
      invoices: await db.select().from(invoicesTable)
        .where(eq(invoicesTable.projectId, projectId)),
      invitations: await db.select().from(staffInvitationsTable)
        .where(eq(staffInvitationsTable.email, blockedInvitationEmail)),
      audits: await db.select().from(auditLogsTable)
        .where(eq(auditLogsTable.actorUserId, unassignedId)),
      createdClerkInvitationCount: createdClerkIds.length,
    };
    const server = await startServer(clerkAccessMiddleware({
      [unassignedId]: {
        email: `${unassignedId}@example.test`,
        name: "Integration Unassigned",
      },
    }));

    try {
      const requests = [
        fetch(`${server.baseUrl}/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-user-id": unassignedId,
          },
          body: JSON.stringify({
            code: blockedProjectCode,
            name: "Blocked Project",
            owner: "Blocked Owner",
            contractValue: 10_000,
            endDate: "2099-12-31",
          }),
        }),
        fetch(`${server.baseUrl}/invoices`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-user-id": unassignedId,
          },
          body: JSON.stringify({
            projectId,
            period: "2099-01",
            issuedAt: "2099-01-01",
            dpp: 10_000,
            retentionPercent: 0,
            integrated: false,
            serviceType: "JASA_LAIN",
            qualification: "TIDAK_BERLAKU",
            hasSbu: false,
            supplierPkp: true,
            governmentCollector: false,
          }),
        }),
        fetch(`${server.baseUrl}/access/invitations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-user-id": unassignedId,
          },
          body: inviteBody(blockedInvitationEmail, [projectId]),
        }),
      ];
      const responses = await Promise.all(requests);

      for (const response of responses) {
        assert.equal(response.status, 403);
      }
    } finally {
      await server.close();
    }

    const after = {
      projects: await db.select().from(projectsTable)
        .where(eq(projectsTable.code, blockedProjectCode)),
      invoices: await db.select().from(invoicesTable)
        .where(eq(invoicesTable.projectId, projectId)),
      invitations: await db.select().from(staffInvitationsTable)
        .where(eq(staffInvitationsTable.email, blockedInvitationEmail)),
      audits: await db.select().from(auditLogsTable)
        .where(eq(auditLogsTable.actorUserId, unassignedId)),
      createdClerkInvitationCount: createdClerkIds.length,
    };
    assert.deepEqual(after, before);

    const blockedProjects = await db.select({ id: projectsTable.id }).from(projectsTable)
      .where(eq(projectsTable.code, blockedProjectCode));
    assert.equal(blockedProjects.length, 0);
    assert.equal((await db.select().from(rabBaselinesTable)
      .where(inArray(rabBaselinesTable.projectId, blockedProjects.map(({ id }) => id)))).length, 0);

    const blockedInvoices = await db.select({ id: invoicesTable.id }).from(invoicesTable)
      .where(eq(invoicesTable.projectId, projectId));
    assert.equal((await db.select().from(taxCalculationSnapshotsTable)
      .where(inArray(taxCalculationSnapshotsTable.invoiceId, blockedInvoices.map(({ id }) => id)))).length, 0);
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

  await t.test("a matching unverified Clerk email cannot claim an invitation when another email is verified", async () => {
    const email = `${prefix}-unverified@example.test`;
    const userId = `${prefix}-unverified-user`;
    const verifiedEmail = `${prefix}-verified-other@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email, [projectId]);
    assert.equal(created.status, 201);
    await creator.close();

    const server = await startServer(clerkAccessMiddleware({
      [userId]: {
        email,
        name: "Unverified User",
        emailAddresses: [
          { email: verifiedEmail, verified: true },
          { email, verified: false },
        ],
      },
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

  await t.test("a verified secondary Clerk email claims an invitation exactly once when the primary email differs", async () => {
    const invitedEmail = `${prefix}-verified-secondary@example.test`;
    const primaryEmail = `${prefix}-different-primary@example.test`;
    const userId = `${prefix}-verified-secondary-user`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, invitedEmail, [projectId]);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    const server = await startServer(clerkAccessMiddleware({
      [userId]: {
        email: primaryEmail,
        name: "Verified Secondary User",
        emailAddresses: [
          { email: primaryEmail, verified: true },
          { email: invitedEmail, verified: true },
        ],
      },
    }));
    try {
      const firstResponse = await getMe(server.baseUrl, userId);
      assert.equal(firstResponse.status, 200);
      const firstBody = await firstResponse.json() as {
        role: string;
        assignedProjectIds: string[];
      };
      assert.equal(firstBody.role, "TAX_STAFF");
      assert.deepEqual(firstBody.assignedProjectIds, [projectId]);

      const secondResponse = await getMe(server.baseUrl, userId);
      assert.equal(secondResponse.status, 200);
    } finally {
      await server.close();
    }

    const roles = await db.select().from(userRolesTable)
      .where(eq(userRolesTable.userId, userId));
    assert.equal(roles.length, 1);
    assert.equal(roles[0]?.role, "TAX_STAFF");

    const assignments = await db.select().from(projectAssignmentsTable)
      .where(eq(projectAssignmentsTable.userId, userId));
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0]?.projectId, projectId);

    const acceptedInvitations = await db.select().from(staffInvitationsTable)
      .where(and(
        eq(staffInvitationsTable.id, invitation.id),
        eq(staffInvitationsTable.status, "ACCEPTED"),
        eq(staffInvitationsTable.acceptedUserId, userId),
      ));
    assert.equal(acceptedInvitations.length, 1);
    assert.equal(acceptedInvitations[0]?.acceptedEmail, invitedEmail);

    const director = await startServer(
      staticAccessMiddleware(),
      {},
      {
        ...clerkDependencies,
        getClerkInvitation: async () => ({ status: "accepted" }),
      },
    );
    try {
      const response = await fetch(`${director.baseUrl}/access/invitations`);
      assert.equal(response.status, 200);
      const body = await response.json() as {
        invitations: Array<{
          id: string;
          status: string;
          acceptedEmail: string | null;
          acceptedAt: string | null;
        }>;
      };
      const accepted = body.invitations.find(({ id }) => id === invitation.id);
      assert.equal(accepted?.status, "ACCEPTED");
      assert.equal(accepted?.acceptedEmail, invitedEmail);
      assert.ok(accepted?.acceptedAt);
    } finally {
      await director.close();
    }
  });

  await t.test("a verified mixed-case Clerk email claims the normalized invitation exactly once", async () => {
    const email = `${prefix}-mixed-case@example.test`;
    const mixedCaseEmail = `${prefix}-MiXeD-CaSe@ExAmPlE.TeSt`;
    const userId = `${prefix}-mixed-case-user`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email, [projectId]);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    const server = await startServer(clerkAccessMiddleware({
      [userId]: {
        email: mixedCaseEmail,
        name: "Mixed Case User",
        emailAddresses: [{ email: mixedCaseEmail, verified: true }],
      },
    }));
    try {
      const firstResponse = await getMe(server.baseUrl, userId);
      assert.equal(firstResponse.status, 200);
      const firstBody = await firstResponse.json() as {
        role: string;
        assignedProjectIds: string[];
      };
      assert.equal(firstBody.role, "TAX_STAFF");
      assert.deepEqual(firstBody.assignedProjectIds, [projectId]);

      const secondResponse = await getMe(server.baseUrl, userId);
      assert.equal(secondResponse.status, 200);
    } finally {
      await server.close();
    }

    const roles = await db.select().from(userRolesTable)
      .where(eq(userRolesTable.userId, userId));
    assert.equal(roles.length, 1);
    assert.equal(roles[0]?.role, "TAX_STAFF");

    const assignments = await db.select().from(projectAssignmentsTable)
      .where(eq(projectAssignmentsTable.userId, userId));
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0]?.projectId, projectId);

    const acceptedInvitations = await db.select().from(staffInvitationsTable)
      .where(and(
        eq(staffInvitationsTable.id, invitation.id),
        eq(staffInvitationsTable.status, "ACCEPTED"),
        eq(staffInvitationsTable.acceptedUserId, userId),
      ));
    assert.equal(acceptedInvitations.length, 1);
    assert.equal(acceptedInvitations[0]?.acceptedEmail, mixedCaseEmail);
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

  await t.test("Clerk create failure leaves an expired resend unchanged", async () => {
    const email = `${prefix}-resend-clerk-failure@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    const expiredAt = new Date(Date.now() - 1_000);
    await db.update(staffInvitationsTable).set({
      status: "EXPIRED",
      expiresAt: expiredAt,
    }).where(eq(staffInvitationsTable.id, invitation.id));
    const [storedBefore] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    clerkStatuses.set(storedBefore.clerkInvitationId, "expired");
    const createdClerkIdsBefore = [...createdClerkIds];
    const resendAuditsBefore = (await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id)))
      .filter(({ action }) => action === "UNDANGAN STAF DIKIRIM ULANG");

    const failingDependencies: AccessRouterDependencies = {
      ...clerkDependencies,
      createClerkInvitation: async () => {
        throw new Error("Injected Clerk invitation creation failure");
      },
    };
    const server = await startServer(staticAccessMiddleware(), {}, failingDependencies);
    try {
      const response = await fetch(`${server.baseUrl}/access/invitations/${invitation.id}/resend`, {
        method: "POST",
      });
      assert.equal(response.status, 500);
    } finally {
      await server.close();
    }

    const [storedAfter] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(storedAfter.status, storedBefore.status);
    assert.equal(storedAfter.clerkInvitationId, storedBefore.clerkInvitationId);
    assert.equal(storedAfter.expiresAt.getTime(), storedBefore.expiresAt.getTime());
    assert.deepEqual(createdClerkIds, createdClerkIdsBefore);

    const resendAuditsAfter = (await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id)))
      .filter(({ action }) => action === "UNDANGAN STAF DIKIRIM ULANG");
    assert.equal(resendAuditsAfter.length, resendAuditsBefore.length);
  });

  await t.test("resend persistence failure revokes the replacement Clerk invitation", async () => {
    const email = `${prefix}-resend-persistence-failure@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    await db.update(staffInvitationsTable).set({
      status: "EXPIRED",
      expiresAt: new Date(Date.now() - 1_000),
    }).where(eq(staffInvitationsTable.id, invitation.id));
    const [storedBefore] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    clerkStatuses.set(storedBefore.clerkInvitationId, "expired");
    const revokedCountBefore = revokedClerkIds.length;

    const failing = await startServer(staticAccessMiddleware(), {
      beforeResendPersistence: async () => {
        throw new Error("Injected resend persistence failure");
      },
    });
    try {
      const response = await fetch(`${failing.baseUrl}/access/invitations/${invitation.id}/resend`, {
        method: "POST",
      });
      assert.equal(response.status, 500);
    } finally {
      await failing.close();
    }

    const replacementClerkId = createdClerkIds.at(-1);
    assert.ok(replacementClerkId);
    assert.notEqual(replacementClerkId, storedBefore.clerkInvitationId);
    assert.equal(revokedClerkIds.length, revokedCountBefore + 1);
    assert.equal(revokedClerkIds.at(-1), replacementClerkId);
    assert.equal(clerkStatuses.get(replacementClerkId), "revoked");

    const [storedAfter] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(storedAfter.status, storedBefore.status);
    assert.equal(storedAfter.clerkInvitationId, storedBefore.clerkInvitationId);
    assert.equal(storedAfter.expiresAt.getTime(), storedBefore.expiresAt.getTime());

    const resendAudits = (await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id)))
      .filter(({ action }) => action === "UNDANGAN STAF DIKIRIM ULANG");
    assert.equal(resendAudits.length, 0);
  });
  await t.test("failed resend compensation is audited and reconciled", async () => {
    const email = `${prefix}-resend-compensation-failure@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    await db.update(staffInvitationsTable).set({
      status: "EXPIRED",
      expiresAt: new Date(Date.now() - 1_000),
    }).where(eq(staffInvitationsTable.id, invitation.id));
    const [storedBefore] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    clerkStatuses.set(storedBefore.clerkInvitationId, "expired");

    let compensationAttempts = 0;
    const failingDependencies: AccessRouterDependencies = {
      ...clerkDependencies,
      revokeClerkInvitation: async () => {
        compensationAttempts += 1;
        throw new Error("Injected replacement revoke failure");
      },
    };
    const failing = await startServer(staticAccessMiddleware(), {
      beforeResendPersistence: async () => {
        throw new Error("Injected resend persistence failure");
      },
    }, failingDependencies);
    try {
      const response = await fetch(`${failing.baseUrl}/access/invitations/${invitation.id}/resend`, {
        method: "POST",
      });
      assert.equal(response.status, 500);
    } finally {
      await failing.close();
    }

    const replacementClerkId = createdClerkIds.at(-1);
    assert.ok(replacementClerkId);
    assert.equal(compensationAttempts, 1);
    assert.equal(clerkStatuses.get(replacementClerkId), "pending");
    const auditsBeforeReconciliation = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id));
    const partialFailure = auditsBeforeReconciliation.find(({ action }) =>
      action === "KEGAGALAN PARSIAL KOMPENSASI KIRIM ULANG UNDANGAN");
    assert.ok(partialFailure);
    assert.equal(partialFailure.metadata?.replacementClerkInvitationId, replacementClerkId);
    assert.equal(partialFailure.metadata?.reconciliationRequired, true);
    assert.equal(auditsBeforeReconciliation.some(({ action }) =>
      action === "UNDANGAN STAF DIKIRIM ULANG"), false);
    const healthWithBacklog = await getInvitationReconciliationHealth();
    assert.equal(healthWithBacklog.pendingResendCompensations, 1);
    assert.equal(healthWithBacklog.status, "DEGRADED");

    const reconciliation = await reconcilePendingInvitations({
      getClerkInvitation: clerkDependencies.getClerkInvitation,
      revokeClerkInvitation: clerkDependencies.revokeClerkInvitation,
    });
    assert.ok(reconciliation.updated >= 1);
    assert.equal(clerkStatuses.get(replacementClerkId), "revoked");
    const [resolvedFailure] = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.id, partialFailure.id));
    assert.equal(resolvedFailure.metadata?.reconciliationRequired, false);
    assert.equal(resolvedFailure.metadata?.reconciliationOutcome, "REVOKED");
    const healthWithoutBacklog = await getInvitationReconciliationHealth();
    assert.equal(healthWithoutBacklog.pendingResendCompensations, 0);
    assert.equal(healthWithoutBacklog.status, "HEALTHY");

    const reconciliationLookups: string[] = [];
    const idempotentReconciliation = await reconcilePendingInvitations({
      getClerkInvitation: async (clerkInvitationId) => {
        reconciliationLookups.push(clerkInvitationId);
        return clerkDependencies.getClerkInvitation(clerkInvitationId);
      },
      revokeClerkInvitation: clerkDependencies.revokeClerkInvitation,
    });
    assert.equal(idempotentReconciliation.updated, 0);
    assert.equal(reconciliationLookups.includes(replacementClerkId), false);
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

  await t.test("concurrent resends create only one replacement Clerk invitation", async () => {
    const email = `${prefix}-resend-race@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    const [storedBefore] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    await db.update(staffInvitationsTable).set({
      status: "EXPIRED",
      expiresAt: new Date(Date.now() - 1_000),
    }).where(eq(staffInvitationsTable.id, invitation.id));
    clerkStatuses.set(storedBefore.clerkInvitationId, "expired");

    let firstResendStarted!: () => void;
    let releaseFirstResend!: () => void;
    const firstResendStartedPromise = new Promise<void>((resolve) => {
      firstResendStarted = resolve;
    });
    const firstResendCanFinish = new Promise<void>((resolve) => {
      releaseFirstResend = resolve;
    });
    let createCalls = 0;
    const gatedDependencies: AccessRouterDependencies = {
      ...clerkDependencies,
      createClerkInvitation: async (params) => {
        createCalls += 1;
        if (createCalls === 1) {
          firstResendStarted();
          await firstResendCanFinish;
        }
        return clerkDependencies.createClerkInvitation(params);
      },
    };
    const beforeCreatedCount = createdClerkIds.length;
    const server = await startServer(staticAccessMiddleware(), {}, gatedDependencies);
    try {
      const firstRequest = fetch(`${server.baseUrl}/access/invitations/${invitation.id}/resend`, {
        method: "POST",
      });
      await firstResendStartedPromise;
      const secondRequest = fetch(`${server.baseUrl}/access/invitations/${invitation.id}/resend`, {
        method: "POST",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseFirstResend();

      const responses = await Promise.all([firstRequest, secondRequest]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    } finally {
      releaseFirstResend();
      await server.close();
    }

    assert.equal(createCalls, 1);
    assert.equal(createdClerkIds.length - beforeCreatedCount, 1);

    const [storedAfter] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(storedAfter.status, "PENDING");
    assert.notEqual(storedAfter.clerkInvitationId, storedBefore.clerkInvitationId);

    const audits = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id));
    const resendAudits = audits.filter(({ action }) => action === "UNDANGAN STAF DIKIRIM ULANG");
    assert.equal(resendAudits.length, 1);
    assert.equal((resendAudits[0]?.metadata as { previousStatus?: string } | null)?.previousStatus, "EXPIRED");
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
      const listed = await response.json() as {
        invitations: Array<{ id: string; status: string }>;
        verification: { status: string; lastSuccessfulVerificationAt: string | null };
      };
      assert.equal(listed.verification.status, "VERIFIED");
      assert.ok(listed.verification.lastSuccessfulVerificationAt);
      assert.equal(listed.invitations.find(({ id }) => id === invitation.id)?.status, "REVOKED");
    } finally {
      await creator.close();
    }

    const [storedAfter] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(storedAfter.status, "REVOKED");
  });

  await t.test("listing omits unverified pending invitations while Clerk is unavailable", async () => {
    const email = `${prefix}-list-degraded@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    let clerkUnavailable = false;
    const unavailableDependencies: AccessRouterDependencies = {
      ...clerkDependencies,
      getClerkInvitation: async (id) => {
        if (clerkUnavailable) throw new Error("Injected transient Clerk outage");
        return clerkDependencies.getClerkInvitation(id);
      },
    };
    const degradedServer = await startServer(
      staticAccessMiddleware(),
      {},
      unavailableDependencies,
    );
    try {
      const verifiedResponse = await fetch(`${degradedServer.baseUrl}/access/invitations`);
      assert.equal(verifiedResponse.status, 200);
      const verified = await verifiedResponse.json() as {
        verification: { lastSuccessfulVerificationAt: string | null };
      };
      assert.ok(verified.verification.lastSuccessfulVerificationAt);
      const lastSuccessfulVerificationAt = verified.verification.lastSuccessfulVerificationAt;

      clerkUnavailable = true;
      const response = await fetch(`${degradedServer.baseUrl}/access/invitations`);
      assert.equal(response.status, 200);
      const listed = await response.json() as {
        invitations: Array<{ id: string; status: string }>;
        verification: {
          status: string;
          message: string;
          lastSuccessfulVerificationAt: string | null;
        };
      };
      assert.equal(listed.verification.status, "DEGRADED");
      assert.match(listed.verification.message, /disembunyikan sementara/);
      assert.equal(
        listed.verification.lastSuccessfulVerificationAt,
        lastSuccessfulVerificationAt,
      );
      assert.equal(listed.invitations.some(({ id }) => id === invitation.id), false);

      clerkUnavailable = false;
      const recoveredResponse = await fetch(`${degradedServer.baseUrl}/access/invitations`);
      assert.equal(recoveredResponse.status, 200);
      const recovered = await recoveredResponse.json() as {
        invitations: Array<{ id: string; status: string }>;
        verification: { status: string };
      };
      assert.equal(recovered.verification.status, "VERIFIED");
      assert.equal(recovered.invitations.some(({ id }) => id === invitation.id), true);
    } finally {
      await degradedServer.close();
    }

    const [storedAfter] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(storedAfter.status, "PENDING");
  });

  await t.test("Clerk verification time survives restart, is shared, and is unchanged by failures", async () => {
    const email = `${prefix}-persistent-verification@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    assert.equal(created.status, 201);
    await creator.close();

    const firstInstance = await startServer(staticAccessMiddleware());
    let persistedAt: string;
    try {
      const response = await fetch(`${firstInstance.baseUrl}/access/invitations`);
      assert.equal(response.status, 200);
      const body = await response.json() as {
        verification: { lastSuccessfulVerificationAt: string | null };
      };
      assert.ok(body.verification.lastSuccessfulVerificationAt);
      persistedAt = body.verification.lastSuccessfulVerificationAt;
    } finally {
      await firstInstance.close();
    }

    const [stored] = await db.select().from(operationalStateTable)
      .where(eq(operationalStateTable.key, clerkInvitationVerificationStateKey));
    assert.equal(stored.lastSuccessfulAt.toISOString(), persistedAt);

    const failingDependencies: AccessRouterDependencies = {
      ...clerkDependencies,
      getClerkInvitation: async () => {
        throw new Error("Injected Clerk outage after API restart");
      },
    };
    const restartedInstance = await startServer(
      staticAccessMiddleware(),
      {},
      failingDependencies,
    );
    try {
      const response = await fetch(`${restartedInstance.baseUrl}/access/invitations`);
      assert.equal(response.status, 200);
      const body = await response.json() as {
        verification: {
          status: string;
          lastSuccessfulVerificationAt: string | null;
        };
      };
      assert.equal(body.verification.status, "DEGRADED");
      assert.equal(body.verification.lastSuccessfulVerificationAt, persistedAt);
    } finally {
      await restartedInstance.close();
    }

    const [unchanged] = await db.select().from(operationalStateTable)
      .where(eq(operationalStateTable.key, clerkInvitationVerificationStateKey));
    assert.equal(unchanged.lastSuccessfulAt.toISOString(), persistedAt);
  });

  await t.test("scheduled reconciliation retries failures and writes one truthful audit", async () => {
    const email = `${prefix}-scheduled-reconcile@example.test`;
    const creator = await startServer(staticAccessMiddleware());
    const created = await postInvite(creator.baseUrl, email);
    assert.equal(created.status, 201);
    const invitation = await created.json() as { id: string };
    await creator.close();

    const [storedBefore] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    let attempts = 0;
    const dependencies = {
      getClerkInvitation: async (clerkInvitationId: string) => {
        if (clerkInvitationId !== storedBefore.clerkInvitationId) {
          return { status: clerkStatuses.get(clerkInvitationId) ?? "pending" };
        }
        attempts += 1;
        if (attempts <= 2) throw new Error("Injected transient Clerk failure");
        return { status: "expired" };
      },
    };

    const failedPass = await reconcilePendingInvitations(dependencies);
    assert.equal(failedPass.failed, 1);
    const healthAfterFailure = await getInvitationReconciliationHealth();
    assert.equal(healthAfterFailure.status, "DEGRADED");
    assert.ok(healthAfterFailure.consecutiveFailures >= 1);
    assert.ok(healthAfterFailure.lastFailureAt);

    const repeatedFailurePass = await reconcilePendingInvitations(dependencies);
    assert.equal(repeatedFailurePass.failed, 1);
    const healthAfterRepeatedFailure = await getInvitationReconciliationHealth();
    assert.equal(healthAfterRepeatedFailure.status, "DEGRADED");
    assert.equal(
      healthAfterRepeatedFailure.consecutiveFailures,
      healthAfterFailure.consecutiveFailures + 1,
    );
    assert.ok(healthAfterRepeatedFailure.lastFailureAt);

    const healthServer = await startServer(staticAccessMiddleware());
    try {
      const healthResponse = await fetch(`${healthServer.baseUrl}/healthz`);
      assert.equal(healthResponse.status, 200);
      const health = await healthResponse.json() as {
        status: string;
        invitationReconciliation: {
          status: string;
          consecutiveFailures: number;
          lastFailureAt: string | null;
        };
      };
      assert.equal(health.status, "degraded");
      assert.equal(health.invitationReconciliation.status, "DEGRADED");
      assert.equal(
        health.invitationReconciliation.consecutiveFailures,
        healthAfterRepeatedFailure.consecutiveFailures,
      );
      assert.equal(
        health.invitationReconciliation.lastFailureAt,
        healthAfterRepeatedFailure.lastFailureAt,
      );
    } finally {
      await healthServer.close();
    }

    const auditsAfterFailure = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id));
    assert.equal(auditsAfterFailure.filter(({ action }) =>
      action === "STATUS UNDANGAN DIREKONSILIASI").length, 0);

    const retryPass = await reconcilePendingInvitations(dependencies);
    assert.equal(retryPass.updated, 1);
    const healthAfterRecovery = await getInvitationReconciliationHealth();
    assert.equal(healthAfterRecovery.status, "HEALTHY");
    assert.equal(healthAfterRecovery.consecutiveFailures, 0);
    assert.ok(healthAfterRecovery.lastSuccessAt);
    const [storedAfter] = await db.select().from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, invitation.id));
    assert.equal(storedAfter.status, "EXPIRED");
    const auditsAfterRetry = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id));
    const reconciliationAudits = auditsAfterRetry.filter(({ action }) =>
      action === "STATUS UNDANGAN DIREKONSILIASI");
    assert.equal(reconciliationAudits.length, 1);
    assert.equal(reconciliationAudits[0]?.metadata?.reason, "SCHEDULED_CHECK");
    assert.equal(reconciliationAudits[0]?.metadata?.outcome, "UPDATED");

    const idempotentPass = await reconcilePendingInvitations(dependencies);
    assert.equal(idempotentPass.updated, 0);
    const finalAudits = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invitation.id));
    assert.equal(finalAudits.filter(({ action }) =>
      action === "STATUS UNDANGAN DIREKONSILIASI").length, 1);
    clerkStatuses.set(storedBefore.clerkInvitationId, "expired");
  });

  await t.test("scheduled reconciliation allows only one active pass across instances", async () => {
    await db.update(invitationReconciliationStateTable).set({
      alertIncidentActive: false,
      alertIncidentReason: null,
      degradedAlertSent: false,
    });
    let releaseFirstLookup!: () => void;
    const firstLookupStarted = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve;
    });
    let notifyLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      notifyLookupStarted = resolve;
    });
    let firstLookup = true;
    const firstRun = runScheduledInvitationReconciliation({
      getClerkInvitation: async () => {
        if (firstLookup) {
          firstLookup = false;
          notifyLookupStarted();
          await firstLookupStarted;
        }
        return { status: "pending" };
      },
    });

    await lookupStarted;
    const healthBeforeSkip = await getInvitationReconciliationHealth();
    const competingEvents: string[] = [];
    const alerts: InvitationReconciliationAlert[] = [];
    await new Promise((resolve) => setTimeout(resolve, 2));
    const competingRun = await runScheduledInvitationReconciliation({
      getClerkInvitation: async () => {
        throw new Error("Competing reconciliation must not call Clerk");
      },
      alerting: {
        failureThreshold: 3,
        completionStaleAfterMs: 1,
        notify: async (alert) => {
          alerts.push(alert);
        },
      },
      onRunEvent: ({ outcome }) => competingEvents.push(outcome),
    });
    assert.deepEqual(competingRun, { skipped: true });
    assert.deepEqual(competingEvents, ["RUNNING", "SKIPPED"]);
    const healthAfterSkip = await getInvitationReconciliationHealth();
    assert.equal(healthAfterSkip.lastRun.outcome, "SKIPPED");
    const skippedAt = healthAfterSkip.lastRun.occurredAt;
    assert.equal(healthAfterSkip.status, "DEGRADED");
    assert.equal(healthAfterSkip.completionOverdue, true);
    assert.equal(alerts[0]?.type, "DEGRADED");
    assert.equal(alerts[0]?.reason, "NO_RECENT_COMPLETION");
    assert.equal(
      healthAfterSkip.consecutiveFailures,
      healthBeforeSkip.consecutiveFailures,
    );

    releaseFirstLookup();
    const completedFirstRun = await firstRun;
    assert.equal(completedFirstRun.skipped, false);
    const healthAfterCompletion = await getInvitationReconciliationHealth();
    assert.equal(healthAfterCompletion.lastRun.outcome, "SKIPPED");
    assert.equal(healthAfterCompletion.lastRun.occurredAt, skippedAt);
    assert.equal(healthAfterCompletion.consecutiveFailures, healthBeforeSkip.consecutiveFailures);

    const nextRun = await runScheduledInvitationReconciliation({
      getClerkInvitation: async () => ({ status: "pending" }),
    });
    assert.equal(nextRun.skipped, false);
  });

  await t.test("a hung scheduled pass alerts once and recovers after it completes", async () => {
    await db.update(invitationReconciliationStateTable).set({
      alertIncidentActive: false,
      alertIncidentReason: null,
      degradedAlertSent: false,
    });
    let releaseLookup!: () => void;
    const lookupBlocked = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let notifyLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      notifyLookupStarted = resolve;
    });
    const alerts: InvitationReconciliationAlert[] = [];
    let firstLookup = true;
    const scheduler = schedulePendingInvitationReconciliation({
      getClerkInvitation: async () => {
        if (firstLookup) {
          firstLookup = false;
          notifyLookupStarted();
          await lookupBlocked;
        }
        return { status: "pending" };
      },
      alerting: {
        failureThreshold: 3,
        completionStaleAfterMs: 100,
        notify: async (alert) => {
          alerts.push(alert);
        },
      },
    }, {
      intervalMs: 5,
    });

    await lookupStarted;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(
      alerts.map(({ type, reason }) => [type, reason]),
      [["DEGRADED", "NO_RECENT_COMPLETION"]],
    );

    const stopped = scheduler.stop();
    releaseLookup();
    await stopped;
    const recoveryDeadline = Date.now() + 1_000;
    while (alerts.length < 2 && Date.now() < recoveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(alerts.map(({ type }) => type), ["DEGRADED", "RECOVERED"]);
    assert.equal((await getInvitationReconciliationHealth()).completionOverdue, false);
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
  }, databaseSuiteName, databaseStatementTimeoutMs);
});