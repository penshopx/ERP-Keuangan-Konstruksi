import { pool } from "@workspace/db";

export const persistenceDatabaseSuiteLockName = "api-server:persistence-integration-shared-fixtures";
export const defaultPersistenceDatabaseSuiteLockTimeoutMs = 120_000;
const databaseSuiteLockPollMs = 250;

export type DatabaseSuiteLockClient = {
  query: typeof pool.query;
  release: () => void;
};

export async function acquirePersistenceDatabaseSuiteLock(
  timeoutMs = defaultPersistenceDatabaseSuiteLockTimeoutMs,
): Promise<DatabaseSuiteLockClient> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Persistence database lock timeout must be a positive number; received ${timeoutMs}`);
  }

  const client = await pool.connect();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [persistenceDatabaseSuiteLockName],
      );
      if (result.rows[0]?.acquired) return client;
      await new Promise((resolve) => setTimeout(resolve, databaseSuiteLockPollMs));
    }
  } catch (error) {
    client.release();
    throw new Error("Failed while acquiring the persistence integration database lock", { cause: error });
  }

  client.release();
  throw new Error(
    `Could not acquire the persistence integration database lock within ${timeoutMs}ms; another database-backed validation may still be running`,
  );
}

export async function releasePersistenceDatabaseSuiteLock(client: DatabaseSuiteLockClient) {
  try {
    const result = await client.query<{ released: boolean }>(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
      [persistenceDatabaseSuiteLockName],
    );
    if (!result.rows[0]?.released) {
      throw new Error("PostgreSQL reported that the persistence integration database lock was not held");
    }
  } finally {
    client.release();
  }
}