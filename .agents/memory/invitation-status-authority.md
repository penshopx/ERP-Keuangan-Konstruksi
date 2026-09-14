---
name: Invitation status authority
description: Source-of-truth and failure-handling rule for invitation status shared by Clerk and the ERP.
---

Treat Clerk as authoritative for whether an invitation link remains usable. If a Clerk mutation succeeds but the ERP transaction fails, record the partial outcome and reconcile ERP status from Clerk before reporting the invitation as active.

**Why:** Clerk and PostgreSQL cannot share one transaction. A rolled-back ERP write cannot reactivate a link already revoked by Clerk, so showing the stale ERP status would mislead Directors.

**How to apply:** Any invitation read path that labels a link active must first account for Clerk's current state. Cross-system mutation failures need structured outcomes and an idempotent reconciliation path.