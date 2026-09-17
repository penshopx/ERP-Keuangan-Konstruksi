#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm exec tsc -b lib/api-zod lib/db --force
pnpm --filter db push
