import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";
import test from "node:test";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const requiredMigrations = [
  "0001_prevent_overlapping_tax_rule_periods.sql",
  "0002_preserve_multiple_bounded_tax_overrides.sql",
  "0003_add_operational_state.sql",
  "0004_restrict_project_status.sql",
  "0005_add_fixture_ownership.sql",
  "0006_add_shared_invitation_reconciliation_state.sql",
  "0007_index_pending_resend_compensation_audits.sql",
  "0008_record_invitation_acceptance_email.sql",
  "0009_add_project_petty_cash.sql",
  "0010_add_commitment_ledger.sql",
  "0011_add_budget_alerts.sql",
  "0012_add_material_reconciliation.sql",
  "0013_add_estimator_workbench.sql",
  "0014_neutralize_competency_reference_labels.sql",
  "0015_share_reconciliation_alert_incidents.sql",
  "0016_record_operational_alert_delivery.sql",
  "0017_add_copilot_usage.sql",
];
const expectedTables = [
  "actual_cost_allocations",
  "ahs_components",
  "ahs_templates",
  "app_migrations",
  "audit_logs",
  "budget_alert_thresholds",
  "budget_alerts",
  "commitment_events",
  "commitment_lines",
  "commitments",
  "competency_catalog",
  "copilot_limits",
  "copilot_usage",
  "estimate_previews",
  "inventory_movements",
  "invitation_reconciliation_state",
  "invoices",
  "material_variance_events",
  "material_variance_exceptions",
  "material_waste_tolerance_versions",
  "materials",
  "operational_alert_delivery_status",
  "operational_state",
  "petty_cash_expenses",
  "petty_cash_policy_versions",
  "petty_cash_requests",
  "project_assignments",
  "project_cost_codes",
  "projects",
  "rab_baselines",
  "rab_estimate_snapshots",
  "rab_items",
  "rab_material_requirements",
  "rab_templates",
  "resource_prices",
  "staff_invitation_projects",
  "staff_invitations",
  "tax_calculation_snapshots",
  "tax_rule_versions",
  "user_competency_profiles",
  "user_roles",
];

function databaseUrlFor(databaseName: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env,
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
            `${command} ${args.join(" ")} exited with ${code ?? signal}\n${output}`,
          ),
        );
      }
    });
  });
}

async function runPsql(
  sql: string,
  databaseName = process.env.PGDATABASE,
): Promise<string> {
  return runCommand(
    "psql",
    ["-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
    { ...process.env, PGDATABASE: databaseName },
  );
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForHealth(
  child: ChildProcess,
  url: string,
  readOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`API exited before becoming healthy\n${readOutput()}`);
    }
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      // Startup has not opened the port yet.
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (response.ok) {
      const health = await response.json() as {
        status: string;
        invitationReconciliation: {
          status: string;
          consecutiveFailures: number;
          pendingResendCompensations: number;
        };
      };
      assert.equal(health.status, "ok");
      assert.equal(health.invitationReconciliation.status, "HEALTHY");
      assert.equal(health.invitationReconciliation.consecutiveFailures, 0);
      assert.equal(health.invitationReconciliation.pendingResendCompensations, 0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`API health check timed out\n${readOutput()}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000),
    ),
  ]);
}

async function waitForFailedStartup(
  child: ChildProcess,
  healthUrl: string,
  readOutput: () => string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const deadline = Date.now() + 30_000;
  let healthWasReachable = false;

  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  ) {
    try {
      const response = await fetch(healthUrl);
      healthWasReachable = healthWasReachable || response.ok;
    } catch {
      // Expected: startup validation must fail before the port opens.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`API did not exit after startup failure\n${readOutput()}`);
  }

  assert.equal(
    healthWasReachable,
    false,
    `API health check became reachable before startup failed\n${readOutput()}`,
  );

  return { code: child.exitCode, signal: child.signalCode };
}

test("setup prepares an empty PostgreSQL database before API startup", async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");

  const databaseName = `fresh_startup_${randomUUID().replaceAll("-", "")}`;
  const freshDatabaseUrl = databaseUrlFor(databaseName);
  let api: ChildProcess | undefined;

  await runPsql(`CREATE DATABASE "${databaseName}"`);

  t.after(async () => {
    if (api) await stopProcess(api);
    await runPsql(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  });

  const freshEnv = {
    ...process.env,
    DATABASE_URL: freshDatabaseUrl,
    INVITATION_RECONCILIATION_ALERT_STALE_AFTER_MS: "60000",
    NODE_ENV: "production",
    SEED_DEMO_DATA: "true",
  };
  await runCommand(
    "pnpm",
    ["--filter", "@workspace/api-server", "run", "build"],
    freshEnv,
  );
  const port = await reservePort();
  let apiOutput = "";
  api = spawn(
    "pnpm",
    ["--filter", "@workspace/api-server", "run", "start:with-migrations"],
    {
      cwd: workspaceRoot,
      env: { ...freshEnv, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  api.stdout?.on("data", (chunk) => {
    apiOutput += chunk;
  });
  api.stderr?.on("data", (chunk) => {
    apiOutput += chunk;
  });

  await waitForHealth(
    api,
    `http://127.0.0.1:${port}/api/healthz`,
    () => apiOutput,
  );

  const tables = (
    await runPsql(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
      `,
      databaseName,
    )
  )
    .trim()
    .split("\n");
  assert.deepEqual(tables, expectedTables);

  const demoProjectCount = (
    await runPsql(
      "SELECT count(*) FROM projects WHERE id IN ('prj-001', 'prj-002', 'prj-003', 'prj-004')",
      databaseName,
    )
  ).trim();
  assert.equal(demoProjectCount, "0");

  const history = (
    await runPsql(
      "SELECT name FROM app_migrations ORDER BY name",
      databaseName,
    )
  )
    .trim()
    .split("\n");
  assert.deepEqual(history, requiredMigrations);

  const constraints = (
    await runPsql(
      `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid IN ('projects'::regclass, 'tax_rule_versions'::regclass)
        AND conname IN (
          'projects_status_supported',
          'tax_rule_versions_valid_period',
          'tax_rule_versions_no_overlapping_periods'
        )
      ORDER BY conname
      `,
      databaseName,
    )
  )
    .trim()
    .split("\n");
  assert.deepEqual(constraints, [
    "projects_status_supported",
    "tax_rule_versions_no_overlapping_periods",
    "tax_rule_versions_valid_period",
  ]);
});

test("API rejects invalid invitation reconciliation stale alert thresholds before opening its port", async (t) => {
  const invalidValues = [
    { name: "empty", value: "" },
    { name: "zero", value: "0" },
    { name: "negative", value: "-1" },
    { name: "fractional", value: "1.5" },
    { name: "non-numeric", value: "not-a-number" },
  ];
  const children = new Set<ChildProcess>();

  t.after(async () => {
    await Promise.all([...children].map((child) => stopProcess(child)));
  });

  await runCommand(
    "pnpm",
    ["--filter", "@workspace/api-server", "run", "build"],
    process.env,
  );

  for (const invalid of invalidValues) {
    await t.test(invalid.name, async () => {
      const port = await reservePort();
      let apiOutput = "";
      const api = spawn(
        "pnpm",
        ["--filter", "@workspace/api-server", "run", "start"],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            PORT: String(port),
            INVITATION_RECONCILIATION_ALERT_STALE_AFTER_MS: invalid.value,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(api);
      api.stdout?.on("data", (chunk) => {
        apiOutput += chunk;
      });
      api.stderr?.on("data", (chunk) => {
        apiOutput += chunk;
      });

      const healthUrl = `http://127.0.0.1:${port}/api/healthz`;
      const exit = await waitForFailedStartup(api, healthUrl, () => apiOutput);

      assert.notEqual(
        exit.code,
        0,
        `API unexpectedly accepted ${invalid.name} threshold\n${apiOutput}`,
      );
      assert.equal(exit.signal, null);
      assert.match(
        apiOutput,
        /INVITATION_RECONCILIATION_ALERT_STALE_AFTER_MS/,
      );
      await assert.rejects(fetch(healthUrl), /fetch failed/);
      children.delete(api);
    });
  }
});

test("API exits before opening its port when mandatory migrations are missing", async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");

  const databaseName = `failed_startup_${randomUUID().replaceAll("-", "")}`;
  const emptyDatabaseUrl = databaseUrlFor(databaseName);
  let api: ChildProcess | undefined;

  await runPsql(`CREATE DATABASE "${databaseName}"`);

  t.after(async () => {
    if (api) await stopProcess(api);
    await runPsql(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  });

  const startupEnv = {
    ...process.env,
    DATABASE_URL: emptyDatabaseUrl,
    NODE_ENV: "production",
    SEED_DEMO_DATA: "false",
  };
  await runCommand(
    "pnpm",
    ["--filter", "@workspace/api-server", "run", "build"],
    startupEnv,
  );
  await runCommand(
    "pnpm",
    ["--filter", "@workspace/db", "run", "setup"],
    startupEnv,
  );
  await runPsql(
    `
    DROP INDEX audit_logs_pending_resend_compensation_idx;
    DELETE FROM app_migrations
    WHERE name = '0007_index_pending_resend_compensation_audits.sql';
    `,
    databaseName,
  );

  const port = await reservePort();
  let apiOutput = "";
  api = spawn(
    "pnpm",
    ["--filter", "@workspace/api-server", "run", "start"],
    {
      cwd: workspaceRoot,
      env: { ...startupEnv, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  api.stdout?.on("data", (chunk) => {
    apiOutput += chunk;
  });
  api.stderr?.on("data", (chunk) => {
    apiOutput += chunk;
  });

  const exit = await waitForFailedStartup(
    api,
    `http://127.0.0.1:${port}/api/healthz`,
    () => apiOutput,
  );

  assert.notEqual(exit.code, 0, `API unexpectedly exited successfully\n${apiOutput}`);
  assert.equal(exit.signal, null);
  assert.match(
    apiOutput,
    /Mandatory database migrations? .* (?:is|are) not fully applied/,
  );
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/api/healthz`),
    /fetch failed/,
  );
});