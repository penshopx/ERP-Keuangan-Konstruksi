---
name: Managed AI provisioning availability
description: Difference between implementing a Replit-managed AI adapter and activating its provider in the running environment.
---

Do not infer that a compiling OpenAI adapter has access to the managed Replit AI
provider. Confirm that the provisioning callback is available and verify one
live request before claiming semantic routing works. If provisioning is
unavailable, the deterministic fallback remains useful but is not proof that
the model feature is active.

**Why:** The documented setup callback was not registered in one task runtime,
even after repeated calls, and managed provider configuration was absent.
Unit tests against a local mock passed while live model routing was unavailable.

**How to apply:** On future AI tasks, check callback availability and activation
early; distinguish mocked adapter tests from a live provider smoke test. Do not
substitute a manually supplied key for the managed integration requirement.