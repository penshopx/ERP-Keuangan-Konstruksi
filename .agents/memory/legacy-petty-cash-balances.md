---
name: Legacy petty cash balances
description: Handling historical petty cash requests when adding project/location fund ledgers
---

Historical petty cash requests can predate the introduction of location-specific cash funds. Do not backfill their fund association or opening balance unless cash movement and custody can be reconstructed from independently verified records. Preserve a bounded completion path for outstanding historical transactions instead.

**Why:** An automatic association would make today's fund balance appear to cover past cash movements it never recorded, while requiring a fund for all stages would strand previously approved or settled transactions.

**How to apply:** On future petty cash workflow or migration changes, account for historical requests without a fund. Keep their remaining-cash checks separate from the location fund ledger and test both a populated pre-upgrade database and the continuation of its outstanding transactions.