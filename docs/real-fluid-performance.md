# Real-fluid performance

Why the solver uses `coolprop-wasm`, where the time goes on real-fluid
solves with the current architecture, and how the analytic real-fluid
Jacobian works.

Regenerate after solver or CoolProp changes:

```
npx tsx scripts/real-fluid-performance.ts
```

## Backend decision

The project uses `coolprop-wasm` because it is MIT-licensed, supports the
required cryogenic and propulsion fluids, exposes saturation and derivative
APIs, and runs in both Node tests and browser workers. Lighter alternatives
reviewed during initial development were either water-only, unmaintained,
license-incompatible, or substantially slower. The WASM payload is lazy-loaded
only for real-fluid models.

**Timing caveat:** absolute wall times are machine- and load-dependent
(identical solves have been observed to differ by up to ~1.7× across
machines/loads with the same code and config). Hybrid-vs-FD _wall_ speedups
move with that noise; property-call counts and their ratios repeat exactly.
Numbers below were measured on one machine; re-run the script to refresh them.

## 1. Performance profile

Exact-attribution profiling (`src/core/perf.ts`: cumulative accumulators +
call counters, not a sampling profiler) on four current-architecture
real-fluid solves:

1. **Two-phase LN₂ chilldown** — N=4 audit line (60.96 m, 0.5169 MPa saturated
   inlet), first 75 s at dt = 15 s. No `kineticEnergy`. This is the
   diagnostics-audit network with a truncated horizon so the FD Jacobian A/B
   stays tractable. With warm value caches its whole trajectory is
   cache-resident, so its property share is a WARM-CACHE floor, not a
   long-horizon estimate — that is what case 2 is for.
2. **LN₂ chilldown, full 300 s horizon** — the same network run to the full
   diagnostics horizon. Each solve visits ~25k fresh `(P, h)` keys, so this
   case shows the property share long transients actually pay (first-visit
   flashes; the caches absorb only within-solve reuse).
3. **N₂O cavitating venturi** — shipped 9-node one-step transient (area-change cascade, throat seeded on the liquid-side dome edge). No `kineticEnergy`. Area-change components are dual-capable, so the hybrid Jacobian has no FD patches on this network.
4. **Real-fluid transonic N₂ CD nozzle** — CoolProp nitrogen at 5 bar / 300 K,
   `kineticEnergy` + default limited-upwind momentum faces, coupled
   `[P, ṁ, h]` system.

| Case                    | hybrid wall | property | other  | dense solve | statePH / derivativesPH | scalar R evals in J (hybrid) | hybrid vs FD wall / calls | scalar R evals in J (FD) |
| ----------------------- | ----------- | -------- | ------ | ----------- | ----------------------- | ---------------------------- | ------------------------- | ------------------------ |
| LN₂ two-phase chilldown | 167 ms      | 18.3 %   | 81.7 % | 1.3 %       | 32,832 / 6,095          | 0.0 %                        | 6.78× / 5.41×             | 86.9 %                   |
| LN₂ chilldown 300 s     | 1.34 s      | 74.9 %   | 25.1 % | 0.4 %       | 138,750 / 16,930        | 0.0 %                        | 1.53× / 2.75×             | 87.0 %                   |
| N₂O cavitating venturi  | 30 ms       | 12.2 %   | 87.8 % | 4.3 %       | 3,348 / 516             | 0.0 %                        | 2.32× / 17.07×            | 95.3 %                   |
| N₂ transonic CD nozzle  | 40 ms       | 7.0 %    | 93.0 % | 2.0 %       | 1,812 / 120             | 0.0 %                        | 2.89× / 70.63×            | 97.2 %                   |

Property evaluation is 7.0 %–74.9 % of hybrid wall (highest on the 300 s chilldown, whose ~25k first-visit keys must each be flashed once; lowest on the short cases whose trajectories are fully cache-resident after warmup). The bounded value caches (§5, item 2) absorb repeated exact-key traffic — realized hit rates equal the within-solve exact-key ceiling, so the remaining property cost is genuine first-visit flash work, not cache misses that a bigger cache could recover. Residual assembly, dense solves, Jacobian bookkeeping, state cloning, upwind-face reconstruction, and transient stepping share the remaining 25.1 %–93.0 %. Dense Gaussian elimination alone is 0.4 %–4.3 %. On the FD Jacobian path the same cases spend 51.3 %–89.5 % of wall in property evaluation: the O(columns) residual sweep evaluates at perturbed states whose exact keys are new, so the value caches cannot absorb it and CoolProp remains the dominant cost there.

Consequences, scoped to these cases:

- The Amdahl ceiling on any solver-side optimization that leaves CoolProp untouched is 1.34×–14.33× on the hybrid path and 1.12×–1.95× on the FD path. Short warm-cache solves are solver-side-majority (residual assembly, cloning, bookkeeping); the long-horizon chilldown is still property-majority because every fresh Newton iterate pays first-visit flashes. CoolProp also still dominates the FD path and any cold-cache first solve.
- Scalar residual evaluations (not dual-number Jacobian columns) that run inside Jacobian builds: 86.9 %–97.2 % on the FD path (one residual per column plus step-control extras, mostly at states the solve has already visited). The hybrid path drops that share to 0.0 %, leaving only FD patches on non-differentiable pieces; each hybrid build is O(nodes) property calls plus dual arithmetic rather than O(nodes × columns) residual re-evaluations.
- Coupled `[P, ṁ, h]` systems (transonic, any `kineticEnergy` real-fluid solve) have more Newton columns than the enthalpy-segregated chilldown, so the FD Jacobian's O(columns) residual sweep is correspondingly more expensive. That is why the transonic hybrid/FD property-call ratio sits at the high end of the range in §4.

## 2. Analytic derivative APIs

The `coolprop-wasm@^6.6.0` `AbstractState` exposes `first_partial_deriv`,
`second_partial_deriv`, `first_saturation_deriv`,
`second_saturation_deriv`, `first_two_phase_deriv`,
`second_two_phase_deriv`.

- **Embind calling convention:** the parameter arguments must be the
  `cp.parameters.`\* EnumValue OBJECTS, NOT raw `.value` numbers. Raw
  numbers silently coerce to parameter key 0 and the call throws
  `Unable to match the key [0] in get_parameter_information`.
- `PropsSI("D", "P", P, "HMASS", h, …)` returns the same density as `update(HmassP) + rhomass()` on a cached `AbstractState`, but a full PropsSI round trip costs 9.29× more than the cached-state flash (1.11e+0 ms vs 1.19e-1 ms per call, Nitrogen 2 MPa subcooled). Use the cached-state interface on hot paths, and keep PropsSI off them.
- On an already-updated state a derivative call (6.06e-4 ms) costs 2.8× a plain `rhomass()` (2.20e-4 ms) and 0.5 % of a full HmassP flash. Adding the ρ partials to a flash is a small increment on top of the flash itself.
- The first CoolProp call of a fresh process pays the WASM compile (1.67 s here), which is visible as a fixed per-solve overhead in short transients.
- Single-phase / supercritical analytic partials validate against central
  finite differences of `statePH` to 1e-12…1e-7 relative for Nitrogen,
  NitrousOxide, Water, and Hydrogen (`src/core/__tests__/propertyDerivatives.test.ts`).

## 3. Two-phase derivative semantics

CoolProp's in-dome `first_partial_deriv` uses a different two-phase
equilibrium convention and does not reproduce the derivatives of the
solver's HEM mixture density (it is off by a factor of ~3.7 at x=0.5 for
N₂). Also, `first_two_phase_deriv(D,H|P)` is unsupported for these input
pairs.

The correct in-dome partials are assembled from `first_saturation_deriv`
on the Q=0 / Q=1 states plus analytic differentiation of the solver's own
HEM mixture rules (x = (h−h_f)/(h_g−h_f), 1/ρ = x/ρ_g + (1−x)/ρ_f,
T = Tsat(P)). These match central finite differences of `statePH` itself
to ~1e-11 relative. The saturation derivatives ride the same cached
sat-props path the solver already pays for, so in-dome analytic partials
are essentially free. Derivation and implementation are in `twoPhaseDerivs`
in `src/core/fluids/realFluid.ts`.

ρ(P, h) and T(P, h) have genuine kinks at the saturation boundaries, so the
derivative is discontinuous there. The derivative path must region-branch
exactly like `statePH` and adopt a one-sided (dome-side) subgradient
convention exactly at h = h_f / h_g. See the `derivativesPH` doc comment.

## 4. Analytic Jacobian

`settings.jacobian: 'hybrid'` (the default) builds the real-fluid Jacobian
analytically: one `statePH` + one `derivativesPH` per node per build
(O(nodes) property calls instead of O(nodes × columns)), with FD patches
only on the entries touching non-differentiable pieces. Measured against
`jacobian: 'fd'` on the four cases above, the analytic path uses
**2.75×–70.63× fewer property calls** (this ratio repeats
across runs) and converges to the same trajectories — exactly on the short
cases; on the 300 s horizon the two Jacobian schemes take slightly different
Newton paths through the moving chilldown front and the wall traces differ
by a sub-percent front-timing offset (below). Wall-clock was also
faster on this machine (1.53×–6.78×; load-dependent — see
the timing caveat). The transonic call-count ratio sits at the high end
because the coupled `[P, ṁ, h]` unknown vector is longer, so each FD
Jacobian build re-evaluates the residual once per extra enthalpy column:

- final time 75 s vs 75 s; worst wall ΔT 6.07e-8 K on s2 (0.000 % relative)
- 300 s horizon: final time 300 s vs 300 s; worst wall ΔT 1.81e-1 K on s0 (0.168 % relative)
- throat P relative 9.03e-15, mdot relative 1.44e-15
- mdot relative 1.29e-13

Entry-by-entry Jacobian agreement is permanently guarded by
`src/core/__tests__/analyticJacobian.test.ts`. Property-level derivative
accuracy is guarded by `src/core/__tests__/propertyDerivatives.test.ts`.

Momentum-row ∂/∂h entries use a frozen-μ convention (`mu.d ≡ 0` in the
dual state path: this coolprop-wasm build rejects analytic μ partials). At
subcooled-liquid states the dropped μ term can dominate the true entry
through a near-cancellation of the turbulent-friction ∂ρ/∂h and ∂μ/∂h
terms. Harmless where the momentum rows sit at the noise floor; see
[`docs/solver-convergence.md`](solver-convergence.md) §4.

## 5. Performance strategy

1. **Analytic real-fluid Jacobian** is the default. It removed the majority
   of residual evaluations that existed only to build FD columns, and it
   removes FD-noise convergence failures at dome edges. Set
   `settings.jacobian: 'fd'` only for debugging or comparison.
2. **Exact-key value caching is bounded and fused.** One bounded cache of
   per-key entries (8192 exact `(fluid, P, h)` keys,
   `src/core/fluids/realFluid.ts`) serves `statePH`, `internalEnergyPH`,
   and `derivativesPH` together: a `statePH` miss also computes u (a free
   `umass()` read on its own flash) and — single-phase / supercritical —
   the analytic partials eagerly, so the other two calls at the same key
   never re-flash. `derivativesPH` branch-locks to the entry's
   `statePH` phase verdict. Realized hit rates on these hybrid solves:
   82.2 %–100.0 % of `statePH` calls and
   61.0 %–100.0 % of `derivativesPH` calls
   (within-solve exact-key ceiling 82.2 %–91.9 %; warm
   caches can exceed it). Supporting structure, same file:
   - **Region-test order:** with satProps cached at the exact P the
     inclusive h ∈ [h_f, h_g] test is free; otherwise the HmassP flash runs
     FIRST and CoolProp's `phase()` verdict short-circuits clearly
     single-phase states (1 flash instead of 2 PQ saturation solves + 1
     flash). Two-phase/ambiguous verdicts fall back to getSatProps + the
     inclusive test, so the dome-edge subgradient convention is unchanged.
   - **getSatProps also reads the saturation derivatives** while the
     Q=0 / Q=1 states are positioned (~1 µs each), so getSatDerivs never
     re-runs the two PQ saturation solves.
   - **GenCacheMap** (two-generation, bulk-evicting): the LruMap
     delete+re-insert recency refresh measured ~14 % of solver wall at these
     hit volumes; a young-generation hit is now a single `Map.get`.
     The bound is mandatory: keys are exact IEEE doubles, and an UNBOUNDED map
     grows without bound on long transients (the 2026-08-07 Darr–Hartwig
     OOM). Caching CoolProp `AbstractState` objects remains forbidden either
     way: a corrupted N₂O state must be replaceable with `getFreshState`.
     Eviction only discards a value that is recomputed bit-identically on the
     next miss, so results are exact while the heap stays bounded.
3. **Do not port the solver to another language to make real-fluid solves
   fast.** Historically this was an Amdahl statement (CoolProp WASM was
   84 %–95 % of hybrid wall, so solver-side rewrites were capped at
   1.05×–1.18×). The item 2 caches changed the profile shape (solver-side
   share is now 25.1 %–93.0 %), but the conclusion stands:
   absolute walls are
   30 ms–1.34 s
   on these cases (1.34 s for the FULL 300 s
   chilldown horizon), on long horizons the dominant cost is still
   first-visit CoolProp flashes that a port would not touch, the solver-side
   remainder is spread across residual assembly / cloning / bookkeeping with
   no single compiled-code-shaped hotspot, and a port would forfeit the
   browser-worker deployment. Revisit only with a profile of a real workload
   that is still too slow.
4. **Keep PropsSI off hot paths.** It incurs a 9.29×
   per-call overhead vs the cached `AbstractState` interface (see §2).

## 6. Future work

1. **Evaluate a native CoolProp binding instead of WASM.** Measure the
   WASM-vs-native delta on HEOS flashes (available from Node without
   porting the solver) before entertaining any port decision. The hybrid
   ceiling for ANY faster property backend is
   1.08×–3.98×
   on these cases (highest on the long-horizon chilldown, whose first-visit
   flashes the value caches cannot absorb); FD debugging runs, cold-cache
   first solves, and the WASM compile itself would also benefit. This tree
   still has no native binding, so that delta was not re-measured here.
2. **Avoid dense-solve micro-optimization.** Dense elimination is 0.4 %–4.3 % of hybrid wall. On warm short solves residual assembly, cloning, and dual arithmetic are the largest share; on long horizons first-visit flashes still lead — either way the dense solve is noise. Guide any future solver-side optimization with a fresh CPU profile.
