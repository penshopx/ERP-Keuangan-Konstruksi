import { pool } from "@workspace/db";
import {
  acquirePersistenceDatabaseSuiteLock,
  releasePersistenceDatabaseSuiteLock,
} from "./database-suite-lock";

const holdArgument = process.argv[2];
const timeoutMs = Number(process.argv[3]);
let lockClient: Awaited<ReturnType<typeof acquirePersistenceDatabaseSuiteLock>> | undefined;

try {
  lockClient = await acquirePersistenceDatabaseSuiteLock(timeoutMs);
  process.stdout.write("ACQUIRED\n");
  if (holdArgument === "signal") {
    await new Promise<void>((resolve) => process.once("SIGTERM", resolve));
  } else {
    await new Promise((resolve) => setTimeout(resolve, Number(holdArgument)));
  }
  await releasePersistenceDatabaseSuiteLock(lockClient);
  lockClient = undefined;
  process.stdout.write("RELEASED\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (lockClient) {
    await releasePersistenceDatabaseSuiteLock(lockClient);
  }
  await pool.end();
}