---
name: Shared database test isolation
description: How database-backed validation suites that mutate shared fixtures must isolate concurrent runs.
---

Suites that mutate shared database fixtures must use a database-scoped lock held from before setup cleanup until after final cleanup. The lock must have a bounded wait and fail with an explicit error when it cannot be acquired.

**Why:** Process-local test concurrency limits do not protect against separate validation commands running at the same time, and filesystem locks do not coordinate runs on different hosts that share a database.

**How to apply:** Use a dedicated database session for the full suite lifecycle, release it in a final cleanup path, and keep run-specific records uniquely named in addition to locking.