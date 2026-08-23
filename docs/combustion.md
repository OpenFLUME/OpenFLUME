# Combustion: reacting junctions

This document covers the reacting-junction model (`junctions` in the network
config), the NASA CEA thermochemistry tables behind it, how the coupling is
solved inside the core Newton system, and the model's v1 limitations.

The first validation case is the shipped example **"LOX/RP-1 thruster
(combustor)"** (`src/ui/thrusterCombustor.ts`), whose physics regression
reference is the formula-coupled twin `basic-lox-rp1-thruster.fn`. A second
example, **"LOX/RP-1 thruster (transient startup)"**
(`src/ui/thrusterCombustorTransient.ts`), reuses the same geometry and
thermal model to ramp the propellant feed pressures from 100 psi to 1000 psi
over 1 s and hold there for another second — see "Transient reacting
junctions" below. Tests live in `src/core/__tests__/reactingJunction.test.ts`
(unit/steady/transient) and `src/ui/tests/examples.test.ts` (the shipped
transient example, end to end).

## The model

A reacting junction is an internal node where N reactant streams of unlike
fluids meet, react, and leave as a single product-gas stream:

```
junctions: [{
  id: "mainCombustor",
  node: "chamber",                      // internal node on the product fluid
  inlets: [
    { branch: "loxInjector",  role: "oxidizer" },
    { branch: "fuelInjector", role: "fuel" },   // multiple branches per role sum
  ],
  model: { type: "ceaTable", propellants: "lox-rp1", efficiency: 0.9409 },
  productFluid: "gas",                  // named idealGas entry in fluids
}]
```

The junction node's three balances:

- **Mass** — the ordinary nodal balance `Σṁ = 0` (steady) or
  `Σṁ = d(ρV)/dt` (transient, generic over every internal node — see
  "Transient reacting junctions" below) already closes; combustion
  conserves mass, so this row is completely unmodified by the junction.
- **Momentum** — each inlet branch evaluates its ΔP with upstream (reactant)
  density, and the junction back-pressures it through the shared nodal
  pressure unknown. Unchanged, except that the harmonic-mean friction
  density and the momentum-flux acceleration term are skipped on inlet
  branches (up- and downstream densities belong to different substances;
  averaging them is meaningless).
- **Energy** — replaced by the thermochemical closure

  ```
  R = ( h_node − η · h(T0(Pc, O/F)) ) / h_ref
  ```

  where `Pc` is the junction's pressure unknown, `O/F = ṁ_ox / ṁ_fuel` comes
  from the inlet branch mass-flow unknowns, `T0` is the CEA adiabatic
  chamber temperature, and `h(T) = cp·T` for the ideal-gas product.
  `η = model.efficiency` is defined on the enthalpy rise; for the rocket
  convention `η = η_c*²` (the shipped example uses `0.9409 = 0.97²`).
  `h_ref` is a normalization FROZEN at the current outer state — it must not
  depend on the unknowns, or the residual's true derivative picks up a term
  the dual-number Jacobian path does not carry (found the hard way; see
  the kernel comment).

The closure row and its exact derivatives (dual-number bilinear table
interpolation for `∂T0/∂Pc`, `∂T0/∂ṁ`) sit **inside the monolithic Newton
system** (`core/solver/kernel.ts`), so the strong feedback loop

```
Pc → injector ΔP → ṁ → O/F, gas flow → Pc
```

is solved simultaneously rather than by nested iteration. This replaced an
earlier outer fixed-point loop whose gain (≈ Pc/2ΔP_inj) exceeded 1 for
realistic injector stiffness — it diverged unless started essentially at its
own solution.

Within the Jacobian, the junction row's entries are FD-patched
(`markFd`): the CEA table is only C0 across grid lines and clamped at its
edges, so a two-sided dual derivative disagrees with the scalar function's
one-sided behaviour exactly at those kinks (e.g. O/F pinned at the table
edge by equal default warm-start flows). The patch reproduces the pure-FD
builder bit-for-bit for that row.

### Weak coupling: the property lag

The product gas's transport/state parameters (R, γ, μ, cp) are weak
functions of (Pc, O/F). They are Picard-lagged in the existing outer loop
(`core/solver/step.ts`): after each inner Newton solve, the model is
re-evaluated at the solved state and the named product fluid's `IdealGas`
instance is swapped through the live fluid-assignment map. Two contracts
keep the swap consistent:

- **Temperature continuity** — swapping cp silently re-interprets every
  stored enthalpy (`h = cp·T`). The state maps AND the inner Newton's
  unknown vector are re-seeded so temperature, not enthalpy, is continuous
  across the swap.
- **Settle criterion** — an outer iterate may certify only when the largest
  relative parameter change this iteration is below `1e-6`, so a converged
  result is never reported against properties that moved after its residual
  was measured.

The `junctions` entry in the steady result carries a per-junction summary:
Pc, O/F, per-role and total mass flows, the full CEA gas state (including
CEA's own c* as a validation reference), and clamp flags.

## The CEA tables

`src/core/combustion/generated/ceaTables.ts` is generated OFFLINE by
`scripts/build-cea-tables.py` (`npm run gen:cea-tables`; requires a one-time
`pip install cea numpy` — CEA is never a runtime dependency). For each
propellant pair it tabulates chamber-equilibrium `T0`, `mw`, `γ_s`, `μ`, and
`c*` over a log-spaced Pc grid × linear O/F grid, assuming standard-state
propellant injection (the rocket convention).

Runtime lookups (`src/core/combustion/combustionGas.ts`) bilinearly
interpolate in `(ln Pc, O/F)`. Notes:

- `gamma` is CEA's **isentropic exponent γ_s**, not `cp_eq/cv_eq`; it is the
  exponent that reproduces equilibrium sound speed and nozzle expansion.
- `R` and `cp` are DERIVED from the interpolated `mw` and `γ`
  (`R = R_u/mw`, `cp = γ/(γ−1)·R`) so the returned state always satisfies
  the ideal-gas relation exactly and is directly usable as an `IdealGas`.
- Out-of-range requests are **clamped to the nearest edge** (never
  extrapolated) and flagged; mid-iteration garbage (zero or negative flows,
  tiny pressures) is floored rather than thrown, so the residual stays
  total.

`src/core/combustion/model.ts` wraps the lookup behind the stream-generic
`CombustionModel` interface — roles are strings and mass flows arrive as a
per-role map — so future engine types (jet burners, afterburners, ramjets)
add model types without touching the solver.

## Validation snapshot

Converged junction solution of the shipped thruster example vs. the
formula-coupled twin: same feed/nozzle/jacket plumbing, but the chamber is
an ordinary node fed by an imposed total mass flow instead of a reacting
junction, and each propellant discharges through its unchanged orifice
formula into a boundary "manifold" node — the coupling closes through an
outer iteration around repeated solves instead of the junction's
monolithic Newton system (the architecture that predates junctions). The
twin is given the SAME CEA-matched gas properties (γ, R, cp) and target
chamber temperature (η·T0) as the junction's own converged state, so the
comparison isolates the coupling architecture and nozzle discretization
rather than conflating it with a different gas assumption. Pc and the
feed flows land within about 1–2 %; the emergent c\* sits below the ideal
1-D CEA reference in both formulations, since the discretized nozzle with
friction passes slightly more flow than the ideal choking relation (see
the transonic discretization note below). Live numbers and full
methodology: [docs/validation/combustion-report.md](validation/combustion-report.md#2-thruster-integral-quantities).

## Transient reacting junctions

The closure replaces a coupled-enthalpy energy row, which exists in BOTH the
steady and the transient coupled-h system (`useCoupledHMode`,
`core/solver/kernel.ts` — steady always takes it; transient takes it too for
every analytic, non-real-fluid `kineticEnergy` network, not just ones with
junctions). So a junction node in a transient network is solved exactly like
steady, with one difference: the node's MASS row now carries a real
`d(ρV)/dt` storage term like any other internal node, which needs
`node.volume` set (validate/junctions.ts and the generic node-volume check
both enforce this). The ENERGY row stays algebraic/quasi-steady — no
storage term — because chamber combustion/residence time (~ms) sits far
below any ramp rate a boundary schedule would realistically author; the
chamber still has genuine fill/drain dynamics through Pc, it just reaches
its instantaneous CEA equilibrium enthalpy infinitely fast rather than
integrating a stored energy of its own. `thrusterCombustorTransient.ts`
demonstrates this: the chamber pressure visibly lags the ramping feed
pressure (the mass row's dynamic) while its temperature-vs-Pc relationship
stays exactly the steady CEA curve at every instant (the energy row's
closure).

Two things specific to running the closure transiently:

- **Exhaust boundary.** A downstream boundary node held at a FIXED pressure
  is the standard steady treatment, but at the low end of a wide feed-pressure
  ramp (100 psi in the shipped example) it can over-expand the nozzle enough
  that a sea-level ambient (101.3 kPa) back-propagates an unphysical
  recompression kink into the last interior station. The shipped example
  fixes the exhaust at 30 kPa instead — a plausible high-altitude ambient —
  which was found (empirically, by sweeping the fixed exhaust pressure) to
  keep the profile monotone at both ends of the ramp without requiring a new
  dynamic-boundary solver feature.
- **Newton tolerance.** The extra mass-storage row raises the raw (mixed-unit,
  un-scaled) residual's noise floor at some points along the ramp enough that
  the steady example's `1e-8` tolerance is reachable only by grinding many
  extra inner-Newton iterations right at that floor — measured as one step
  going from ~15 s to 8+ minutes for no accuracy gain, since outer-loop
  (Picard) convergence is certified separately via `maxDeltaT < fluidTol` and
  is unaffected by tightening this bar further. The transient example uses
  `1e-7` instead.

## Known limitations (v1)

- **`kineticEnergy` required** (steady or transient) — the closure replaces
  a coupled-enthalpy energy row, which exists only in that system.
  Validation rejects species transport, which the coupled-h system does not
  support at all yet.
- **Frozen composition downstream.** The product is one constant-parameter
  ideal gas evaluated at chamber conditions; no shifting equilibrium
  through the nozzle.
- **Reactant inlet enthalpy is not a model input.** The committed tables
  assume standard-state propellant injection — correct for rockets, not for
  air-breathing burners, whose product state depends strongly on the air
  inlet enthalpy. The `CombustionModel` interface reserves the slot; the
  tables need one more dimension.
- **Product fluid must be a named `idealGas` entry**, because the property
  lag swaps its parameters.

### Transonic discretization (predates junctions)

With throat-clustered stations, the exact-integral (central) quasi-1D
compressible discretization has **multiple exact roots** near the sonic
point: mass, momentum, and energy conservation alone admit
entropy-violating combinations (discrete "expansion shocks" — a subsonic
donor jumping to a supersonic downwind state away from the area minimum),
and older builds could converge onto one, with 1–2 stations sitting far off
the smooth curve on the wrong branch. On this example's grid the central
system converges readily — but **onto an inadmissible root**: from the
authored warm start, from a converged upwind solution, and from an exact
isentropic seed alike, Newton lands on a state carrying a discrete expansion
shock in the convergent, which the second-law audit certifies as
entropy-violating. The problem is not that the physical root is unreachable
in principle; it is that the central system's basin of attraction here
belongs to the nonphysical root, so a converged, residual-clean answer is
silently wrong unless the audit is switched on.

The solver now closes this with **limited-upwind momentum faces**
(`settings.momentumFluxScheme: "upwind"`, the default): each compressible
branch (ideal gas; real fluid when `kineticEnergy` is on) carries one
exit-face velocity built from its _upstream_ node's
density plus a MUSCL/van Albada slope-limited correction, and its momentum
row advects the feeding branches' face velocities — the standard
system-code discretization (GFSSP-style donor-cell advection with a
second-order limited reconstruction). A momentum row's sensitivity to its
downwind density is bounded by grid-smooth increments, so the
expansion-shock roots cease to exist **by construction** and the transonic
solve is seed-robust: this example reaches the same physical root from the
authored warm start, from an exact isentropic profile, and from the
historical artifact root. Liquids, real fluids without `kineticEnergy`,
species mixtures, junction-inlet branches, and chain entrances keep
the exact central form bit-identically. The legacy `"central"` scheme
remains available and is certified post-hoc by a second-law audit
(`settings.transonicAdmissibility`; see `core/solver/admissibility.ts`).

What remains is first-order behavior at the sonic cell: the crossing is
smeared across the segment bounding the throat, and the discretized nozzle
passes a few percent more flow than the ideal choking relation (the GFSSP
verification cases measure 2–6 %).

That choking bias is the **dominant** error in the gas path, and it is worth
being precise about where it lives, because it is easy to misread. It is set
at the sonic cell and nowhere else, but it then offsets the _entire_ Mach
profile — including deep-subsonic barrel stations at M ≈ 0.16, which sit
high by very nearly the mass-flow error. So a large Mach deviation at the
nozzle exit is mostly this single throat-side bias showing through, not
error accumulated cell by cell down the divergent. Two consequences:

- **Grid resolution at the sonic cell is the lever.** On a frictionless
  replica of the thruster contour, splitting only the two segments either
  side of the throat four ways cuts the bias from 5.8 % to 1.4 % without
  touching any other cell. But refining _only_ there is not a shortcut: the
  downstream Mach profile is governed by the divergent's own truncation and
  gets worse if the divergent is left coarse, so refine both together.
- **Mach-gating the scheme does not help.** Blending toward `central` away
  from M ≈ 1 has to keep upwind at the sonic cell — that is the only place
  the twin roots live, and the whole reason upwind is the default — so it
  cannot touch the term that dominates the budget. The same holds for the
  choked duct cases in the compressible-flow report, which are subsonic
  throughout and choke at the exit cell.

Integral quantities are robust — chamber pressure varies by ~1 % and O/F by
< 0.1 % across formulations — and the profile is monotone and physical
through the throat. Cold starts and heavily perturbed states converge
reliably.
