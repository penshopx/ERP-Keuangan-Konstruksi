import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATION_LOCK_ID = 873214509;
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 30_000;
const MIGRATION_LOCK_RETRY_INTERVAL_MS = 100;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export async function loadMigrations(directory = migrationsDirectory) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(directory, name), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

function parseLockTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "MIGRATION_LOCK_TIMEOUT_MS must be a positive integer number of milliseconds.",
    );
  }
  return timeoutMs;
}

async function acquireMigrationLock(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [MIGRATION_LOCK_ID],
    );
    if (result.rows[0]?.acquired) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the database migration lock. ` +
          "Another migration process may be stuck or still running.",
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(MIGRATION_LOCK_RETRY_INTERVAL_MS, timeoutMs)),
    );
  }
}

export async function runMigrations(
  client,
  migrations,
  { lockTimeoutMs = DEFAULT_MIGRATION_LOCK_TIMEOUT_MS } = {},
) {
  const validatedLockTimeoutMs = parseLockTimeout(lockTimeoutMs);
  let lockAcquired = false;
  await acquireMigrationLock(client, validatedLockTimeoutMs);
  lockAcquired = true;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query(
      "SELECT name, checksum FROM app_migrations",
    );
    const applied = new Map(
      appliedResult.rows.map((row) => [row.name, row.checksum]),
    );

    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.name);
      if (existingChecksum === migration.checksum) {
        continue;
      }
      if (existingChecksum) {
        throw new Error(
          `Migration ${migration.name} was changed after it was applied. ` +
            "Create a new migration instead of editing migration history.",
        );
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO app_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        console.info(`Applied database migration ${migration.name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (lockAcquired) {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    }
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required to run mandatory database migrations.",
    );
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await runMigrations(client, await loadMigrations(), {
      lockTimeoutMs: parseLockTimeout(process.env.MIGRATION_LOCK_TIMEOUT_MS),
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Mandatory database migration failed:", error);
    process.exit(1);
  });
}