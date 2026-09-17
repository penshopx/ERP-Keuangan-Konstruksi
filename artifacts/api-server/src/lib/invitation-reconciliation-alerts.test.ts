import assert from "node:assert/strict";
import test from "node:test";
import {
  type InvitationReconciliationAlert,
  type InvitationReconciliationHealth,
  updateInvitationReconciliationAlert,
} from "./invitation-reconciliation";

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
    lastFailureAt: status === "DEGRADED" ? new Date().toISOString() : null,
    lastSuccessAt: status === "HEALTHY" ? new Date().toISOString() : null,
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
    notify: async () => {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error("Webhook unavailable");
    },
  };
  const degraded: InvitationReconciliationHealth = {
    status: "DEGRADED",
    consecutiveFailures: 1,
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: null,
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
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: null,
    lastRun: completedRun,
  });
  await updateInvitationReconciliationAlert(alerting, {
    status: "HEALTHY",
    consecutiveFailures: 0,
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastRun: completedRun,
  });

  assert.deepEqual(delivered, ["DEGRADED", "RECOVERED"]);
});
