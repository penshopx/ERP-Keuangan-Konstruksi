import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const databaseName = `finance_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
const databaseUrl = new URL(url);
databaseUrl.pathname = `/${databaseName}`;

async function command(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (b) => { output += b; });
    child.stderr.on("data", (b) => { output += b; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${output.slice(-3000)}`)));
  });
}

test("period close guards posting and preserves issued reports across approved reopen", async () => {
  await command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", url.toString(), "-c", `CREATE DATABASE "${databaseName}"`]);
  try {
    await command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl.toString(), "-c", `
      CREATE TABLE projects (id text PRIMARY KEY);
      CREATE TABLE audit_logs (
        id text PRIMARY KEY, action text NOT NULL, entity text NOT NULL, entity_id text,
        detail text NOT NULL, "user" text NOT NULL, actor_user_id text, actor_role text,
        tone text NOT NULL, metadata jsonb, "timestamp" timestamptz NOT NULL DEFAULT now()
      );
    `]);
    await command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl.toString(), "-f", path.join(root, "lib/db/migrations/0023_finance_periods.sql")]);
    await command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl.toString(), "-f", path.join(root, "lib/db/migrations/0024_guard_prior_period_posting.sql")]);
    await command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl.toString(), "-f", path.join(root, "lib/db/migrations/0025_serialize_finance_issuance.sql")]);
    await command("pnpm", ["--filter", "@workspace/api-server", "exec", "tsx", "src/routes/finance.worker.ts"],
      { ...process.env, DATABASE_URL: databaseUrl.toString() });
  } finally {
    await command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", url.toString(), "-c", `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`]);
  }
});