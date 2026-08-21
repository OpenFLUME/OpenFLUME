## Summary

Describe the problem and the approach taken. Keep changes focused; preserve
existing behavior unless this PR is explicitly behavioral.

Linked issue: #<!-- issue number, if any -->

## Verification performed

Per [CONTRIBUTING.md](../CONTRIBUTING.md), the minimum gate is:

- [ ] `npm run check` passes (typecheck + fast tests + production build)

Broader tiers, required when the change affects numerical methods, real-fluid
properties, validation, or browser workflows (see
[Architecture — Test tiers](../docs/architecture.md#test-tiers)):

- [ ] `npm run test:all` (all Vitest files)
- [ ] `npm run test:slow` (expensive suites, `RUN_SLOW=1`)
- [ ] `npm run test:e2e` (Playwright end-to-end; requires a one-time
      `npx playwright install --with-deps chromium`)

List what you actually ran and the outcome. If a tier was skipped, say why.

## Numerical claims

If this PR makes or changes a numerical claim, state the reference, tolerance,
units, and assumptions here. Do not weaken existing tolerances or replace
validation data without explaining the physical or numerical reason.

- Reference:
- Tolerance:
- Units / assumptions:

## Schema / persistence

- [ ] This PR does not change persisted config
- [ ] Persisted config changed and the current schema documentation was updated

## Scientific and product limitations

Note any limitations a reviewer or user should know (validity ranges, known
divergences from references, performance trade-offs). Keep research
calibration and product behavior separate, as described in the architecture
document.
