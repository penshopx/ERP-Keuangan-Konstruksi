---
name: Invitation mutation concurrency
description: Concurrency rule for revoke and resend operations that share one invitation record.
---

Advisory locks must be combined with an initial invitation snapshot and identity/status comparison after the lock is acquired. A request that was already waiting when another mutation committed must not apply a second transition to the newly-mutated invitation.

**Why:** Serializing transactions alone can still let a queued revoke observe a resend's new pending state and then revoke it, causing both concurrent user actions to succeed.

**How to apply:** For cross-system invitation mutations, capture the requested Clerk invitation ID and status before waiting on the per-invitation lock, then require the locked row to match that snapshot before calling Clerk or writing an audit entry.