---
name: Versioned domain configuration
description: Durable rule for regulatory and client-specific construction values beyond tax calculations.
---

Model changing regulatory and domain values as versioned, effective-dated configuration rather than permanent code constants. This includes retention percentages, AHSP catalogs, regulator synchronization schedules, export formats, and client- or project-specific defaults.

**Why:** The user confirmed this architecture so compliance changes can be applied without code deployment, historical decisions remain auditable, and individual clients or projects can differ safely from defaults.

**How to apply:** Require an effective period and source or justification, prevent ambiguous overlapping rules, preserve the applied configuration version on finalized transactions, and verify regulator APIs and document formats against official sources before enabling them.