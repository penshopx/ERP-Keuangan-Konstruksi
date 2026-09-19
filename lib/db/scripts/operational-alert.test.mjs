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