const DEFAULT_OPERATIONAL_ALERT_TIMEOUT_MS = 5_000;

export function resolveOperationalAlertConfig({
  webhookUrl,
  channelWebhookUrl,
  timeoutMs,
  channelTimeoutMs,
  env = process.env,
} = {}) {
  return {
    webhookUrl:
      webhookUrl ??
      channelWebhookUrl ??
      env.OPERATIONAL_ALERT_WEBHOOK_URL,
    timeoutMs: parseOperationalAlertTimeout(
      timeoutMs ??
        channelTimeoutMs ??
        env.OPERATIONAL_ALERT_TIMEOUT_MS,
    ),
  };
}

export async function sendOperationalAlert({
  alert,
  config,
  fetchImpl = globalThis.fetch,
  log = console,
  recordDeliveryStatus,
}) {
  log.error(JSON.stringify(alert));
  const attemptedAt = new Date();
  if (!config.webhookUrl) {
    await safelyRecordDeliveryStatus({
      recordDeliveryStatus,
      status: {
        source: alert.source,
        attemptedAt,
        result: "NOT_CONFIGURED",
      },
      log,
    });
    return { delivered: false, reason: "not_configured" };
  }

  try {
    const response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs),
      body: JSON.stringify(alert),
    });
    if (!response.ok) {
      throw new Error(`Operational alert webhook returned HTTP ${response.status}`);
    }
    await safelyRecordDeliveryStatus({
      recordDeliveryStatus,
      status: {
        source: alert.source,
        attemptedAt,
        result: "DELIVERED",
      },
      log,
    });
    return { delivered: true };
  } catch (error) {
    log.error({ error, source: alert.source, event: alert.event },
      "Operational alert delivery failed");
    await safelyRecordDeliveryStatus({
      recordDeliveryStatus,
      status: {
        source: alert.source,
        attemptedAt,
        result: "DELIVERY_FAILED",
      },
      log,
    });
    return { delivered: false, reason: "delivery_failed", error };
  }
}

async function safelyRecordDeliveryStatus({ recordDeliveryStatus, status, log }) {
  if (!recordDeliveryStatus) return;
  try {
    await recordDeliveryStatus(status);
  } catch (error) {
    log.error(
      { error, source: status.source, result: status.result },
      "Operational alert delivery status persistence failed",
    );
  }
}

function parseOperationalAlertTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_OPERATIONAL_ALERT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Operational alert timeout must be a positive integer number of milliseconds.",
    );
  }
  return timeoutMs;
}