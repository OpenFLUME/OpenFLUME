# Real-fluid performance

Why the solver uses `coolprop-wasm`, where the time goes on real-fluid
solves, and how the analytic real-fluid Jacobian works.

## Backend decision

The project uses `coolprop-wasm` because it is MIT-licensed, supports the
required cryogenic and propulsion fluids, exposes saturation and derivative
APIs, and runs in both Node tests and browser workers. Lighter alternatives
reviewed during initial development were either water-only, unmaintained,
license-incompatible, or substantially slower. The WASM payload is lazy-loaded
only for real-fluid models.

**Timing caveat:** absolute wall times are machine- and load-dependent
(identical solves have been observed to differ by up to ~1.7× across
machines/loads with the same code and config). The robust quantities are
attribution percentages, per-case speedup ratios, and property-call counts.

## 1. Performance profile

Exact-attribution profiling (cumulative accumulators + call counters, not a sampling profiler) on representative real-fluid solves (two-phase LN₂ chilldown and the N₂O cavitating venturi) puts property evaluation at ~98 % of wall time. Residual assembly, dense solves, Jacobian bookkeeping, state cloning, and transient stepping share the remaining ~2 %. Consequences:

- The Amdahl ceiling on ANY solver-side optimization that leaves CoolProp
  untouched is ~1.02×.
- The dominant cost is already compiled code (CoolProp C++ → WASM).
- With a finite-difference Jacobian the residual is re-evaluated once per column plus several more times per iteration for step control. About 90 % of all residual evaluations happen inside FD Jacobian builds, mostly at states the solve has already visited.

## 2. Analytic derivative APIs

The `coolprop-wasm@^6.6.0` `AbstractState` exposes `first_partial_deriv`,
`second_partial_deriv`, `first_saturation_deriv`,
`second_saturation_deriv`, `first_two_phase_deriv`,
`second_two_phase_deriv`.

- **Embind calling convention:** the parameter arguments must be the `cp.parameters.`\* EnumValue OBJECTS, NOT raw `.value` numbers. Raw numbers silently coerce to parameter key 0 and the call throws `Unable to match the key [0] in get_parameter_information`.
- `PropsSI("d(Dmass)/d(P)|Hmass", …)` returns bit-identical values to `first_partial_deriv`, but a full PropsSI round trip costs ~13× more than `update(HmassP) + rhomass()` on a cached `AbstractState`. Use the cached-state interface on hot paths, and keep PropsSI off them.
- On an already-updated state a derivative call is not meaningfully slower than a plain property call. Adding the ρ partials to a flash costs <1 % on top of the flash itself.
- The first CoolProp call of a fresh process pays the WASM compile (on the order of a second), which is visible as a fixed per-solve overhead in short transients.
- Single-phase / supercritical analytic partials validate against central
  finite differences of `statePH` to 1e-12…1e-7 relative for Nitrogen,
  NitrousOxide, Water, and Hydrogen.

## 3. Two-phase derivative semantics

CoolProp's in-dome `first_partial_deriv` uses a different two-phase equilibrium convention and does not reproduce the derivatives of the solver's HEM mixture density (it is off by a factor of ~3.7 at x=0.5 for N₂). Also, `first_two_phase_deriv(D,H|P)` is unsupported for these input pairs.

The correct in-dome partials are assembled from `first_saturation_deriv` on the Q=0 / Q=1 states plus analytic differentiation of the solver's own HEM mixture rules (x = (h−h_f)/(h_g−h_f), 1/ρ = x/ρ_g + (1−x)/ρ_f, T = Tsat(P)). These match central finite differences of `statePH` itself to ~1e-11 relative. The saturation derivatives ride the same cached sat-props path the solver already pays for, so in-dome analytic partials are essentially free. Derivation and implementation are in `twoPhaseDerivs` in `src/core/fluids/realFluid.ts`.

ρ(P, h) and T(P, h) have genuine kinks at the saturation boundaries, so the derivative is discontinuous there. The derivative path must region-branch exactly like `statePH` and adopt a one-sided (dome-side) subgradient convention exactly at h = h_f / h_g. See the `derivativesPH` doc comment.

## 4. Analytic Jacobian

`settings.jacobian: 'hybrid'` (the default) builds the real-fluid Jacobian analytically: one `statePH` + one `derivativesPH` per node per build (O(nodes) property calls instead of O(nodes × columns)), with FD patches only on the entries touching non-differentiable pieces. Measured against `jacobian: 'fd'` on representative cases, the analytic path gives 2.6–6.6× wall-clock speedups with 5–17× fewer property calls and converges to the SAME trajectories (chilldown times identical to displayed precision; final wall temperatures within 0.034 K; venturi throat pressure / mdot within 1.2e-11 relative). Entry-by-entry Jacobian agreement is permanently guarded by `src/core/__tests__/analyticJacobian.test.ts`. Property-level derivative accuracy is guarded by `src/core/__tests__/propertyDerivatives.test.ts`.

## 5. Performance strategy

1. **Analytic real-fluid Jacobian** is the default. It removed the ~90 % of residual evaluations that existed only to build FD columns, and it removes FD-noise convergence failures at dome edges. Set `settings.jacobian: 'fd'` only for debugging or comparison.
2. **Exact-key memoization of `statePH`/`internalEnergyPH` on (fluid, P, h)** is available (would-be hit rates 87–97 %). Cache RESULTS, not CoolProp states: the N₂O fresh-state corruption workaround forbids caching `AbstractState` objects. Expect sub-multiplicative stack-up with the analytic Jacobian (most redundant evaluations were FD columns).
3. **Avoid porting the solver to another language.** Solver-side code is ~2 % of wall; the Amdahl ceiling for any change that leaves CoolProp untouched is ~1.02×, and the dominant share is already compiled code (CoolProp C++ → WASM).
4. **Keep PropsSI off hot paths.** It incurs a ~13× per-call overhead vs the cached `AbstractState` interface (see §2).

## 6. Future work

1. **Evaluate native-CoolProp binding instead of WASM as a potential large win.** Measure the WASM-vs-native delta on HEOS flashes (available from Node without porting anything) before entertaining any port decision.
2. **Avoid dense-solve / residual-assembly / bookkeeping micro-optimization.** They take ~2 % of wall combined, meaning a ~1.02× ceiling.
