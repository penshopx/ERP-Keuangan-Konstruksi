export const defaultRabImportLockTimeoutMs = 5_000;

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