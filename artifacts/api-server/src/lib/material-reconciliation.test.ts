import assert from "node:assert/strict";
import test from "node:test";
import { calculateMaterialVariance, MATERIAL_QUANTITY_SCALE } from "./material-reconciliation";

test("derives theoretical material need from work quantity and versioned coefficient", () => {
  const result = calculateMaterialVariance({
    workQuantityBasisPoints: 1_250,
    coefficientMicros: 2.4 * MATERIAL_QUANTITY_SCALE,
    toleranceBasisPoints: 500,
    movements: [],
  });

  assert.equal(result.theoreticalQuantityMicros, 30 * MATERIAL_QUANTITY_SCALE);
  assert.equal(result.toleranceQuantityMicros, 1.5 * MATERIAL_QUANTITY_SCALE);
  assert.equal(result.exceedsTolerance, false);
});

test("uses warehouse issues less returns and flags only quantities above tolerance", () => {
  const result = calculateMaterialVariance({
    workQuantityBasisPoints: 1_000,
    coefficientMicros: 2 * MATERIAL_QUANTITY_SCALE,
    toleranceBasisPoints: 500,
    movements: [
      { movementType: "ISSUED", baseQuantityMicros: 24 * MATERIAL_QUANTITY_SCALE },
      { movementType: "RETURNED", baseQuantityMicros: 2 * MATERIAL_QUANTITY_SCALE },
      { movementType: "RECEIVED", baseQuantityMicros: 30 * MATERIAL_QUANTITY_SCALE },
    ],
  });

  assert.equal(result.theoreticalQuantityMicros, 20 * MATERIAL_QUANTITY_SCALE);
  assert.equal(result.consumedQuantityMicros, 22 * MATERIAL_QUANTITY_SCALE);
  assert.equal(result.toleranceQuantityMicros, MATERIAL_QUANTITY_SCALE);
  assert.equal(result.varianceQuantityMicros, 2 * MATERIAL_QUANTITY_SCALE);
  assert.equal(result.exceedsTolerance, true);
});

test("does not let returns create negative material consumption", () => {
  const result = calculateMaterialVariance({
    workQuantityBasisPoints: 100,
    coefficientMicros: MATERIAL_QUANTITY_SCALE,
    toleranceBasisPoints: 0,
    movements: [
      { movementType: "ISSUED", baseQuantityMicros: MATERIAL_QUANTITY_SCALE },
      { movementType: "RETURNED", baseQuantityMicros: 2 * MATERIAL_QUANTITY_SCALE },
    ],
  });

  assert.equal(result.consumedQuantityMicros, 0);
  assert.equal(result.exceedsTolerance, false);
});