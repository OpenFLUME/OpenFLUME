# CoolProp HEOS fluid catalogue

The real-fluid picker and config validation are driven by a **static, generated
catalogue** of every fluid in the shipped coolprop-wasm build's HEOS backend:
`src/core/fluids/generated/fluidCatalogue.ts` (124 fluids at CoolProp
7.2.1dev).

## Why generated instead of probed at runtime

Flashing an `AbstractState` can abort the WASM heap for some fluids. An abort can poison every subsequent CoolProp call in the process (this is the failure mode `realFluid.ts` defends against for NitrousOxide). A runtime probe of "is this fluid supported / does it have transport?" is therefore unsafe. Instead:

- The catalogue is generated **offline** by `scripts/build-fluid-catalogue.ts` (`npm run gen:fluid-catalogue`), which reads `get_global_param_string('fluids_list')` plus per-fluid `get_fluid_param_string(name, 'CAS' | 'aliases' | 'pure')` (safe, string-only calls). It probes transport-model availability **in one isolated child process per fluid**. This ensures a heap-corrupting abort can never affect another fluid's verdict.
- Runtime code (validation, the Settings picker, the solver worker) reads only the generated TypeScript file. `validateNetwork` stays synchronous and never requires the CoolProp WASM module to be initialized (this is pinned by a test in `src/core/__tests__/fluidCatalogue.test.ts`).
- `npm run check:fluid-catalogue` re-derives the catalogue and diffs it
  against the committed file (exit 1 on drift). It is intentionally **not**
  part of the test suite: it needs the WASM module and takes ~a minute.

## Catalogue entry

| field                                            | meaning                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `name`                                           | canonical HEOS name (exactly as in `fluids_list`)                                                       |
| `cas`                                            | CAS registry number, or `*.PPF` pseudo-pure identifier                                                  |
| `pure`                                           | `true` pure fluid; `false` pseudo-pure mixture (Air, R404A, R407C, R410A, R507A, SES36)                 |
| `aliases`                                        | CoolProp-registered aliases (e.g. Water → `water, WATER, H2O, h2o, R718`)                               |
| `transport.viscosity` / `transport.conductivity` | `'yes'` model confirmed at generation time, `'no'` confirmed absent, `'unknown'` no probe state flashed |

Scope is deliberately HEOS-only: no INCOMP fluids, no REFPROP-only names, and
no arbitrary mixture strings (`"Water[0.5]&Ammonia[0.5]"` is rejected).

## Validation semantics (`core/validate.ts`)

1. **Unknown name** (not a canonical name or unambiguous alias) → error: _"… is not a CoolProp HEOS fluid."_ The Settings picker renders such a saved value as a visible invalid option instead of silently reverting.
2. **Catalogue fluid without a viscosity model** (`'no'`/`'unknown'`) → error. The solver would otherwise silently run with zero transport (no Darcy friction, no convection). These fluids remain **discoverable** in the picker, marked _"⚠ no transport model"_.
   - **Exception:** the curated favorites (`SUPPORTED_REAL_FLUIDS`, the historical 9-fluid allowlist) are grandfathered. NitrousOxide is the only favorite without a transport model, and its inviscid-limit behavior is long-standing and covered by existing tests.
3. **Missing conductivity only** (viscosity present) → allowed. Convection correlations already fall back when `k` is unavailable. The picker notes it.

`SUPPORTED_REAL_FLUIDS` remains exported (backward compatible) as the curated
favorites; `SupportedRealFluid` is now the union of all 124 canonical names.

## Alias canonicalization (`core/fluids/fluidCatalogue.ts`)

`canonicalizeFluidName(input)` resolves, in order: exact canonical name → exact registered alias → case-insensitive match **only when globally unique**. Ambiguous aliases (a string registered for two fluids) are excluded from the index at module load, so resolution is deterministic and never guesses. The `satisfies`-typed generated table keeps `HeosFluidName` a compile-time union of all canonical names.

## Regenerating

```sh
npm run gen:fluid-catalogue   # rewrite the generated file (~1 min, 124 child probes)
npm run check:fluid-catalogue # diff-only; use after upgrading coolprop-wasm
```

After upgrading the `coolprop-wasm` dependency, run the generator, review the diff (new fluids, changed transport flags), and update the pinned expectations in `src/core/__tests__/fluidCatalogue.test.ts` if the fluid set changed.
