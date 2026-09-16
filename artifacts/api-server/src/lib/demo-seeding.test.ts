import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldSeedDemoData } from "./demo-seeding";

test("demo data seeding requires development mode and explicit opt-in", () => {
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: "development", SEED_DEMO_DATA: "true" }),
    true,
  );
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: "development", SEED_DEMO_DATA: undefined }),
    false,
  );
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: "development", SEED_DEMO_DATA: "false" }),
    false,
  );
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: "production", SEED_DEMO_DATA: "true" }),
    false,
  );
  assert.equal(
    shouldSeedDemoData({ NODE_ENV: undefined, SEED_DEMO_DATA: "true" }),
    false,
  );
});