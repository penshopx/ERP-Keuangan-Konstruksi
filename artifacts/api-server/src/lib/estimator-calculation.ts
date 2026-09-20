import type { AhsComponent, ResourcePrice } from "@workspace/db";

export class MissingEffectivePriceError extends Error {
  constructor(public readonly resourceKind: string, public readonly resourceCode: string) {
    super(`Harga efektif belum tersedia untuk ${resourceKind}:${resourceCode}`);
  }
}

export function calculateAhsEstimate(
  components: AhsComponent[],
  prices: ResourcePrice[],
) {
  const priceByResource = new Map(prices.map((price) => [`${price.resourceKind}:${price.resourceCode}`, price]));
  const formula = components.map((component) => {
    const price = priceByResource.get(`${component.resourceKind}:${component.resourceCode}`);
    if (!price) throw new MissingEffectivePriceError(component.resourceKind, component.resourceCode);
    const componentUnitCost = Math.round(
      component.coefficientMicros * price.unitPriceRupiah
      * (10_000 + component.wasteBasisPoints) / 10_000 / 1_000_000,
    );
    return { ...component, unitPriceRupiah: price.unitPriceRupiah, componentUnitCost };
  });
  const unitPriceRupiah = formula.reduce((sum, row) => sum + row.componentUnitCost, 0);
  return { formula, unitPriceRupiah };
}