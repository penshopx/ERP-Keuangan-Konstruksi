---
name: Database timeout errors
description: How to handle PostgreSQL transaction timeouts reliably through the database abstraction layer.
---

Apply PostgreSQL contention timeouts transaction-locally, return a retryable API response for expected contention, and detect the PostgreSQL error code throughout the wrapped `cause` chain.

**Why:** The database abstraction layer can wrap the original PostgreSQL error, so checking only the top-level error code misses a real timeout and falls through to a generic server error.

**How to apply:** For bounded lock or statement waits, use transaction-local settings so pooled connections are not permanently changed. Let the transaction reject to guarantee rollback, then translate the recognized error outside the transaction.