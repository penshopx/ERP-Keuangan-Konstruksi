import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function databaseUrlFor(name: string) {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

function command(command: string, args: string[], env = process.env) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspaceRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

async function psql(sql: string, database?: string) {
  return command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    ...process.env,
    PGDATABASE: database,
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startWorker(databaseUrl: string) {
  const port = await reservePort();
  const child = spawn(
    "pnpm",
    ["--filter", "@workspace/api-server", "exec", "tsx", "src/testing/invitation-reconciliation-process-fixture.ts"],
    {
      cwd: workspaceRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => output += chunk);
  child.stderr?.on("data", (chunk) => output += chunk);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Worker exited during startup\n${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) break;
    } catch {
      // The worker has not opened its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (Date.now() >= deadline) throw new Error(`Worker startup timed out\n${output}`);
  return { child, baseUrl: `http://127.0.0.1:${port}`, output: () => output };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000)),
  ]);
}

async function health(baseUrl: string) {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    status: string;
    consecutiveFailures: number;
    lastRun: { outcome: string; occurredAt: string | null; failed?: number };
  }>;
}

async function waitForBlockedLookup(baseUrl: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/blocked-lookup`);
    if ((await response.json() as { started: boolean }).started) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Blocked reconciliation lookup did not start");
}

test("independent API processes share reconciliation health and preserve newest run events", async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const database = `reconciliation_process_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = databaseUrlFor(database);
  const workers: Array<Awaited<ReturnType<typeof startWorker>>> = [];

  await psql(`CREATE DATABASE "${database}"`);
  t.after(async () => {
    await Promise.all(workers.map(({ child }) => stop(child)));
    await psql(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  });
  const env = { ...process.env, DATABASE_URL: databaseUrl, SEED_DEMO_DATA: "false" };
  await command("pnpm", ["--filter", "@workspace/db", "run", "setup"], env);
  await psql(`
    INSERT INTO user_roles (user_id, role, display_name)
    VALUES ('process-test-director', 'DIRECTOR', 'Process Test Director');
    INSERT INTO staff_invitations
      (id, clerk_invitation_id, email, display_name, role, expires_at, invited_by_user_id)
    VALUES
      ('process-test-invitation', 'process-test-clerk', 'process-test@example.test',
       'Process Test', 'TAX_STAFF', now() + interval '1 day', 'process-test-director');
  `, database);

  workers.push(await startWorker(databaseUrl), await startWorker(databaseUrl));
  const [first, second] = workers;

  const failed = await fetch(`${first.baseUrl}/run/failed`, { method: "POST" });
  assert.equal(failed.status, 204);
  const failedSeenElsewhere = await health(second.baseUrl);
  assert.equal(failedSeenElsewhere.status, "DEGRADED");
  assert.equal(failedSeenElsewhere.consecutiveFailures, 1);
  assert.equal(failedSeenElsewhere.lastRun.outcome, "FAILED");

  const completed = await fetch(`${second.baseUrl}/run/completed`, { method: "POST" });
  assert.equal(completed.status, 200);
  const completedSeenElsewhere = await health(first.baseUrl);
  assert.equal(completedSeenElsewhere.status, "HEALTHY");
  assert.equal(completedSeenElsewhere.consecutiveFailures, 0);
  assert.equal(completedSeenElsewhere.lastRun.outcome, "COMPLETED");

  const blockedRun = fetch(`${first.baseUrl}/run/blocked`, { method: "POST" });
  await waitForBlockedLookup(first.baseUrl);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const skipped = await fetch(`${second.baseUrl}/run/completed`, { method: "POST" });
  assert.deepEqual(await skipped.json(), { skipped: true });
  const skippedSeenElsewhere = await health(first.baseUrl);
  assert.equal(skippedSeenElsewhere.status, "HEALTHY");
  assert.equal(skippedSeenElsewhere.lastRun.outcome, "SKIPPED");
  const skippedAt = skippedSeenElsewhere.lastRun.occurredAt;

  await fetch(`${first.baseUrl}/release`, { method: "POST" });
  assert.equal((await blockedRun).status, 200);
  const afterOlderCompletion = await health(second.baseUrl);
  assert.equal(afterOlderCompletion.status, "HEALTHY");
  assert.equal(afterOlderCompletion.lastRun.outcome, "SKIPPED");
  assert.equal(afterOlderCompletion.lastRun.occurredAt, skippedAt);
});