import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { after, test } from "node:test";
import { createDatabasePool, pool } from "@workspace/db";
import {
  acquireDatabaseSuiteLock,
  acquirePersistenceDatabaseSuiteLock,
  describeDatabaseSuiteError,
  isDatabaseClientTimeout,
  isDatabaseStatementTimeout,
  releaseDatabaseSuiteLock,
  releasePersistenceDatabaseSuiteLock,
  runDatabaseSuiteOperation,
  setDatabaseSuitePoolStatementTimeout,
  setDatabaseSuiteStatementTimeout,
} from "./database-suite-lock";
import {
  getAccessDatabaseSuiteConfig,
  getDemoSeedingDatabaseSuiteConfig,
  getPersistenceDatabaseSuiteConfig,
} from "./database-suite-config";

const workerUrl = new URL("./database-suite-lock.worker.ts", import.meta.url);

type WorkerResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

after(async () => {
  await pool.end();
});

function startWorker(hold: number | "signal", timeoutMs: number) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerUrl.pathname, String(hold), String(timeoutMs)],
    { cwd: process.cwd(), env: process.env },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    output: () => ({ stdout, stderr }),
    result: new Promise<WorkerResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    }),
  };
}

async function stopWorker(worker: ReturnType<typeof startWorker>) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return worker.result;
  worker.child.kill("SIGTERM");
  const exited = await Promise.race([
    worker.result,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
  ]);
  if (exited) return exited;
  worker.child.kill("SIGKILL");
  return worker.result;
}

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string, read: () => string) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for worker output ${JSON.stringify(expected)}; received ${JSON.stringify(read())}`));
    }, 15_000);
    const onData = () => {
      if (!read().includes(expected)) return;
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Worker exited before writing ${JSON.stringify(expected)}; received ${JSON.stringify(read())}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.once("close", onClose);
    onData();
  });
}

test("database suite pool applies configurable client-side timeouts", () => {
  setDatabaseSuitePoolStatementTimeout("client-timeout regression", 1_234);

  assert.equal(pool.options.statement_timeout, 1_234);
  assert.equal(pool.options.query_timeout, 1_234);
  assert.equal(pool.options.connectionTimeoutMillis, 1_234);
});

test("client timeout errors identify the suite and configured limit", async () => {
  const driverError = new Error("Query read timeout");
  const wrappedError = new Error("Failed while acquiring the database lock", {
    cause: driverError,
  });

  await assert.rejects(
    runDatabaseSuiteOperation(
      async () => {
        throw wrappedError;
      },
      "Disconnected database regression",
      321,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Disconnected database regression database operation exceeded the 321ms client timeout/,
      );
      assert.equal(isDatabaseClientTimeout(error), true);
      assert.equal(error.cause, wrappedError);
      return true;
    },
  );

  assert.equal(
    describeDatabaseSuiteError(wrappedError, "Disconnected database regression", 321) instanceof Error,
    true,
  );
});

test("a non-responsive database connection times out and its pool closes", async () => {
  const timeoutMs = 100;
  const suiteName = "Non-responsive database regression";
  const serverSockets = new Set<Socket>();
  const stalledServer = createServer((socket) => {
    // Accept the TCP connection without completing the PostgreSQL handshake.
    serverSockets.add(socket);
    socket.once("close", () => serverSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    stalledServer.once("error", reject);
    stalledServer.listen(0, "127.0.0.1", resolve);
  });
  const address = stalledServer.address();
  assert.ok(address && typeof address === "object");
  const stalledPool = createDatabasePool({
    host: "127.0.0.1",
    port: address.port,
    user: "validation",
    password: "validation",
    database: "validation",
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  const startedAt = Date.now();

  try {
    await assert.rejects(
      runDatabaseSuiteOperation(
        () => stalledPool.query("SELECT 1"),
        suiteName,
        timeoutMs,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /Non-responsive database regression database operation exceeded the 100ms client timeout/,
        );
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2_000, "stalled connection did not terminate promptly");
  } finally {
    try {
      await Promise.race([
        stalledPool.end(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out closing the stalled database pool")), 2_000);
        }),
      ]);
    } finally {
      for (const socket of serverSockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        stalledServer.close((error) => error ? reject(error) : resolve());
      });
    }
  }
});

test("database suite advisory lock serializes separate validation processes", async () => {
  const first = startWorker("signal", 5_000);
  let second: ReturnType<typeof startWorker> | undefined;
  try {
    await waitForOutput(first.child, "ACQUIRED", () => first.output().stdout);
    second = startWorker(0, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(second.output().stdout.includes("ACQUIRED"), false, "second process acquired the lock before the first released it");

    first.child.kill("SIGTERM");
    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    assert.match(firstResult.stdout, /ACQUIRED\nRELEASED\n/);
    assert.match(secondResult.stdout, /ACQUIRED\nRELEASED\n/);
  } finally {
    await Promise.all([stopWorker(first), ...(second ? [stopWorker(second)] : [])]);
  }
});

test("database suite advisory lock exits non-zero with an explicit timeout", async () => {
  const holder = startWorker("signal", 5_000);
  let timedOut: ReturnType<typeof startWorker> | undefined;
  try {
    await waitForOutput(holder.child, "ACQUIRED", () => holder.output().stdout);
    timedOut = startWorker(0, 300);
    const timedOutResult = await timedOut.result;

    assert.notEqual(timedOutResult.code, 0);
    assert.match(
      timedOutResult.stderr,
      /Could not acquire the persistence integration database lock within 300ms; another database-backed validation may still be running/,
    );
    assert.equal(timedOutResult.stdout.includes("ACQUIRED"), false);

    holder.child.kill("SIGTERM");
    const holderResult = await holder.result;
    assert.equal(holderResult.code, 0, holderResult.stderr);
  } finally {
    await Promise.all([stopWorker(holder), ...(timedOut ? [stopWorker(timedOut)] : [])]);
  }
});

test("statement timeout still cleans fixtures and releases the database suite lock", async () => {
  const runId = randomUUID();
  const lockOptions = {
    lockName: `api-server:statement-timeout-lock-regression:${runId}`,
    suiteName: "statement-timeout lock regression",
  };
  const statementTimeoutMs = 50;
  const fixtureId = `timeout-fixture-${runId}`;
  const client = await acquireDatabaseSuiteLock({ ...lockOptions, timeoutMs: 5_000 });
  let testError: unknown;

  try {
    await setDatabaseSuiteStatementTimeout(client, lockOptions.suiteName, statementTimeoutMs);
    await client.query("CREATE TEMP TABLE database_suite_lock_timeout_fixtures (id text PRIMARY KEY)");
    await client.query("INSERT INTO database_suite_lock_timeout_fixtures (id) VALUES ($1)", [fixtureId]);
    await client.query("SELECT pg_sleep(1)");
    assert.fail("Expected PostgreSQL to cancel pg_sleep at the configured statement timeout");
  } catch (error) {
    testError = isDatabaseStatementTimeout(error)
      ? new Error(
        `Statement-timeout lock regression query exceeded the ${statementTimeoutMs}ms statement timeout`,
        { cause: error },
      )
      : error;
  } finally {
    await client.query("DELETE FROM database_suite_lock_timeout_fixtures WHERE id = $1", [fixtureId]);
    const remainingFixtures = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM database_suite_lock_timeout_fixtures WHERE id = $1",
      [fixtureId],
    );
    assert.equal(remainingFixtures.rows[0]?.count, "0", "timeout fixture was not cleaned up");
    await releaseDatabaseSuiteLock(client, lockOptions);
  }

  assert.ok(testError instanceof Error);
  assert.match(
    testError.message,
    /Statement-timeout lock regression query exceeded the 50ms statement timeout/,
  );
  assert.equal(isDatabaseStatementTimeout(testError), true);

  const reacquiredClient = await acquireDatabaseSuiteLock({ ...lockOptions, timeoutMs: 1_000 });
  await releaseDatabaseSuiteLock(reacquiredClient, lockOptions);
});

for (const [timeoutEnvironmentName, expectedSuiteName, getConfig] of [
  [
    "PERSISTENCE_TEST_STATEMENT_TIMEOUT_MS",
    "Persistence integration suite",
    getPersistenceDatabaseSuiteConfig,
  ],
  [
    "ACCESS_TEST_STATEMENT_TIMEOUT_MS",
    "Access integration suite",
    getAccessDatabaseSuiteConfig,
  ],
  [
    "DEMO_SEEDING_TEST_STATEMENT_TIMEOUT_MS",
    "Demo seeding suite",
    getDemoSeedingDatabaseSuiteConfig,
  ],
] as const) {
  test(`${timeoutEnvironmentName} reports its suite name and timeout while leaving the shared lock reusable`, async () => {
    const statementTimeoutMs = 50;
    const config = getConfig({ [timeoutEnvironmentName]: String(statementTimeoutMs) });
    assert.equal(config.suiteName, expectedSuiteName);
    const fixtureName = `timeout-cleanup-${randomUUID()}`;
    let client = await acquirePersistenceDatabaseSuiteLock(5_000);

    try {
      await setDatabaseSuiteStatementTimeout(client, config.suiteName, config.statementTimeoutMs);
      await client.query(
        "CREATE TEMP TABLE IF NOT EXISTS shared_suite_timeout_cleanup (name text PRIMARY KEY)",
      );
      await client.query("INSERT INTO shared_suite_timeout_cleanup (name) VALUES ($1)", [fixtureName]);

      await assert.rejects(
        runDatabaseSuiteOperation(
          () => client.query("SELECT pg_sleep(1)"),
          config.suiteName,
          config.statementTimeoutMs,
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            `${expectedSuiteName} database query exceeded the ${statementTimeoutMs}ms statement timeout`,
          );
          return true;
        },
      );

      await client.query("DELETE FROM shared_suite_timeout_cleanup WHERE name = $1", [fixtureName]);
      const remaining = await client.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM shared_suite_timeout_cleanup WHERE name = $1",
        [fixtureName],
      );
      assert.equal(remaining.rows[0]?.count, "0");
    } finally {
      await releasePersistenceDatabaseSuiteLock(client);
    }

    client = await acquirePersistenceDatabaseSuiteLock(1_000);
    await releasePersistenceDatabaseSuiteLock(client);
  });
}
