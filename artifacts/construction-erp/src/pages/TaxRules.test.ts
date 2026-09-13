import assert from "node:assert/strict";
import test from "node:test";
import type { TaxRuleInput } from "@workspace/api-client-react";
import { calculateTaxSimulation } from "../lib/tax-simulation.ts";

const rule: TaxRuleInput = {
  version: "simulasi",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  regulatorySource: "uji",
  serviceType: "KONSTRUKSI",
  qualification: "KECIL",
  requiresSbu: true,
  supplierPkp: true,
  governmentCollector: false,
  integrated: false,
  dppRateBasisPoints: 9_167,
  ppnRateBasisPoints: 1_100,
  pphFinalRateBasisPoints: 175,
  pph23RateBasisPoints: 200,
};

test("simulasi mengikuti urutan pembulatan invoice", () => {
  assert.deepEqual(calculateTaxSimulation(12_345, rule), {
    dpp: 11_317,
    ppn: 1_245,
    pphFinal: 216,
    pph23: 247,
    total: 13_127,
  });
});

test("PPN pemungut pemerintah ditampilkan tetapi tidak menambah total", () => {
  const result = calculateTaxSimulation(100_000, { ...rule, governmentCollector: true });
  assert.equal(result.ppn, 10_084);
  assert.equal(result.total, 96_250);
});

test("penyedia non-PKP menghasilkan PPN nol", () => {
  const result = calculateTaxSimulation(100_000, { ...rule, supplierPkp: false });
  assert.equal(result.ppn, 0);
  assert.equal(result.total, 96_250);
});