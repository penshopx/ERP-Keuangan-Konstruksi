---
name: Shared database test isolation
description: How database-backed validation suites that mutate shared fixtures must isolate concurrent runs.
---

Suites that mutate shared database fixtures must use a database-scoped lock held from before setup cleanup until after final cleanup. The lock must have a bounded wait and fail with an explicit error when it cannot be acquired. Tests that exercise version supersession must also restore the superseded row's validity range, not only delete the version they created.

**Why:** Process-local test concurrency limits do not protect against separate validation commands running at the same time, and filesystem locks do not coordinate runs on different hosts that share a database. Deleting a newly created effective-dated version can still leave the shared predecessor truncated and break later suites.

**How to apply:** Use a dedicated database session for the full suite lifecycle, release it in a final cleanup path, and keep run-specific records uniquely named in addition to locking. Snapshot any shared row a mutation can alter and restore it in `finally`.