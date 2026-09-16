---
name: Versioned tax rules
description: Durable rule for implementing Indonesian construction tax calculations.
---

Construction tax rates, DPP treatments, and document formats must be modeled as effective-dated configuration with a cited regulatory source. Transaction calculations must retain a snapshot of the rule version used.

**Why:** Indonesian tax rules change, and the source documents supplied for this project contain inconsistent formulas. Historical invoices must remain reproducible after future rule changes.

**How to apply:** Use configurable rule records for PPh Final, PPN/DPP treatment, and PPh 23. Require explicit effective dates and preserve the applied rule metadata on posted transactions. Enforce non-overlap for identical criteria in PostgreSQL, not only in API validation. Supersede an open-ended rule atomically by ending it the day before the successor begins, but reject the change if an existing invoice on or after that date used the old rule. If legacy data contains one or more bounded temporary overrides inside an open-ended rule, create continuation segments for every gap and after the final override so removing overlaps never changes the selected rate. When migrating historical transactions whose source was not recorded, preserve their original amounts and formula as an explicitly labeled historical rule; never silently map them to a newer regulation or recalculate them.