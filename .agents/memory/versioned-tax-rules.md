---
name: Versioned tax rules
description: Durable rule for implementing Indonesian construction tax calculations.
---

Construction tax rates, DPP treatments, and document formats must be modeled as effective-dated configuration with a cited regulatory source. Transaction calculations must retain a snapshot of the rule version used.

**Why:** Indonesian tax rules change, and the source documents supplied for this project contain inconsistent formulas. Historical invoices must remain reproducible after future rule changes.

**How to apply:** Use configurable rule records for PPh Final, PPN/DPP treatment, and PPh 23. Require explicit effective dates and preserve the applied rule metadata on posted transactions.