---
name: Database suite timeouts
description: How shared-lock integration suites apply PostgreSQL statement limits consistently.
---

Database integration suites that use pooled connections must configure the statement timeout on the pool before acquiring their suite lock, rather than only setting it on the dedicated advisory-lock client.

**Why:** The lock client remains checked out for the suite lifetime while application and cleanup queries use other pool clients. A timeout applied only to the lock client does not bound those queries.

**How to apply:** Set the suite-specific pool default before the first connection is acquired, wrap timeout failures with the suite name and configured limit, and attempt cleanup and advisory-lock release independently.