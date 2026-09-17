---
name: Tracked SQL migrations
description: Coordination rules between Drizzle schema push and the tracked custom SQL migration runner.
---

Custom SQL migrations use a database history table, checksums, and a database advisory lock. Any table or ordinary constraint owned by this flow must also be represented in the Drizzle schema when possible.

**Why:** Drizzle schema push treats undeclared tables and check constraints as drift and may remove them. A recorded migration then remains marked as applied even though part of its protection is gone.

**How to apply:** Use schema push only for initial schema setup, run tracked SQL migrations before every API startup, and verify mandatory migration history plus required database objects before opening the server port. Constraint migrations must tolerate the constraint already existing because schema push can create declared constraints before the tracked migration runs.