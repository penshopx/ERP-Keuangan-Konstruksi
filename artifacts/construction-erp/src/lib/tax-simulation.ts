export type TaxSimulationRule = {
  dppRateBasisPoints: number;
  ppnRateBasisPoints: number;
  pphFinalRateBasisPoints: number;
  pph23RateBasisPoints: number;
  supplierPkp: boolean;
  governmentCollector: boolean;
};

export function calculateTaxSimulation(invoiceValue: number, rule: TaxSimulationRule) {
  const dpp = Math.round(invoiceValue * rule.dppRateBasisPoints / 10_000);
  const ppn = rule.supplierPkp ? Math.round(dpp * rule.ppnRateBasisPoints / 10_000) : 0;
  const pphFinal = Math.round(invoiceValue * rule.pphFinalRateBasisPoints / 10_000);
  const pph23 = Math.round(invoiceValue * rule.pph23RateBasisPoints / 10_000);
  const total = invoiceValue + (rule.governmentCollector ? 0 : ppn) - pphFinal - pph23;

  return { dpp, ppn, pphFinal, pph23, total };
}