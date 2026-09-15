import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMigrations, runMigrations } from "./migrate.mjs";

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