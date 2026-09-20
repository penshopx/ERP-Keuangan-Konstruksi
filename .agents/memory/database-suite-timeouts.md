---
name: Database suite timeouts
description: How shared-lock integration suites apply PostgreSQL statement limits consistently.
---

Database integration suites that use pooled connections must configure both PostgreSQL statement timeouts and client-side query/connection timeouts on the pool before acquiring their suite lock, rather than only setting a server timeout on the dedicated advisory-lock client.

**Why:** The lock client remains checked out for the suite lifetime while application and cleanup queries use other pool clients. A timeout applied only to the lock client does not bound those queries, and a PostgreSQL statement timeout cannot end a validation when the network stops delivering server responses.

**How to apply:** Set the suite-specific server and client pool defaults before the first connection is acquired, inspect wrapped causes for either timeout type, report the suite name and configured limit, and attempt cleanup, advisory-lock release, and pool closure independently.