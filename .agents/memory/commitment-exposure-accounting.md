---
name: Commitment exposure accounting
description: The accounting boundary between physical receipt, open commitment, and posted actual cost.
---

Physical receipt records delivery or work progress but does not reduce the financial commitment. Only a posted vendor invoice moves value from remaining commitment into actual cost. Available budget is baseline minus remaining commitment minus actual.

**Why:** Reducing commitment at receipt time before recording actual cost temporarily understates total exposure and makes budget appear available even though the vendor obligation still exists.

**How to apply:** Keep receipt and invoice allocations separate. Reconcile exposure as actual plus uninvoiced commitment, and make invoice posting idempotent so retries cannot double count actual cost.