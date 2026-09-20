---
name: Reconciliation event ordering
description: Defines ordering semantics for reconciliation run events shared by multiple API processes.
---

Shared reconciliation run events are ordered by when each pass starts, not when it finishes.

**Why:** A slow pass can start first, then a competing process can record a newer coordination skip. If the slow pass uses its finish time, it incorrectly appears newer and hides the coordination event.

**How to apply:** Give each pass one start timestamp and reuse it for its terminal COMPLETED or FAILED event. Persist an event only when its timestamp is not older than the shared event.