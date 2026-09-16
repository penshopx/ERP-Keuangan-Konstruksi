---
name: Versioned domain configuration
description: Durable rule for regulatory and client-specific construction values beyond tax calculations.
---

Model changing regulatory and domain values as versioned, effective-dated configuration rather than permanent code constants. This includes retention percentages, AHSP catalogs, regulator synchronization schedules, export formats, and client- or project-specific defaults.

**Why:** The user confirmed this architecture so compliance changes can be applied without code deployment, historical decisions remain auditable, and individual clients or projects can differ safely from defaults.

**How to apply:** Every rule must have explicit `start_date` and `end_date`, record its regulatory source and change reason, use a database constraint to prevent overlapping periods for the same criteria, and snapshot the applied values and rule version when a transaction is finalized. Verify regulator APIs and document formats against official sources before enabling them.