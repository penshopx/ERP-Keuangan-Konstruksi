---
name: Graceful reconciliation shutdown
description: Shutdown contract for background reconciliation during server restarts and deployments.
---

On controlled shutdown, prevent new reconciliation passes and wait for the active pass to settle before the process exits. Keep an explicit maximum shutdown duration so orchestration cannot wait forever; a forced process exit must leave any unfinished database transaction to roll back atomically.

**Why:** A server restart can arrive between the invitation status update and its audit insert. Exiting without coordination makes operational status unclear, while waiting without a deadline can stall a deployment indefinitely.

**How to apply:** Any new background database worker started by the API process should expose an awaitable stop operation and participate in the same bounded shutdown sequence. Its transaction must commit the complete result or roll back all partial writes.