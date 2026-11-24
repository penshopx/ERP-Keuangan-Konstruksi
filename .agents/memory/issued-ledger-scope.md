---
name: Issued ledger scope
description: Why published financial statements must use posted journals rather than silently mixing operational documents.
---

Published financial statement figures are derived only from posted general-ledger journals. Operational invoices, receipts, payments, and petty-cash records are source documents, not implicit journal postings; they must be explicitly mapped and posted before they contribute to financial statements.

**Why:** Combining source-document amounts with posted journals without an idempotent mapping double-counts transactions and makes issued versions impossible to reconcile.

**How to apply:** When integrating a new operational source, make its posting idempotent, preserve the source reference, respect period locks, and keep immutable issued versions separate from the live draft.

Report issuance must serialize with journal posting across *all* periods, not just the report's month. Acquire the same transaction-scoped lock before period-specific locks, recheck whether a later report has been issued, then build the report after the lock is held.

**Why:** A journal posted into an earlier month can race a later month's close. Locking only each month lets the later report snapshot omit an uncommitted earlier journal while both transactions commit successfully.

**How to apply:** Keep journal writers and report issuers on a shared lock path even when posting originates outside the API; test the race using separate database connections.