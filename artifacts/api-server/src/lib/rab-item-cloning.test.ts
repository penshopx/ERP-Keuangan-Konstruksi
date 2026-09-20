import assert from "node:assert/strict";
import test from "node:test";
import { cloneRabItems } from "./rab-item-cloning";

test("clones every RAB business field into a new baseline with new IDs", () => {
  const source = [{
    id: "old-item", baselineId: "old-baseline", costCodeId: "code-1", code: "A-1",
    name: "Pekerjaan", category: "LABOR", parentCode: null, level: 2, unit: "m2",
    quantityBasisPoints: 1250, unitPrice: 1000, materialCost: 100, laborCost: 200,
    equipmentCost: 300, budget: 12500, committed: 10, actual: 20,
    createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-02"),
  }] as const;
  const [cloned] = cloneRabItems([...source], "new-baseline", () => "new-item");
  assert.equal(cloned.id, "new-item");
  assert.equal(cloned.baselineId, "new-baseline");
  assert.equal(cloned.code, source[0].code);
  assert.equal(cloned.budget, source[0].budget);
  assert.equal(cloned.committed, source[0].committed);
  assert.equal(cloned.actual, source[0].actual);
  assert.equal("createdAt" in cloned, false);
  assert.equal("updatedAt" in cloned, false);
});