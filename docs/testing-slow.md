# Slow (opt-in) test suites: what CI does not cover

Some solver tests are expensive and are opt-in behind `RUN_SLOW=1`. This keeps the default suite fast without weakening any physics assertion.

## Run them

```bash
npm run test:slow          # EVERYTHING, default + slow (one command)
RUN_SLOW=1 npx vitest run src/ui/tests/chilldownBaseline.test.ts   # targeted
```

Mechanism: `src/testUtils/slow.ts` exports `describeSlow` = `describe` when `RUN_SLOW=1`, else `describe.skip`.

## Suites moved out of the default run

| Suite (file › block)                                                                        | What it covers                                                                                |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `chilldownBaseline.test.ts` › full 4-case N=3 suite (3 saturated + matched subcooled 74.97) | NBS Table-6 baseline table, pressure trend, sat-vs-sub matched pair, definitional sensitivity |
| `chilldownTwoPhase.test.ts` › test 2: Table-6 pressure trend (N=3, 3 solves)                | two-phase chilldown time/mdot trend vs driving pressure                                       |
| `chilldown.test.ts` › test 3: Table-6 trend (3 solves)                                      | single-phase-surrogate chilldown trend vs driving pressure                                    |
| `cavitatingVenturi.test.ts` › all-liquid-init no-root solver finding                        | honest `converged=false` + robust compromise state on a proven-no-root giant step             |
| `cavitatingVenturi.test.ts` › choking sweep 500/400/300 psia (3 solves, 2 no-root)          | choked-mdot downstream independence of the emergent venturi                                   |
| `twoPhaseFlow.test.ts` › boiling-pot staircase B1–B3                                        | dome entry, saturation plateau, latent-heat balance (water)                                   |
| `twoPhaseFlow.test.ts` › supercritical→subcritical blowdown robustness                      | no raw WASM abort across the critical point                                                   |
| `diagnostics.test.ts` › N=4 chilldown diagnostics baseline                                  | `hFloorClampCount`/`statePHFallbackCount` all-zero on the diagnostics config                  |

The manually-run full baseline sweep (N=3/4/6, saturated + subcooled) remains `npx tsx scripts/chilldown-baseline.ts …` (never was in CI).

## Test tiers

- `npm test` is the fast pull-request gate. It covers component, solver, configuration, UI, server, and workflow tests while excluding entire files whose purpose is expensive real-fluid/scientific validation.
- `npm run test:all` runs every Vitest file, including real-fluid, two-phase/chilldown, venturi, TT-WF, and benchmark suites. CI runs this on `main`, weekly, and on manual dispatch.
- `npm run test:slow` sets `RUN_SLOW=1` in addition to running the all-files configuration, enabling cases guarded inside files as intentionally long.

The exact fast-tier exclusions live in `vitest.fast.config.ts`. Keeping the list executable avoids duplicating stale per-test claims in documentation.

## Infrastructure note (vitest worker RPC)

Long **synchronous** solves block the worker event loop. An unbroken multi-solve stretch (>~5 min) starves vitest's RPC and kills the worker ("Timeout calling onTaskUpdate", remaining tests in the file lost). Multi-solve slow loops therefore `await setImmediate` between solves. Single solves up to ~3 min are fine. If you add a slow suite with serial solves, keep the yields.
