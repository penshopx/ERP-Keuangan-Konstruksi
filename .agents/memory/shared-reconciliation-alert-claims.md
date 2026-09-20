---
name: Shared reconciliation alert claims
description: Coordination rules for deduplicating reconciliation incident notifications across API instances.
---

Reconciliation incident and delivery state must live in the database, and each notification type must be claimed while holding a lock on that shared state.

**Why:** Process-local state lets multiple instances notify for the same incident. DEGRADED and RECOVERED cannot share one rollback boundary because a failed recovery must not erase the record of a successful degradation notification.

**How to apply:** Serialize concurrent evaluators on the shared incident row. Commit successful DEGRADED delivery before attempting RECOVERED, and leave only the failed delivery retryable.