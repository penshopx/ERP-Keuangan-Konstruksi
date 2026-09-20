import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { db, invitationReconciliationStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  type InvitationReconciliationAlert,
  type InvitationReconciliationHealth,
  updateInvitationReconciliationAlert,
} from "./invitation-reconciliation";

beforeEach(async () => {
  await db.delete(invitationReconciliationStateTable).where(eq(
    invitationReconciliationStateTable.key,
    "scheduled-invitation-reconciliation",
  ));
});

const completedRun: InvitationReconciliationHealth["lastRun"] = {
  outcome: "COMPLETED",
  occurredAt: new Date().toISOString(),
  checked: 0,
  updated: 0,
  failed: 0,
};

test("alerts once after the failure threshold and once after recovery", async () => {
  const alerts: InvitationReconciliationAlert[] = [];
  const alerting = {
    failureThreshold: 2,
    completionStaleAfterMs: 60_000,
    notify: async (alert: InvitationReconciliationAlert) => {
      alerts.push(alert);
    },
  };
  const health = (
    status: InvitationReconciliationHealth["status"],
    consecutiveFailures: number,
  ): InvitationReconciliationHealth => ({
    status,
    consecutiveFailures,
    pendingResendCompensations: 0,
    lastFailureAt: status === "DEGRADED" ? new Date().toISOString() : null,
    lastSuccessAt: status === "HEALTHY" ? new Date().toISOString() : null,
    lastCompletedAt: completedRun.occurredAt,
    completionOverdue: false,
    completionStaleAfterMs: alerting.completionStaleAfterMs,
    lastRun: completedRun,
  });

  await updateInvitationReconciliationAlert(alerting, health("DEGRADED", 1));
  assert.equal(alerts.length, 0);

  await updateInvitationReconciliationAlert(alerting, health("DEGRADED", 2));
  assert.deepEqual(alerts.map(({ type }) => type), ["DEGRADED"]);

  await updateInvitationReconciliationAlert(alerting, health("DEGRADED", 3));
  assert.deepEqual(alerts.map(({ type }) => type), ["DEGRADED"]);

  await updateInvitationReconciliationAlert(alerting, health("HEALTHY", 0));
  assert.deepEqual(alerts.map(({ type }) => type), ["DEGRADED", "RECOVERED"]);

  await updateInvitationReconciliationAlert(alerting, health("HEALTHY", 0));
  assert.deepEqual(alerts.map(({ type }) => type), ["DEGRADED", "RECOVERED"]);
});

test("retries a failed alert delivery instead of silently suppressing it", async () => {
  let deliveryAttempts = 0;
  const alerting = {
    failureThreshold: 1,
    completionStaleAfterMs: 60_000,
    notify: async () => {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error("Webhook unavailable");
    },
  };
  const degraded: InvitationReconciliationHealth = {
    status: "DEGRADED",
    consecutiveFailures: 1,
    pendingResendCompensations: 0,
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: null,
    lastCompletedAt: null,
    completionOverdue: false,
    completionStaleAfterMs: alerting.completionStaleAfterMs,
    lastRun: completedRun,
  };

  await updateInvitationReconciliationAlert(alerting, degraded);
  await updateInvitationReconciliationAlert(alerting, degraded);
  assert.equal(deliveryAttempts, 2);
});

test("delivers a pending degradation before recovery when service recovers", async () => {
  const delivered: InvitationReconciliationAlert["type"][] = [];
  let failFirstDelivery = true;
  const alerting = {
    failureThreshold: 1,
    completionStaleAfterMs: 60_000,
    notify: async (alert: InvitationReconciliationAlert) => {
      if (failFirstDelivery) {
        failFirstDelivery = false;
        throw new Error("Webhook unavailable");
      }
      delivered.push(alert.type);
    },
  };

  await updateInvitationReconciliationAlert(alerting, {
    status: "DEGRADED",
    consecutiveFailures: 1,
    pendingResendCompensations: 0,
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: null,
    lastCompletedAt: null,
    completionOverdue: false,
    completionStaleAfterMs: alerting.completionStaleAfterMs,
    lastRun: completedRun,
  });
  await updateInvitationReconciliationAlert(alerting, {
    status: "HEALTHY",
    consecutiveFailures: 0,
    pendingResendCompensations: 0,
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastCompletedAt: new Date().toISOString(),
    completionOverdue: false,
    completionStaleAfterMs: alerting.completionStaleAfterMs,
    lastRun: completedRun,
  });

  assert.deepEqual(delivered, ["DEGRADED", "RECOVERED"]);
});

test("alerts only after completion becomes overdue and recovers after completion", async () => {
  const alerts: InvitationReconciliationAlert[] = [];
  const alerting = {
    failureThreshold: 3,
    completionStaleAfterMs: 1,
    notify: async (alert: InvitationReconciliationAlert) => {
      alerts.push(alert);
    },
  };
  const base: InvitationReconciliationHealth = {
    status: "HEALTHY",
    consecutiveFailures: 0,
    pendingResendCompensations: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    lastCompletedAt: null,
    completionOverdue: false,
    completionStaleAfterMs: alerting.completionStaleAfterMs,
    lastRun: completedRun,
  };

  await updateInvitationReconciliationAlert(alerting, base);
  assert.equal(alerts.length, 0);

  await updateInvitationReconciliationAlert(alerting, {
    ...base,
    status: "DEGRADED",
    completionOverdue: true,
  });
  assert.deepEqual(alerts.map(({ type, reason }) => [type, reason]), [
    ["DEGRADED", "NO_RECENT_COMPLETION"],
  ]);

  await updateInvitationReconciliationAlert(alerting, {
    ...base,
    lastCompletedAt: new Date().toISOString(),
  });
  assert.deepEqual(alerts.map(({ type }) => type), ["DEGRADED", "RECOVERED"]);
});

test("claims one degradation and one recovery across concurrent evaluators", async () => {
  const delivered: InvitationReconciliationAlert["type"][] = [];
  const alerting = {
    failureThreshold: 1,
    completionStaleAfterMs: 60_000,
    notify: async (alert: InvitationReconciliationAlert) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      delivered.push(alert.type);
    },
  };
  const degraded: InvitationReconciliationHealth = {
    status: "DEGRADED",
    consecutiveFailures: 1,
    pendingResendCompensations: 0,
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: null,
    lastCompletedAt: null,
    completionOverdue: false,
    completionStaleAfterMs: alerting.completionStaleAfterMs,
    lastRun: completedRun,
  };

  await Promise.all([
    updateInvitationReconciliationAlert(alerting, degraded),
    updateInvitationReconciliationAlert(alerting, degraded),
  ]);
  assert.deepEqual(delivered, ["DEGRADED"]);

  const healthy: InvitationReconciliationHealth = {
    ...degraded,
    status: "HEALTHY",
    consecutiveFailures: 0,
    lastSuccessAt: new Date().toISOString(),
    lastCompletedAt: new Date().toISOString(),
  };
  await Promise.all([
    updateInvitationReconciliationAlert(alerting, healthy),
    updateInvitationReconciliationAlert(alerting, healthy),
  ]);
  assert.deepEqual(delivered, ["DEGRADED", "RECOVERED"]);
});

test("does not resend a successful degradation when recovery delivery fails", async () => {
  const attempts: InvitationReconciliationAlert["type"][] = [];
  let recoveryFailures = 1;
  const alerting = {
    failureThreshold: 1,
    completionStaleAfterMs: 60_000,
    notify: async (alert: InvitationReconciliationAlert) => {
      attempts.push(alert.type);
      if (alert.type === "RECOVERED" && recoveryFailures-- > 0) {
        throw new Error("Webhook unavailable");
      }
    },
  };
  const degraded: InvitationReconciliationHealth = {
    status: "DEGRADED",
    consecutiveFailures: 1,
    pendingResendCompensations: 0,
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: null,
    lastCompletedAt: null,
    completionOverdue: false,
    completionStaleAfterMs: alerting.completionStaleAfterMs,
    lastRun: completedRun,
  };
  const healthy: InvitationReconciliationHealth = {
    ...degraded,
    status: "HEALTHY",
    consecutiveFailures: 0,
    lastSuccessAt: new Date().toISOString(),
    lastCompletedAt: new Date().toISOString(),
  };

  await updateInvitationReconciliationAlert(alerting, degraded);
  await updateInvitationReconciliationAlert(alerting, healthy);
  await updateInvitationReconciliationAlert(alerting, healthy);

  assert.deepEqual(attempts, ["DEGRADED", "RECOVERED", "RECOVERED"]);
});
