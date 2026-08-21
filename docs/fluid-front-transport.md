# Fluid-front transport: a conservation-speed cryogenic-front / liquid-availability state gating the TT-WF dry side

A scalar tracer per internal fluid node is advected at conservation speed by the accepted flow. This tracer gates the dry-side film/SP heat release of `ttWf` convection conductors. The model exposes no tunable parameter: the front moves at the mass-conservation speed of the accepted flow, full stop.

Relevant code includes `src/core/fluidFront.ts` (pure transport kernel + gate), `solver.ts` (`updateFluidFrontStates` (the accepted-step commit), `correlations.ts` (the TT-WF dry-side gate consult), `schema.ts`, and `diagnostics.ts`. Tests are located in `src/core/__tests__/fluidFrontTransport.test.ts`. Verification evidence is discussed in §6 below.

---

## 1. State and semantics

```
a_i ∈ [0,1]   : cryogenic front fraction of internal fluid node i
```

This metric measures the fraction of node `i`'s fluid inventory that is **advected cryogenic-inlet fluid**: fluid that entered the network through a boundary node flagged with `fluidFrontInlet: 1` since `t = 0`. Boundary nodes carry
no state. Their configured value (default 0) is used only as the upwind
value of flow _entering_ the domain.

The following are deliberate non-identities:

| quantity                                                    | why `a` is not it                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| equilibrium quality `x_e(h)` / liquid availability `χ_l(h)` | functions of the local enthalpy, not of where the fluid came from; the cold-vapor tail is the advected enthalpy field                  |
| TT-WF `fWet` / rewet latch                                  | wall-side markers driven by wall cooling, not by fluid arrival (and bootstrap-degenerate: the wall must cool before the latch can set) |
| vapor temperature `T_v`                                     | a reconstructed phase temperature, not an inventory                                                                                    |

`a` carries exactly one piece of information: _displaced cryogenic inlet fluid has arrived here_, advanced by the accepted mass fluxes alone. A warm-filled line initializes `a = 0` (there is no initial-condition knob, the model's purpose is the fill transient; a pre-chilled line is out of scope).

### Opt-in surface (fully backward compatible)

- `conductor.type.correlation.fluidFront: true` on a **ttWf** convection
  conductor (rejected by `validate.ts` on any other model) does two things:
  enables the network-wide transport state (one `a_i` per internal fluid
  node) and gates that conductor's dry side. The gate is per-conductor;
  the transport state exists once any ttWf conductor opts in.
- `node.fluidFrontInlet ∈ [0,1]` on a **boundary** node marks a cryogenic
  inlet (`1`), the tracer source.
- `TransientResult.fluidFront?: Record<nodeId, { fraction: number[] }>`:
  accepted-step histories aligned 1:1 with `times`. Absent unless enabled.

With the flag absent everywhere, no state is allocated, no gate is consulted, and results are identical to a configuration without the flag (pinned by the existing ttWf/D-H/golden suites).

## 2. Transport equation and discretization

Per internal node `i` with (mixture) fluid mass `m_i = ρ_i·V_i`, the transport equation is:

```
d(m_i a_i)/dt = Σ_in mdot·a_up − Σ_out mdot·a_i
```

This is discretized with **donor-cell upwinding + backward Euler** on the accepted end-of-step state, the same structural choice as the solver's enthalpy transport (upwind `h_sum` in the energy residual) and species transport:

```
(m_i^{n+1} a_i^{n+1} − m_i^n a_i^n)/dt
  = Σ_j∈in(i)  |mdot_j^{n+1}| · a_{up(j)}^{n+1}
  − Σ_j∈out(i) |mdot_j^{n+1}| · a_i^{n+1}
```

The coupled system is linear in `a^{n+1}` with an M-matrix.

```
A_ii = m_i^{n+1}/dt + Σ_out(i) |mdot|        (> 0 if storage or outflow)
A_ij = −(inflow rate from internal neighbor j)
b_i  = (m_i^n/dt)·a_i^n + Σ_boundary inflows |mdot|·a_bnd
```

This system is solved directly (dense Gaussian elimination with partial pivoting: one unknown per internal node). A node with no storage and no through-flow (isolated) keeps its accepted value by a degenerate-row guard.

**No transport-speed parameter exists.** The front moves at the mass conservation speed of the accepted flow. The only numerical smoothing is the donor-cell/backward-Euler truncation itself: first-order Godunov-type smearing of order one cell per step (a fixed, documented discretization choice, not an exposed calibration knob (there is nothing to tune: the scheme has no ε)).

**Flow reversal** needs no special case: the upwind donor follows the sign
of each branch's accepted `mdot`, so a reversed branch advects the opposite
endpoint's `a` (kernel- and network-tested, including tracer drain-back
through the original inlet).

**Zero-storage nodes** (`V = 0`) degenerate exactly to the algebraic
well-mixed pass-through `Σ_in mdot·a_up = Σ_out mdot·a_i` (the same
convention as the species-transport mixing at a junction).

## 3. Conservation and boundedness (proofs)

### 3.1 Global tracer conservation

Summing the nodal BE equations over all internal nodes, every internal branch flux `|mdot|·a` appears once positively (inflow to the downstream node) and once negatively (outflow from the upstream node) and cancels EXACTLY. What remains is the boundary balance:

```
Σ_i [(m_i a_i)^{n+1} − (m_i a_i)^n] = dt · (Σ_bnd in |mdot|·a_bnd − Σ_bnd out |mdot|·a_i)
```

The total tracer inventory changes only through boundary fluxes, with **right-rectangle (end-of-step) quadrature**: the BE-consistent convention. The identity is algebraic in the linear solve. It holds to roundoff regardless of whether the step satisfied its own mass balance. Flow reversal is covered because the boundary terms use the upwind convention in both directions.

### 3.2 Boundedness without clipping

Let `0 ≤ a^n ≤ 1` and `0 ≤ a_bnd ≤ 1`, and assume the accepted step's
**converged nodal mass balance** `S_in,total(i) − S_out,total(i) =
(m_i^{n+1} − m_i^n)/dt` (the solver's own mass residual at a converged
step).

- **Lower bound.** `A` has positive diagonal, non-positive off-diagonals,
  and is column diagonally dominant: for column `j`,
  `A_jj − Σ_{i≠j}|A_ij| = m_j/dt + (outflow from j to BOUNDARY nodes) ≥ 0`.
  Hence `A` is an M-matrix, `A⁻¹ ≥ 0`, and `b ≥ 0` gives `a^{n+1} ≥ 0`.
  (No mass-balance assumption needed for the lower bound.)
- **Upper bound.** If any `a_i^{n+1}` exceeded `M = max(max a^n,
max a_bnd)`, then for the maximizing row:
  `(m_i^{n+1}/dt + S_out,total)·a_i ≤ (m_i^n/dt)·a_i^n + S_in,total·M`
  and the mass balance gives `m_i^{n+1}/dt + S_out,total ≥ m_i^n/dt +
S_in,total`, forcing `a_i ≤ M`. Inductively `a^{n+1} ≤ 1`.

The scheme is bounded in `[0,1]` **by construction** at converged accepted steps (no limiter, no clipping). The implementation still post-guards: excursions within roundoff (`≤ 1e-12`) are clamped silently. Any larger (non-conservative) correction is clamped and **counted** (`diagnostics.fluidFront.boundsClampCount`); it can only occur if the committed step's mass balance was not actually converged. The counter therefore doubles as a commit-time convergence audit.

### 3.3 Adaptive step-doubling consistency

The adaptive integrator's accepted trajectory is the **pair** of half steps
(`t → t+dt/2 → t+dt`), each satisfying its own converged mass balance; a
single full-`dt` front commit would see the half-step truncation mismatch
as a spurious tracer source. The commit therefore follows the accepted trajectory: `updateFluidFrontStates` receives the accepted half-step state and performs **two half-step commits**, each mass-consistent. This is the tracer analogue of the Richardson/step-doubling acceptance structure, not an extra knob.

## 4. The heat-exchange gate (TT-WF dry side)

For a ttWf conductor with `fluidFront: true`, the area-average flux becomes:

```
q_bar' = (1 − fWet)·g(a)·q_Dry + fWet·q_Wet,    g(a) = a²(3 − 2a)
```

with `a` being the **accepted, frozen** front fraction of the conductor's fluid node. `g` is the C1 smoothstep on `[0,1]`: `g(0) = 0`, `g(1) = 1`, zero slope at both ends. The bounds are fixed at `[0,1]` by definition: **there is no fitted threshold.**

Semantics of the limits:

- `a = 0` (no cryogenic inventory has reached the node): **no** dry-side film/SP wall exchange; the h-map returns exactly `h = 0`, bypassing the fallback-h floor (a closed gate means zero, not ~5 W/m²K of floor leakage). A partially open gate (`0 < g < 1`) likewise skips the floor (the floor guards correlation _failures_; a gate-suppressed h below the floor is the closure working as designed) but keeps the shared under-relaxation across outer iterations.
- `a = 1` (the node's fluid is cryogenic-inlet fluid): the full, untouched D-H/TT-WF dry-side map.
- `fWet = 1` (wall fully rewetted): the gate is inert for any `a` (only the dry term is gated).

**What the gate is:** a closure for the _unresolved relation between the cold-vapor/front state and wall exchange_. The motivation: an advected cold-vapor tail can thermalize the wall well before the liquid front arrives, while in chilldown experiments the wall stays warm until the front arrives, as the real gas column ahead of the front does not exchange heat with the wall at the film/SP rate. The gate encodes exactly that, keyed on conservation-speed displacement arrival. Dry-side exchange is the only pre-front cooling path, and it is re-timed by a transport signal rather than removed.

**What it is not:** it does not touch the wet side (DB/NB/TB), the node's enthalpy or quality, the TT-WF front-evolution machinery (`r_E` keeps using the _local_ flux map's `q_Wet − q_Dry` capability difference (a property of the map, not of the transport-gated exchange)), or the fluid energy budget structure. Energy conservation is untouched: gating `q` changes _what_ energy is exchanged (the same gated `q̄'` leaves the wall and enters the mixture through the shared conductor path), and the front state carries the arrival information.

`h_eff` rescaling: `q` and `h_eff` share the reference `(T_w − T_node)`, so the gated secant is `h_eff·(q̄'/q̄)` with no re-evaluation of the guarded secant is needed, and the TT-WF `h_eff` contract (finite as `T_w → T_node`) is preserved.

**Scope:** the gate currently applies to the TT-WF dry side only.

## 5. Solver lifecycle (accepted-step discipline)

The solver lifecycle is identical in structure to the TT-WF `fWet`/latch lifecycle:

- The state lives in `SolverContext.fluidFront` (allocated only when enabled), **not** in `StepState`. Newton/outer iterations, adaptive trial half-steps, and rejected steps only _read_ the frozen accepted `a` (through the gate). Their proposals die with the discarded evaluations.
- `updateFluidFrontStates(ctx, state, dt?)` is the sole mutator, called by `transient.ts` immediately after `updateConductorLatches`:
  - `dt` omitted ⇒ `t = 0` initialization: `a_i = 0`, previous node masses seeded from the IC;
  - `dt` = accepted step size ⇒ the conservative commit of §2 (two half-step commits on the adaptive path), then the snapshot is appended to `TransientResult.fluidFront`.
- Aborted runs return partial results sliced consistently (histories always align 1:1 with `times`).

Because the state is not in `StepState`, adaptive trial cloning needs nothing new: rejected trials never reach the commit call. The `commitCount` diagnostic equals the number of accepted steps (one commit per accepted step, never more).

## 6. Verification summary

Tests are located in `src/core/__tests__/fluidFrontTransport.test.ts`. Headline evidence includes:

| contract                   | evidence                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| exact front travel         | kernel reproduces the BE well-mixed analytical recurrence to ≤ 1e-14 per step on a 5-node line; arrival order/timings as predicted by the recurrence                                                   |
| global conservation        | recorded-series audit on a gated 3-node LH2 chilldown: \|ΔΣ(m·a) − ∫influx dt\| = 6.2e-15 kg (rel ~5e-14); reversal run closes identically                                                             |
| bounds                     | every recorded `a ∈ [0,1]`; `boundsClampCount = 0` on every run (incl. 18-rejection adaptive); randomized compressible-step sweep: 300 steps, 0 corrections                                            |
| accepted-step immutability | fixed-step histories replay to ≤ 1e-9 from the kernel + recorded accepted inputs; adaptive: `commitCount == stats.steps`, 1:1 alignment; direct `solveStateStep` test: Newton + h-map never mutate `a` |
| heat-gate limits           | `a=0` ⇒ `h = 0` exactly; `a=1` ⇒ identical to ungated TT-WF; C1 monotone sweep, no jumps (`                                                                                                            | Δh  | ≤ 1.6·h(1)·Δa`); `fWet=1` ⇒ gate inert |
| front/wetting distinction  | `a` half-crossing precedes latch set and `fWet > 0` on every node; the kernel reads no enthalpy/quality/fWet input                                                                                     |
| backward compatibility     | no `fluidFront` field without the flag; full pre-existing suite green                                                                                                                                  |
