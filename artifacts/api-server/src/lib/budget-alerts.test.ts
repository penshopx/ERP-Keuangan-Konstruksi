import assert from "node:assert/strict";
import test from "node:test";
import { calculateBudgetMeasures, determineAlertAction, exceedsThreshold } from "./budget-alerts";

test("budget measures include actual and remaining approved commitment", () => {
  const measures = calculateBudgetMeasures(1_000, 250, 300, 40);
  assert.deepEqual(measures, {
    currentBudget: 1_000,
    actual: 250,
    remainingCommitment: 300,
    estimateToComplete: 600,
    projectedExposure: 550,
    estimateAtCompletion: 1_150,
  });
});

test("progress is bounded and completed work has no estimate to complete", () => {
  assert.equal(calculateBudgetMeasures(1_000, 0, 0, 120).estimateToComplete, 0);
  assert.equal(calculateBudgetMeasures(1_000, 0, 0, -10).estimateToComplete, 1_000);
});

test("alert lifecycle deduplicates, clears, and reopens as a new cycle", () => {
  assert.equal(determineAlertAction(true, false, true), "CREATE");
  assert.equal(determineAlertAction(true, true, false), "NOOP");
  assert.equal(determineAlertAction(true, true, true), "UPDATE");
  assert.equal(determineAlertAction(false, true, false), "RESOLVE");
  assert.equal(determineAlertAction(false, false, false), "NOOP");
});

test("threshold semantics are strictly greater, including zero exposure and exact EAC", () => {
  assert.equal(exceedsThreshold(0, 1_000, 90), false);
  assert.equal(exceedsThreshold(900, 1_000, 90), false);
  assert.equal(exceedsThreshold(900.01, 1_000, 90), true);
  const exact = calculateBudgetMeasures(1_000, 0, 0, 0);
  assert.equal(exact.estimateAtCompletion, 1_000);
  assert.equal(exceedsThreshold(exact.estimateAtCompletion, 1_000, 100), false);
});