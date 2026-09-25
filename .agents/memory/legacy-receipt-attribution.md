---
name: Legacy receipt attribution
description: Safe handling of receipt records created before line-level evidence was captured.
---

Never guess a receipt's WBS/cost-code attribution from its amount when a PO/SPK has multiple lines. Single-line commitments may safely infer the line, but a multi-line receipt without line identity remains an exception rather than becoming payable.

**Why:** A monetary receipt is not proof of which contract line was accepted. Assigning it to a convenient line can silently authorize an unrelated vendor invoice.

**How to apply:** Require explicit line-level receipt evidence for matching; allow single-line legacy attribution only when there is no other possible line. Keep ambiguous historical receipts blocked pending an explicit evidence-resolution process.