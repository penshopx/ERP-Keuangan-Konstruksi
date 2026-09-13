---
name: Persistence regression tests
description: How API persistence and transaction tests must prove the behavior they claim to protect.
---

Persistence tests must verify API-written records directly in PostgreSQL or use a genuinely fresh process. Restarting only an HTTP listener leaves module-level memory intact and is not proof of durable storage.

Atomicity tests must inject a failure inside the endpoint's own transaction boundary, after at least one write, then assert that every related row is absent.

**Why:** Listener-only restart tests and standalone database transaction tests can pass even if a route regresses to in-memory storage or removes its transaction.

**How to apply:** For write-route regression tests, combine successful API assertions with direct database checks. Add narrow factory-injected failure hooks at the persistence boundary when rollback behavior must be tested.

API acceptance must use one registered validation gate that runs typechecking before the complete API test suite, with test-file concurrency limited to one.

**Why:** A persistence suite that depends on manual execution or races other database-backed suites can allow route regressions through despite the tests existing.

**How to apply:** Keep the project validation command pointed at the API package's serial validation script; do not replace it with a narrower test target that omits persistence coverage.