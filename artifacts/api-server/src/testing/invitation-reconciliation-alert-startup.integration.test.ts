import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

type AlertPayload = {
  source: string;
  event: string;
  severity: string;
  message: string;
  type: string;
};

function databaseUrlFor(name: string) {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

function command(commandName: string, args: string[], env = process.env) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: workspaceRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${commandName} ${args.join(" ")} failed\n${output}`));
    });
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

async function startWebhook() {
  const received: AlertPayload[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      received.push(JSON.parse(body) as AlertPayload);
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    received,
    server,
    url: `http://127.0.0.1:${address.port}/alerts`,
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function stopProcess(child: ChildProcess) {
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

async function waitForAlert(
  child: ChildProcess,
  alerts: AlertPayload[],
  output: () => string,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (alerts.length > 0) return alerts[0]!;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`API exited before sending an alert\n${output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for operational alert\n${output()}`);
}

function startApi(env: NodeJS.ProcessEnv) {
  const child = spawn(
    "pnpm",
    ["--filter", "@workspace/api-server", "run", "start"],
    {
      cwd: workspaceRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => output += chunk);
  child.stderr?.on("data", (chunk) => output += chunk);
  return { child, output: () => output };
}

test("API startup routes reconciliation degradation and recovery to the configured channels", async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const database = `reconciliation_alert_startup_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = databaseUrlFor(database);
  const shared = await startWebhook();
  const override = await startWebhook();
  const children: ChildProcess[] = [];

  await psql(`CREATE DATABASE "${database}"`);
  t.after(async () => {
    await Promise.all(children.map(stopProcess));
    await Promise.all([closeServer(shared.server), closeServer(override.server)]);
    await psql(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  });

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    SEED_DEMO_DATA: "false",
    CLERK_SECRET_KEY: "sk_test_invalid_for_reconciliation_startup_test",
    OPERATIONAL_ALERT_WEBHOOK_URL: shared.url,
    INVITATION_RECONCILIATION_ALERT_FAILURE_THRESHOLD: "1",
    INVITATION_RECONCILIATION_ALERT_STALE_AFTER_MS: "60000",
  };
  delete baseEnv.INVITATION_RECONCILIATION_ALERT_WEBHOOK_URL;

  await command("pnpm", ["--filter", "@workspace/db", "run", "setup"], baseEnv);
  await command("pnpm", ["--filter", "@workspace/api-server", "run", "build"], baseEnv);
  await psql(`
    INSERT INTO user_roles (user_id, role, display_name)
    VALUES ('alert-startup-director', 'DIRECTOR', 'Alert Startup Director');
    INSERT INTO staff_invitations
      (id, clerk_invitation_id, email, display_name, role, expires_at, invited_by_user_id)
    VALUES
      ('alert-startup-invitation', 'alert-startup-clerk', 'alert-startup@example.test',
       'Alert Startup', 'TAX_STAFF', now() + interval '1 day', 'alert-startup-director');
  `, database);

  const degradedApi = startApi({
    ...baseEnv,
    PORT: String(await reservePort()),
  });
  children.push(degradedApi.child);
  const degraded = await waitForAlert(
    degradedApi.child,
    shared.received,
    degradedApi.output,
  );
  assert.deepEqual(
    {
      source: degraded.source,
      event: degraded.event,
      severity: degraded.severity,
      message: degraded.message,
      type: degraded.type,
    },
    {
      source: "invitation-reconciliation",
      event: "invitation_reconciliation_degraded",
      severity: "error",
      message: "Rekonsiliasi undangan gagal 1 kali berturut-turut",
      type: "DEGRADED",
    },
  );
  assert.equal(override.received.length, 0);
  await stopProcess(degradedApi.child);

  await psql(
    "UPDATE staff_invitations SET status = 'CANCELED' WHERE id = 'alert-startup-invitation'",
    database,
  );

  const recoveredApi = startApi({
    ...baseEnv,
    PORT: String(await reservePort()),
    INVITATION_RECONCILIATION_ALERT_WEBHOOK_URL: override.url,
  });
  children.push(recoveredApi.child);
  const recovered = await waitForAlert(
    recoveredApi.child,
    override.received,
    recoveredApi.output,
  );
  assert.deepEqual(
    {
      source: recovered.source,
      event: recovered.event,
      severity: recovered.severity,
      message: recovered.message,
      type: recovered.type,
    },
    {
      source: "invitation-reconciliation",
      event: "invitation_reconciliation_recovered",
      severity: "info",
      message: "Rekonsiliasi undangan telah pulih",
      type: "RECOVERED",
    },
  );
  assert.equal(shared.received.length, 1);
});