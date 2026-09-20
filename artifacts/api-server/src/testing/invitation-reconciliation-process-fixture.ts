import express from "express";
import {
  getInvitationReconciliationHealth,
  runScheduledInvitationReconciliation,
  schedulePendingInvitationReconciliation,
} from "../lib/invitation-reconciliation";
import { pool } from "@workspace/db";

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT is required");

let releaseBlockedLookup: (() => void) | undefined;
let blockedLookupStarted = false;

const app = express();
app.get("/health", async (_req, res, next) => {
  try {
    res.json(await getInvitationReconciliationHealth());
  } catch (error) {
    next(error);
  }
});
app.get("/blocked-lookup", (_req, res) => {
  res.json({ started: blockedLookupStarted });
});
app.post("/run/:mode", async (req, res, next) => {
  try {
    const mode = req.params.mode;
    if (mode === "failed") {
      await pool.query("alter table staff_invitations rename to staff_invitations_process_test_unavailable");
      try {
        const scheduler = schedulePendingInvitationReconciliation({
          getClerkInvitation: async () => ({ status: "pending" }),
        }, { runImmediately: false });
        await scheduler.run();
        await scheduler.stop();
      } finally {
        await pool.query(
          "alter table staff_invitations_process_test_unavailable rename to staff_invitations",
        );
      }
      res.sendStatus(204);
      return;
    }
    const result = await runScheduledInvitationReconciliation({
      getClerkInvitation: async () => {
        if (mode === "blocked") {
          blockedLookupStarted = true;
          await new Promise<void>((resolve) => {
            releaseBlockedLookup = resolve;
          });
        }
        return { status: "pending" };
      },
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});
app.post("/release", (_req, res) => {
  releaseBlockedLookup?.();
  releaseBlockedLookup = undefined;
  blockedLookupStarted = false;
  res.sendStatus(204);
});

const server = app.listen(port, "127.0.0.1", () => {
  process.send?.({ ready: true });
});

async function stop() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void stop().then(() => process.exit(0), () => process.exit(1));
  });
}