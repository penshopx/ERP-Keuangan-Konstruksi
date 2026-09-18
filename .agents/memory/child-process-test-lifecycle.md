---
name: Child-process test lifecycle
description: Lifecycle rule for API integration tests that coordinate separate Node processes.
---

Cross-process integration workers must explicitly close their stdin/readline reader, HTTP server connections, and database pool after publishing their final result.

**Why:** A worker can finish its HTTP and database work but keep the validation process alive indefinitely because an open stdin reader still holds the Node event loop.

**How to apply:** Any test worker that accepts parent-process commands should have deterministic success cleanup and parent-side forced termination in `finally`, including when assertions or synchronization waits fail.