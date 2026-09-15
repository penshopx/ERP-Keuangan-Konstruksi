#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm exec tsc -b lib/db --force
pnpm --filter db push
