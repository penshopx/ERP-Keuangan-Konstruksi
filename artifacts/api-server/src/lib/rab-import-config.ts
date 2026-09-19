export const defaultRabImportLockTimeoutMs = 5_000;

type RabImportConfigLogger = {
  info(
    bindings: {
      event: "rab_import_config";
      rabImportLockTimeoutMs: number;
    },
    message: string,
  ): void;
};

export function getRabImportLockTimeoutMs(
  environment: NodeJS.ProcessEnv,
): number {
  const rawValue = environment["RAB_IMPORT_LOCK_TIMEOUT_MS"];
  if (rawValue === undefined) return defaultRabImportLockTimeoutMs;

  const timeoutMs = Number(rawValue);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `RAB_IMPORT_LOCK_TIMEOUT_MS must be a positive integer; received "${rawValue}"`,
    );
  }

  return timeoutMs;
}

export function logRabImportLockTimeout(
  log: RabImportConfigLogger,
  environment: NodeJS.ProcessEnv,
): void {
  log.info({
    event: "rab_import_config",
    rabImportLockTimeoutMs: getRabImportLockTimeoutMs(environment),
  }, "RAB import lock timeout configured");
}
