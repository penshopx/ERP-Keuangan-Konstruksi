import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

const workerUrl = new URL(
  "./invitation-reconciliation-crash.worker.ts",
  import.meta.url,
);

type Worker = ReturnType<typeof startWorker>;

function startWorker(mode: "hold" | "run") {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerUrl.pathname, mode],
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
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, result, stdout: () => stdout, stderr: () => stderr };
}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
  read: () => string,
) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${JSON.stringify(expected)}; received ${JSON.stringify(read())}`,
        ),
      );
    }, 5_000);
    const onData = () => {
      if (!read().includes(expected)) return;
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(
        new Error(
          `Worker exited before ${JSON.stringify(expected)}; received ${JSON.stringify(read())}`,
        ),
      );
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

async function killWorker(worker: Worker) {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill("SIGKILL");
  }
  return worker.result;
}

test("scheduled reconciliation resumes after the lock holder crashes", async () => {
  const holder = startWorker("hold");
  let successor: Worker | undefined;
  try {
    await waitForOutput(holder.child, "ACQUIRED", holder.stdout);

    const crashed = await killWorker(holder);
    assert.equal(crashed.signal, "SIGKILL");
    assert.equal(holder.stdout().includes("RELEASED"), false);

    const startedAt = Date.now();
    successor = startWorker("run");
    const completed = await successor.result;
    const elapsedMs = Date.now() - startedAt;

    assert.equal(completed.code, 0, successor.stderr());
    assert.match(successor.stdout(), /^COMPLETED \d+\n$/);
    assert.ok(
      elapsedMs < 2_500,
      `successor took ${elapsedMs}ms to continue reconciliation`,
    );
  } finally {
    await Promise.all([
      killWorker(holder),
      ...(successor ? [killWorker(successor)] : []),
    ]);
  }
});