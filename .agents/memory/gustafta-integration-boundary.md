---
name: Gustafta integration boundary
description: User-confirmed distinction between ERP read-only effects and outbound data for a staged Gustafta integration.
---

For an initial Gustafta integration, "read-only" means no automatic mutation of ERP records or transactions; it does **not** mean no data leaves the ERP. Catalog reading is optional, and AI assistance may send only synthetic or safely redacted context selected by the ERP backend for human review. Do not use external order creation or assume bidirectional document sync at this stage. Real project documents require defined data-processing rules and project/tenant access controls first.

**Why:** The user explicitly confirmed this distinction after discussing the available API capabilities. An AI POST request transfers prompt/context to an external service even when the resulting answer cannot modify the ERP.

**How to apply:** When evaluating an adapter or proposing a pilot, describe outbound data separately from ERP write permissions, keep the pilot non-sensitive and review-only, and avoid treating an external AI response as authoritative project evidence.