---
name: Reconciliation liveness
description: How scheduler-stall detection should relate to normal skips and reconciliation failures.
---

Track the age of the last completed reconciliation pass independently from consecutive processing failures. Coordination-lock skips are normal and must not increment failure counts, but they should still evaluate whether completed-pass freshness has exceeded its configured limit. A later completed pass clears the overdue condition automatically.

**Why:** A failure counter cannot detect a scheduler that only skips forever, while treating every skip as a failure creates false alarms during normal multi-instance coordination.

**How to apply:** For scheduled reconciliation health and alerts, preserve separate failure and completion-freshness signals, derive overall health from both, and send one recovery only after all active degradation signals have cleared.