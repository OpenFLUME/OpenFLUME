# Solver convergence

Durable findings on transient real-fluid convergence and the resulting
early-exit policy.

## 1. False convergence from delayed updates

The transient step alternates an inner Newton solve (coupling frozen) with
outer segregated-Picard updates of the heat-transfer-coefficient map and
the wall re-solve. Judging convergence on the **pre-coupling** (inner
Newton) metric can certify states whose residuals become kW-scale once the
coupling update is applied.

The opt-in `settings.certifyAfterCoupling` (default off) re-measures the row-floor-scaled residual at the **post-coupling** state after each outer iteration. It uses it as the certifying metric: bar = `tol*1e3` scaled, i.e. 100 W/row on the 1e4 W-floored energy rows at tol=1e-5. Steps that meet tolerance sit at the FD-Newton noise floor (scaled ~1e-5–1e-4, ~1 W energy imbalance). Non-converged steps sit at scaled ~0.1–10 (kW scale). This provides a ~1000× separation, so the bar is robust to its exact placement. On a failing step the run restores the most-converged outer iterate and marches on with `converged: false`. A failed step still returns a physical (best-effort compromise) state, though such compromise steps can carry ~13–22 % per-step energy non-closure.

## 2. Phase changes

During transient phase changes, the solver can enter a nonsmooth fixed point and flicker across the saturated-liquid dome edge. The film-boiling h-map and wall re-solve kick kW-scale energy back into that node's energy row each outer iteration, and the segregated Picard iteration orbits in a stable limit cycle (measured period-6 and period-8 cycles whose minima sit more than 20× above the certification bar). No single Newton linearization, exact or FD, can fix this; it needs a semismooth / active-set treatment of the coupled system (phase regime as a discrete set), or a coupled Newton over (fluid state, wall T, h-map) with the kink handled explicitly. These steps must keep failing, as a detector that "converges" them is too permissive.

Away from the saturation boundary, the solver works well. Near phase changes, the solver variables might move very little on each step. Even if they move less than the tolerance, the error still drops fast. We must check the error size, not the variable movement, to decide if the solver is done.

## 3. Stopping stalled steps

Extended-system (transient real-fluid) steps are judged by ONE residual-trend detector at the bottom of the outer loop:

> Stop with `converged = false` iff the best certifying scaled
> residual has not improved by > 2 % for `OUTER_PROGRESS_PATIENCE = 14`
> outer iterations while still above the `tol*1e3` bar.

These factors explain why the envelope distinguishes descent from stalling:

- A geometric descent improves the envelope > 2 % every outer, so the clock never advances. This means the iteration grinds as long as it is converging, however slowly. Anything slower than ~2 % per 14 outers cannot reach the bar from a kW-scale residual within the unchanged maxOuter=1000 cap.
- A limit cycle visits its envelope minimum once and never improves it afterwards, so it trips the detector ~14 outers after the minimum is first reached. Envelope stagnation represents the cycle signature, meaning no period detection is needed. Transient regime-flip bounces can span >3× in amplitude before plunging, so only patience separates them from true cycles.
- A flat no-root grind (emergent-venturi class) trips it after 14 outers. This provides a bounded, acceptable cost.

Scope: extended system only. Non-extended paths (incompressible / ideal-gas / steady) keep the legacy state-motion 3-strike stall test bit-for-bit. Inner-loop no-progress guards, the iteration caps (maxOuter=1000, 200 inner), and the retry-cascade tier budgets are unchanged, as are all convergence-accept paths.

## 4. Limitations

- The check is opt-in and off by default. The default path retains the pre-coupling certification-lag artifact (§1).
- Failing steps march on with best-residual compromise states. Their per-step energy non-closure (up to ~13–22 % worst-step) contaminates any energy budget while `certifyAfterCoupling` is on. Certifiable steps close to ~0.1 % per step.
- Momentum-row d/dh Jacobian entries use a frozen-μ convention (`mu.d ≡ 0` in the dual state path; coolprop-wasm rejects analytic μ partials). At subcooled-liquid states the dropped μ term can dominate the true entry through a near-cancellation of the turbulent-friction ∂ρ/∂h and ∂μ/∂h terms. This is harmless where the momentum rows sit at the noise floor (Newton tolerates inexact Jacobians) but unbounded in general. Revisit a scoped FD treatment of μ if laminar-dominated or cancellation-prone regimes become important.
- The envelope-patience rule trades up to 14 extra outers on flat no-root grinds for correctness on slow descent. The tradeoff is bounded by the unchanged maxOuter cap.
- **Reported convection** `h` **and** `heatRate` **are recomputed after the solve, so they do not exactly match the converged state.** `solveSteady` builds its result conductors from a fresh `computeConductorHMap(ctx, res.state)` with no `prevH`. This skips the `H_RELAX` under-relaxation the outer Picard loop applied, so `conductors[id].heatTransferCoeff` and the `heatRate` derived from it can sit a few percent above the values the solution was actually built on (measured ~2.3 % on the regen-cooling example's Dittus–Boelter conductors). Solid temperatures, node states and branch flows are consistent with the converged coupling. Only the convection conductor _report_ is refreshed. The reconstructed `h` is therefore `heatRate_of_the_series_conduction_path / (area · ΔT_solved)`, not the reported coefficient. Fixing this means plumbing the converged h-map out of the stepper into the result assembly.
