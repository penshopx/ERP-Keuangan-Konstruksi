import { createInterface } from "node:readline";
import type { AddressInfo } from "node:net";
import express from "express";
import { pool } from "@workspace/db";
import { createApiRouter } from "../routes";
import type { AccessContext } from "../middlewares/access";
import type { ProjectPersistenceHooks } from "../routes/projects";

const [mode, projectId, templateId, priceFactorText, userId] = process.argv.slice(2);
if ((mode !== "fail" && mode !== "succeed") || !projectId || !templateId || !priceFactorText || !userId) {
  throw new Error("Expected mode, projectId, templateId, priceFactor, and userId");
}

const access: AccessContext = {
  userId,
  displayName: `RAB import ${mode} worker`,
  role: "DIRECTOR",
  assignedProjectIds: [],
  permissions: [],
};

let releaseHook!: () => void;
const hookRelease = new Promise<void>((resolve) => {
  releaseHook = resolve;
});
const hooks: ProjectPersistenceHooks = mode === "fail"
  ? {
      beforeRabImportAuditInsert: async (hookProjectId, baselineId, version) => {
        if (hookProjectId !== projectId) throw new Error(`Unexpected project ${hookProjectId}`);
        process.stdout.write(`AFTER_VERSION ${baselineId} ${version}\n`);
        await hookRelease;
        throw new Error("Injected cross-process RAB import failure");
      },
    }
  : {
      beforeRabImportVersionLock: async (hookProjectId) => {
        if (hookProjectId !== projectId) throw new Error(`Unexpected project ${hookProjectId}`);
        process.stdout.write("BEFORE_LOCK\n");
        await hookRelease;
      },
    };

const app = express();
app.use(express.json());
app.use("/api", createApiRouter((req, _res, next) => {
  req.access = access;
  next();
}, {}, hooks));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const { port } = server.address() as AddressInfo;
process.stdout.write(`READY ${port}\n`);

let importStarted = false;
async function runImport() {
  if (importStarted) return;
  importStarted = true;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/rab/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId, priceFactor: Number(priceFactorText) }),
    });
    const text = await response.text();
    process.stdout.write(`RESULT ${response.status} ${Buffer.from(text).toString("base64")}\n`);
  } finally {
    input.close();
    process.stdin.unref();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line === "START") void runImport();
  if (line === "CONTINUE") releaseHook();
});
