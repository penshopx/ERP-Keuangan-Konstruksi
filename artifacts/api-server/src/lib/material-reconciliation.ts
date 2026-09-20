export const MATERIAL_QUANTITY_SCALE = 1_000_000;

export type MaterialMovementTotal = {
  movementType: string;
  baseQuantityMicros: number;
};

export function calculateMaterialVariance(input: {
  workQuantityBasisPoints: number;
  coefficientMicros: number;
  toleranceBasisPoints: number;
  movements: MaterialMovementTotal[];
}) {
  const totals = new Map<string, number>();
  for (const movement of input.movements) {
    totals.set(movement.movementType, (totals.get(movement.movementType) ?? 0) + movement.baseQuantityMicros);
  }
  const theoreticalQuantityMicros = Math.round((input.workQuantityBasisPoints / 100) * input.coefficientMicros);
  const consumedQuantityMicros = Math.max(
    0,
    (totals.get("ISSUED") ?? 0) - (totals.get("RETURNED") ?? 0) + (totals.get("ADJUSTMENT") ?? 0),
  );
  const toleranceQuantityMicros = Math.round(theoreticalQuantityMicros * input.toleranceBasisPoints / 10_000);
  const varianceQuantityMicros = consumedQuantityMicros - theoreticalQuantityMicros;
  return {
    totals,
    theoreticalQuantityMicros,
    consumedQuantityMicros,
    toleranceQuantityMicros,
    varianceQuantityMicros,
    exceedsTolerance: varianceQuantityMicros > toleranceQuantityMicros,
  };
}