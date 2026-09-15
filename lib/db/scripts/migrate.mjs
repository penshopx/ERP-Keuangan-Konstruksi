import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATION_LOCK_ID = 873214509;
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

export async function runMigrations(client, migrations) {
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
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
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
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
    await runMigrations(client, await loadMigrations());
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