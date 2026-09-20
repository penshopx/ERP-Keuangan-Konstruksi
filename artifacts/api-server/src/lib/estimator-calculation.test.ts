import assert from "node:assert/strict";
import test from "node:test";
import { calculateAhsEstimate, MissingEffectivePriceError } from "./estimator-calculation";

const component = {
  id: "component-1", templateId: "template-1", resourceKind: "MATERIAL",
  resourceCode: "MAT-001", resourceName: "Contoh material", unit: "kg",
  coefficientMicros: 1_500_000, wasteBasisPoints: 500,
} as const;
const price = {
  id: "price-1", resourceKind: "MATERIAL", resourceCode: "MAT-001",
  unit: "kg", unitPriceRupiah: 10_000, effectiveFrom: "2026-01-01",
  effectiveTo: null, sourceNote: "Fixture uji", createdAt: new Date(),
} as const;

test("perhitungan AHS deterministik dengan faktor waste", () => {
  const first = calculateAhsEstimate([component], [price]);
  const second = calculateAhsEstimate([component], [price]);
  assert.deepEqual(first, second);
  assert.equal(first.unitPriceRupiah, 15_750);
});

test("harga efektif yang hilang ditolak secara eksplisit", () => {
  assert.throws(
    () => calculateAhsEstimate([component], []),
    (error) => error instanceof MissingEffectivePriceError
      && error.resourceCode === "MAT-001",
  );
});