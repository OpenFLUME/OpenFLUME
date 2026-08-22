# Combustion: reacting junctions

This document covers the reacting-junction model (`junctions` in the network
config), the NASA CEA thermochemistry tables behind it, how the coupling is
solved inside the core Newton system, and the model's v1 limitations.

The first validation case is the shipped example **"LOX/RP-1 thruster
(combustor)"** (`src/ui/thrusterCombustor.ts`), whose physics regression
reference is the formula-coupled twin `basic-lox-rp1-thruster.fn`. Tests live
in `src/core/__tests__/reactingJunction.test.ts`.

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

- **Mass** — the ordinary nodal balance `Σṁ = 0` already closes (combustion
  conserves mass). Unchanged.
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

Converged junction solution of the shipped thruster example vs the
formula-coupled twin (`basic-lox-rp1-thruster.fn`, fixed γ = 1.2 gas):

| Quantity | Twin | Junction | Note |
| --- | --- | --- | --- |
| Pc | 986.6 kPa | 983.3 kPa | −0.3 % |
| ṁ_ox | 0.5472 kg/s | 0.5622 kg/s | +2.7 % |
| ṁ_fuel | 0.2105 kg/s | 0.2170 kg/s | +3.1 % |
| O/F | 2.600 | 2.592 | — |
| T_chamber | 3192.8 K | 3190.9 K | = η·T0 exactly |
| emergent c* = Pc·At/ṁ | 1636 m/s | 1586 m/s | vs η_c*·c*_CEA = 1701 m/s |

The few-percent shifts are physics, not error: the junction runs the CEA
equilibrium gas (γ ≈ 1.127, cp ≈ 3236 J/kg·K) where the twin fixes γ = 1.2,
cp ≈ 2169. The emergent c* sits ~6.7 % below the ideal 1-D CEA reference —
the discretized nozzle with friction passes slightly more flow than the
ideal choking relation (see the transonic discretization note below).

## Known limitations (v1)

- **Steady + `kineticEnergy` only.** The closure replaces a coupled-enthalpy
  energy row, which exists only in that system. Validation rejects
  transient mode and species transport.
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
system is worse than multi-rooted: it has **no admissible transonic root at
all** — Newton walks away even from an exact isentropic seed.

The solver now closes this with **limited-upwind momentum faces**
(`settings.momentumFluxScheme: "upwind"`, the default): each compressible
branch (ideal gas; real fluid when `kineticEnergy` is on) carries one
exit-face velocity built from its *upstream* node's
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

What remains is first-order behavior at the sonic cell: the crossing
is smeared across the conv7/throat segment, and the discretized nozzle
passes a few percent more flow than the ideal choking relation (a
truncation bias that shrinks with grid refinement; the GFSSP verification
cases measure 2–6 %). Integral quantities are robust — chamber pressure
varies by ~1 % and O/F by < 0.1 % across formulations — and the profile is
monotone and physical through the throat. Cold starts and heavily perturbed
states converge reliably.
