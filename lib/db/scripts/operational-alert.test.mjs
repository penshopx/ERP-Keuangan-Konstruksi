import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveOperationalAlertConfig,
  sendOperationalAlert,
} from "../src/operational-alert.mjs";

test("shared operational channel is the default and channel settings can override it", () => {
  const env = {
    OPERATIONAL_ALERT_WEBHOOK_URL: "https://alerts.example.test/shared",
    OPERATIONAL_ALERT_TIMEOUT_MS: "250",
  };

  assert.deepEqual(resolveOperationalAlertConfig({ env }), {
    webhookUrl: "https://alerts.example.test/shared",
    timeoutMs: 250,
  });
  assert.deepEqual(resolveOperationalAlertConfig({
    env,
    channelWebhookUrl: "https://alerts.example.test/releases",
    channelTimeoutMs: "100",
  }), {
    webhookUrl: "https://alerts.example.test/releases",
    timeoutMs: 100,
  });
});

test("delivery failures are recorded and do not escape to the main process", async () => {
  const errors = [];
  const result = await sendOperationalAlert({
    alert: {
      source: "test",
      event: "test_failure",
      severity: "error",
      message: "Test alert",
    },
    config: {
      webhookUrl: "https://alerts.example.test/shared",
      timeoutMs: 100,
    },
    fetchImpl: async () => ({ ok: false, status: 503 }),
    log: { error: (...args) => errors.push(args) },
  });

  assert.equal(result.delivered, false);
  assert.equal(result.reason, "delivery_failed");
  assert.equal(errors.length, 2);
  assert.match(errors[0][0], /"event":"test_failure"/);
  assert.equal(errors[1][0].event, "test_failure");
});

test("delivery status persistence failures never change the delivery result", async () => {
  const errors = [];
  const result = await sendOperationalAlert({
    alert: {
      source: "test",
      event: "test_success",
      severity: "info",
      message: "Test alert",
    },
    config: {
      webhookUrl: "https://alerts.example.test/shared",
      timeoutMs: 100,
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    recordDeliveryStatus: async () => {
      throw new Error("database unavailable");
    },
    log: { error: (...args) => errors.push(args) },
  });

  assert.deepEqual(result, { delivered: true });
  assert.equal(errors.length, 2);
  assert.match(errors[1][1], /status persistence failed/);
});

test("records source, attempt time, and result without webhook details", async () => {
  const statuses = [];
  await sendOperationalAlert({
    alert: {
      source: "budget-control",
      event: "budget_alert",
      severity: "error",
      message: "Test alert",
    },
    config: {
      webhookUrl: "https://alerts.example.test/secret-path",
      timeoutMs: 100,
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    recordDeliveryStatus: async (status) => statuses.push(status),
    log: { error: () => {} },
  });

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].source, "budget-control");
  assert.equal(statuses[0].result, "DELIVERED");
  assert.ok(statuses[0].attemptedAt instanceof Date);
  assert.equal(JSON.stringify(statuses).includes("secret-path"), false);
});