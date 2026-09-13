export type TaxRuleCriteria = {
  serviceType: string;
  qualification: string | null;
  requiresSbu: boolean;
  supplierPkp: boolean;
  governmentCollector: boolean;
  integrated: boolean;
};

export function taxRuleLockKey(criteria: TaxRuleCriteria) {
  return [
    criteria.serviceType,
    criteria.qualification ?? "NULL",
    criteria.requiresSbu,
    criteria.supplierPkp,
    criteria.governmentCollector,
    criteria.integrated,
  ].join(":");
}