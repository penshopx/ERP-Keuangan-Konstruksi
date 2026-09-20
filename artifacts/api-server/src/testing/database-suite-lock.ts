import { configureDatabasePoolTimeouts, pool } from "@workspace/db";

export const persistenceDatabaseSuiteLockName = "api-server:persistence-integration-shared-fixtures";
export const defaultPersistenceDatabaseSuiteLockTimeoutMs = 120_000;
export const defaultDatabaseSuiteStatementTimeoutMs = 60_000;
const databaseSuiteLockPollMs = 250;

export type DatabaseSuiteLockClient = {
  query: typeof pool.query;
  release: () => void;
};

export type DatabaseSuiteLockOptions = {
  lockName: string;
  suiteName: string;
  timeoutMs: number;
};

export function isDatabaseStatementTimeout(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && current.code === "57014") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export function isDatabaseClientTimeout(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (
      "message" in current
      && typeof current.message === "string"
      && (
        current.message === "Query read timeout"
        || current.message.includes("timeout exceeded when trying to connect")
        || current.message.includes("Connection terminated due to connection timeout")
      )
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export async function setDatabaseSuiteStatementTimeout(
  client: DatabaseSuiteLockClient,
  suiteName: string,
  timeoutMs: number,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(timeoutMs)) {
    throw new Error(`${suiteName} database statement timeout must be a positive integer; received ${timeoutMs}`);
  }
  await client.query(`SET statement_timeout = ${timeoutMs}`);
}

export function setDatabaseSuitePoolStatementTimeout(
  suiteName: string,
  timeoutMs: number,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(timeoutMs)) {
    throw new Error(`${suiteName} database statement timeout must be a positive integer; received ${timeoutMs}`);
  }
  configureDatabasePoolTimeouts({
    statementTimeoutMs: timeoutMs,
    queryTimeoutMs: timeoutMs,
    connectionTimeoutMs: timeoutMs,
  });
}

export function describeDatabaseSuiteError(
  error: unknown,
  suiteName: string,
  timeoutMs: number,
): unknown {
  if (isDatabaseStatementTimeout(error)) {
    return new Error(
      `${suiteName} database query exceeded the ${timeoutMs}ms statement timeout`,
      { cause: error },
    );
  }
  if (isDatabaseClientTimeout(error)) {
    return new Error(
      `${suiteName} database operation exceeded the ${timeoutMs}ms client timeout`,
      { cause: error },
    );
  }
  return error;
}

export async function runDatabaseSuiteOperation<T>(
  operation: () => Promise<T>,
  suiteName: string,
  timeoutMs: number,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw describeDatabaseSuiteError(error, suiteName, timeoutMs);
  }
}

export async function acquireDatabaseSuiteLock({
  lockName,
  suiteName,
  timeoutMs,
}: DatabaseSuiteLockOptions): Promise<DatabaseSuiteLockClient> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${suiteName} database lock timeout must be a positive number; received ${timeoutMs}`);
  }

  const client = await pool.connect();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [lockName],
      );
      if (result.rows[0]?.acquired) return client;
      await new Promise((resolve) => setTimeout(resolve, databaseSuiteLockPollMs));
    }
  } catch (error) {
    client.release();
    throw new Error(`Failed while acquiring the ${suiteName} database lock`, { cause: error });
  }

  client.release();
  throw new Error(
    `Could not acquire the ${suiteName} database lock within ${timeoutMs}ms; another database-backed validation may still be running`,
  );
}

export async function releaseDatabaseSuiteLock(
  client: DatabaseSuiteLockClient,
  { lockName, suiteName }: Pick<DatabaseSuiteLockOptions, "lockName" | "suiteName">,
) {
  try {
    const result = await client.query<{ released: boolean }>(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
      [lockName],
    );
    if (!result.rows[0]?.released) {
      throw new Error(`PostgreSQL reported that the ${suiteName} database lock was not held`);
    }
  } finally {
    client.release();
  }
}

export async function acquirePersistenceDatabaseSuiteLock(
  timeoutMs = defaultPersistenceDatabaseSuiteLockTimeoutMs,
): Promise<DatabaseSuiteLockClient> {
  return acquireDatabaseSuiteLock({
    lockName: persistenceDatabaseSuiteLockName,
    suiteName: "persistence integration",
    timeoutMs,
  });
}

export async function releasePersistenceDatabaseSuiteLock(client: DatabaseSuiteLockClient) {
  return releaseDatabaseSuiteLock(client, {
    lockName: persistenceDatabaseSuiteLockName,
    suiteName: "persistence integration",
  });
}