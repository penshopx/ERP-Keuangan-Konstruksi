import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadMigrations, runMigrations } from "./migrate.mjs";

const processFixture = fileURLToPath(
  new URL("./migrate-process.fixture.mjs", import.meta.url),
);

function databaseUrlFor(databaseName) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function runMigrationProcess(databaseUrl, migration) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [processFixture], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TEST_MIGRATION: JSON.stringify(migration),
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

test("runMigrations rejects edited applied migrations", async () => {
  const client = {
    async query(sql) {
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
