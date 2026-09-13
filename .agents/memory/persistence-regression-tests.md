---
name: Persistence regression tests
description: How API persistence and transaction tests must prove the behavior they claim to protect.
---

Persistence tests must verify API-written records directly in PostgreSQL or use a genuinely fresh process. Restarting only an HTTP listener leaves module-level memory intact and is not proof of durable storage.

Atomicity tests must inject a failure inside the endpoint's own transaction boundary, after at least one write, then assert that every related row is absent.

**Why:** Listener-only restart tests and standalone database transaction tests can pass even if a route regresses to in-memory storage or removes its transaction.

**How to apply:** For write-route regression tests, combine successful API assertions with direct database checks. Add narrow factory-injected failure hooks at the persistence boundary when rollback behavior must be tested.