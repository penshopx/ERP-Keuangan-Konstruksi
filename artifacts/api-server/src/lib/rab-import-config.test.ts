import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultRabImportLockTimeoutMs,
  getRabImportLockTimeoutMs,
} from "./rab-import-config";

test("RAB import lock timeout uses the safe default when configuration is absent", () => {
  assert.equal(
    getRabImportLockTimeoutMs({}),
    defaultRabImportLockTimeoutMs,
  );
});

test("RAB import lock timeout accepts a configured positive integer", () => {
  assert.equal(
    getRabImportLockTimeoutMs({ RAB_IMPORT_LOCK_TIMEOUT_MS: "12500" }),
    12_500,
  );
});

for (const invalidValue of ["", "0", "-1", "1.5", "invalid"]) {
  test(`RAB import lock timeout rejects invalid value ${JSON.stringify(invalidValue)}`, () => {
    assert.throws(
      () => getRabImportLockTimeoutMs({
        RAB_IMPORT_LOCK_TIMEOUT_MS: invalidValue,
      }),
      new RegExp(
        `RAB_IMPORT_LOCK_TIMEOUT_MS must be a positive integer; received`,
      ),
    );
  });
}