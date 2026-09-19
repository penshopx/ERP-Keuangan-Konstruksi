import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultRabImportLockTimeoutMs,
  getRabImportLockTimeoutMs,
  logRabImportLockTimeout,
} from "./rab-import-config";

function captureConfigLog(environment: NodeJS.ProcessEnv) {
  const entries: Array<{ bindings: unknown; message: string }> = [];
  logRabImportLockTimeout({
    info(bindings, message) {
      entries.push({ bindings, message });
    },
  }, environment);
  return entries;
}

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

test("startup log reports the default RAB import lock timeout", () => {
  assert.deepEqual(captureConfigLog({}), [{
    bindings: {
      event: "rab_import_config",
      rabImportLockTimeoutMs: defaultRabImportLockTimeoutMs,
    },
    message: "RAB import lock timeout configured",
  }]);
});

test("startup log reports the configured RAB import lock timeout", () => {
  assert.deepEqual(
    captureConfigLog({
      RAB_IMPORT_LOCK_TIMEOUT_MS: "12500",
      DATABASE_URL: "postgres://secret-that-must-not-be-logged",
    }),
    [{
      bindings: {
        event: "rab_import_config",
        rabImportLockTimeoutMs: 12_500,
      },
      message: "RAB import lock timeout configured",
    }],
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