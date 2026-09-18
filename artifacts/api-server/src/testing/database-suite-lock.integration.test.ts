import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

const workerUrl = new URL("./database-suite-lock.worker.ts", import.meta.url);

type WorkerResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

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