import pg from "pg";
import { runMigrations } from "./migrate.mjs";

const migration = JSON.parse(process.env.TEST_MIGRATION);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
try {
  await runMigrations(client, [migration]);
} finally {
  await client.end();
}