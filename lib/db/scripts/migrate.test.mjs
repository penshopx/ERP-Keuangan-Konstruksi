import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  loadMigrations,
  MIGRATION_LOCK_ID,
  MIGRATION_LOCK_TIMEOUT_CODE,
  MigrationLockTimeoutError,
  reportMigrationLockTimeout,
  runMigrations,
} from "./migrate.mjs";

const processFixture = fileURLToPath(
  new URL("./migrate-process.fixture.mjs", import.meta.url),
);

function databaseUrlFor(databaseName) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function runMigrationProcess(databaseUrl, migration, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [processFixture], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TEST_MIGRATION: JSON.stringify(migration),
         ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(
          new Error(
            `Migration process exited with ${code ?? signal}\n${output}`,
          ),
        );
      }
    });
  });
}

test("loadMigrations sorts SQL files and records stable checksums", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "db-migrations-"));
  try {
    await writeFile(path.join(directory, "0002_second.sql"), "SELECT 2;\n");
    await writeFile(path.join(directory, "0001_first.sql"), "SELECT 1;\n");
    await writeFile(path.join(directory, "README.md"), "ignored");

    const migrations = await loadMigrations(directory);
    assert.deepEqual(
      migrations.map(({ name }) => name),
      ["0001_first.sql", "0002_second.sql"],
    );
    assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("runMigrations applies each migration once", async () => {
  const statements = [];
  let history = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql: sql.trim(), values });
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes("SELECT name, checksum FROM app_migrations")) {
        return { rows: history };
      }
      if (sql.includes("INSERT INTO app_migrations")) {
        history.push({ name: values[0], checksum: values[1] });
      }
      return { rows: [] };
    },
  };
  const migration = { name: "0001_test.sql", checksum: "abc", sql: "SELECT 1" };

  await runMigrations(client, [migration]);
  await runMigrations(client, [migration]);

  assert.equal(
    statements.filter(({ sql }) => sql === migration.sql).length,
    1,
  );
  assert.equal(history.length, 1);
});

test("runMigrations applies concurrent index migrations outside a transaction", async () => {
  const statements = [];
  const client = {
    async query(sql, values) {
      const normalized = sql.trim();
      statements.push(normalized);
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes("SELECT name, checksum FROM app_migrations")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const migration = {
    name: "0002_concurrent_index.sql",
    checksum: "def",
    sql: [
      "-- migrate:no-transaction",
      "DROP INDEX CONCURRENTLY IF EXISTS example_idx;",
      "-- migrate:next-statement",
      "CREATE INDEX CONCURRENTLY example_idx ON example_table (id);",
    ].join("\n"),
  };

  await runMigrations(client, [migration]);

  const dropPosition = statements.findIndex((sql) =>
    sql.includes("DROP INDEX CONCURRENTLY"));
  const createPosition = statements.findIndex((sql) =>
    sql.includes("CREATE INDEX CONCURRENTLY"));
  const historyTransactionPosition = statements.findIndex((sql, index) =>
    index > createPosition && sql === "BEGIN");
  assert.ok(dropPosition >= 0);
  assert.ok(createPosition > dropPosition);
  assert.ok(historyTransactionPosition > createPosition);
});

test("runMigrations recovers a non-transactional index migration after connection loss", async () => {
  const statements = [];
  const indexes = new Set();
  const history = [];
  let failBeforeHistory = true;
  const client = {
    async query(sql, values) {
      const normalized = sql.trim();
      statements.push(normalized);
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes("SELECT name, checksum FROM app_migrations")) {
        return { rows: history };
      }
      if (sql.includes("DROP INDEX CONCURRENTLY")) {
        indexes.delete("example_idx");
      }
      if (sql.includes("CREATE INDEX CONCURRENTLY")) {
        indexes.add("example_idx");
      }
      if (normalized === "BEGIN" && failBeforeHistory) {
        failBeforeHistory = false;
        throw new Error("connection terminated unexpectedly");
      }
      if (sql.includes("INSERT INTO app_migrations")) {
        history.push({ name: values[0], checksum: values[1] });
      }
      return { rows: [] };
    },
  };
  const migration = {
    name: "0002_recoverable_index.sql",
    checksum: "recoverable-index-checksum",
    sql: [
      "-- migrate:no-transaction",
      "DROP INDEX CONCURRENTLY IF EXISTS example_idx;",
      "-- migrate:next-statement",
      "CREATE INDEX CONCURRENTLY example_idx ON example_table (id);",
    ].join("\n"),
  };

  await assert.rejects(
    runMigrations(client, [migration]),
    /connection terminated unexpectedly/,
  );
  assert.equal(indexes.has("example_idx"), true);
  assert.deepEqual(history, []);

  await runMigrations(client, [migration]);

  assert.equal(
    statements.filter((sql) => sql.includes("DROP INDEX CONCURRENTLY")).length,
    2,
  );
  assert.equal(
    statements.filter((sql) => sql.includes("CREATE INDEX CONCURRENTLY")).length,
    2,
  );
  assert.equal(indexes.has("example_idx"), true);
  assert.deepEqual(history, [
    { name: migration.name, checksum: migration.checksum },
  ]);
});

test("runMigrations rejects edited applied migrations", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql.trim());
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes("SELECT name, checksum FROM app_migrations")) {
        return { rows: [{ name: "0001_test.sql", checksum: "old" }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    runMigrations(client, [
      { name: "0001_test.sql", checksum: "new", sql: "SELECT 1" },
    ]),
    /changed after it was applied/,
  );
  assert.ok(
    statements.some((sql) => sql.includes("pg_advisory_unlock")),
    "migration lock should be released after a migration failure",
  );
});

test("lock timeout alert includes its distinct code and configured duration", async () => {
  const requests = [];
  const errors = [];
  const error = new MigrationLockTimeoutError(750);

  const reported = await reportMigrationLockTimeout(error, {
    webhookUrl: "https://alerts.example.test/deployments",
    alertTimeoutMs: 100,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true };
    },
    log: { error: (...args) => errors.push(args) },
  });

  assert.equal(error.code, MIGRATION_LOCK_TIMEOUT_CODE);
  assert.equal(reported, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://alerts.example.test/deployments");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    source: "database-migration",
    event: "migration_lock_timeout",
    severity: "error",
    message: "Rilis gagal: lock migrasi database tidak tersedia setelah 750ms",
    timeoutMs: 750,
  });
  assert.equal(
    JSON.parse(errors[0][0]).event,
    "migration_lock_timeout",
  );
});

test("migration alerts ignore successful waits and other migration failures", async () => {
  let requests = 0;
  const options = {
    webhookUrl: "https://alerts.example.test/deployments",
    alertTimeoutMs: 100,
    fetchImpl: async () => {
      requests += 1;
      return { ok: true };
    },
    log: { error() {} },
  };

  assert.equal(await reportMigrationLockTimeout(undefined, options), false);
  assert.equal(
    await reportMigrationLockTimeout(new Error("migration SQL failed"), options),
    false,
  );
  assert.equal(requests, 0);
});

test("migration process fails clearly when the advisory lock wait times out", async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");

  const databaseName = `migration_timeout_${randomUUID().replaceAll("-", "")}`;
  const adminClient = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${databaseName}"`);

  const databaseUrl = databaseUrlFor(databaseName);
  const lockHolder = new pg.Client({ connectionString: databaseUrl });
  await lockHolder.connect();
  await lockHolder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  t.after(async () => {
    await lockHolder.end();
    await adminClient.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
    await adminClient.end();
  });

  const migration = {
    name: "0001_timeout_test.sql",
    checksum: "timeout-test-checksum",
    sql: "SELECT 1",
  };
  const startedAt = Date.now();
  await assert.rejects(
    runMigrationProcess(databaseUrl, migration, {
      MIGRATION_LOCK_TIMEOUT_MS: "250",
    }),
    /Timed out after 250ms waiting for the database migration lock/,
  );
  assert.ok(
    Date.now() - startedAt < 3_000,
    "waiting migration process should exit promptly",
  );

  await lockHolder.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  await runMigrationProcess(databaseUrl, migration, {
    MIGRATION_LOCK_TIMEOUT_MS: "250",
  });
});

test("two migration processes apply the same migration once", async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");

  const databaseName = `migration_concurrency_${randomUUID().replaceAll("-", "")}`;
  const adminClient = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${databaseName}"`);

  t.after(async () => {
    await adminClient.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
    await adminClient.end();
  });

  const migration = {
    name: "0001_concurrent_test.sql",
    checksum: "concurrent-test-checksum",
    sql: `
      CREATE TABLE migration_effects (
        id integer PRIMARY KEY,
        applications integer NOT NULL
      );
      INSERT INTO migration_effects (id, applications) VALUES (1, 1);
    `,
  };
  const databaseUrl = databaseUrlFor(databaseName);

  await Promise.all([
    runMigrationProcess(databaseUrl, migration),
    runMigrationProcess(databaseUrl, migration),
  ]);

  const verificationClient = new pg.Client({ connectionString: databaseUrl });
  await verificationClient.connect();
  try {
    const effect = await verificationClient.query(
      "SELECT applications FROM migration_effects WHERE id = 1",
    );
    const history = await verificationClient.query(
      "SELECT name, checksum FROM app_migrations",
    );

    assert.deepEqual(effect.rows, [{ applications: 1 }]);
    assert.deepEqual(history.rows, [
      {
        name: migration.name,
        checksum: migration.checksum,
      },
    ]);
  } finally {
    await verificationClient.end();
  }
});
