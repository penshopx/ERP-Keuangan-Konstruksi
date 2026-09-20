---
name: Operational alert delivery status
description: Safety and privacy rules for recording the latest operational alert delivery outcome.
---

Record alert delivery status as best-effort operational metadata keyed by source. Store only the attempt time and a bounded outcome; never store webhook URLs or delivery credentials.

**Why:** The status exists to expose a broken alert channel, but a database failure while writing that status must not change the result of the primary process or a successful webhook delivery.

**How to apply:** Any new operational alert source should use the shared status recorder. Swallow and log recorder failures, and prevent an older concurrent attempt from replacing a newer result.