export interface OperationalAlert {
  source: string;
  event: string;
  severity: "error" | "info";
  message: string;
  [key: string]: unknown;
}

export interface OperationalAlertConfig {
  webhookUrl?: string;
  timeoutMs: number;
}

export interface OperationalAlertLogger {
  error: (...args: unknown[]) => void;
}

export function resolveOperationalAlertConfig(options?: {
  webhookUrl?: string;
  channelWebhookUrl?: string;
  timeoutMs?: string | number;
  channelTimeoutMs?: string | number;
  env?: NodeJS.ProcessEnv;
}): OperationalAlertConfig;

export function sendOperationalAlert(options: {
  alert: OperationalAlert;
  config: OperationalAlertConfig;
  fetchImpl?: typeof fetch;
  log?: OperationalAlertLogger;
}): Promise<
  | { delivered: true }
  | {
      delivered: false;
      reason: "not_configured" | "delivery_failed";
      error?: unknown;
    }
>;