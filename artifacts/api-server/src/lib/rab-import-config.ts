export const defaultRabImportLockTimeoutMs = 5_000;
/**
 * RAB imports may wait at most one minute for the project advisory lock.
 * This leaves room for slow operations while keeping requests within a
 * bounded operational wait when the environment value is misconfigured.
 */
export const maxRabImportLockTimeoutMs = 60_000;

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
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > maxRabImportLockTimeoutMs
  ) {
    throw new Error(
      `RAB_IMPORT_LOCK_TIMEOUT_MS must be a safe integer between 1 and ${maxRabImportLockTimeoutMs} milliseconds; received "${rawValue}"`,
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
