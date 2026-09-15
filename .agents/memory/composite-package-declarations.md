---
name: Composite package declarations
description: Prevent stale TypeScript declarations from breaking validation after workspace package changes merge.
---

Rebuild emitted declarations for composite workspace packages during post-merge setup before typechecking their consumers.

**Why:** TypeScript project references can redirect a consumer to an existing declaration output even when module resolution reports the package source. After a merge added a database-package export, runtime bundling succeeded from source while API typechecking still read stale declarations and reported that the export did not exist.

**How to apply:** When a composite workspace package emits declarations consumed through project references, include a forced declaration build in post-merge setup before validation or consumer builds.