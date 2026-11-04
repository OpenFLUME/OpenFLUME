---
title: "Lab 4: Fanno flow"
description: Fanno friction choking — choking length from the tables, a quasi-1-D duct with Momentum flux and Kinetic energy, grid convergence, and choking limits.
---

# Lab 4: Fanno flow

Students compute the choking length of an adiabatic constant-area duct from
the Fanno tables, build the same duct in OpenFLUME as a chain of pipe segments,
and switch on the two settings that turn a network solver into a quasi-1-D
compressible solver. They then measure how the answer converges with the
number of segments, and push the model past the conditions it can represent.

The duct is case 1 of the
[compressible-flow validation report](../validation/compressible-report.md),
which recreates the NASA GFSSP compressible verification study (Bandyopadhyay
and Majumdar, TFAWS 2007).

## Learning objectives

By the end of the lab, students should be able to:

1. Use the Fanno relations or tables to find the choking length `L*`, the
   sonic-state pressure and temperature, and the mass flow of a friction-choked
   duct.
2. Explain why a network solver needs a convective-acceleration term and
   stagnation-enthalpy transport before it can represent compressible duct
   flow, and turn both on in OpenFLUME.
3. Discretize a duct into segments, measure the grid convergence of the mass
   flow, and explain where the error comes from.
4. Recognize what a lumped network solver does when it is asked for something
   beyond choking. It has no shock capture and no representation of the
   expansion outside a choked exit.

## Prerequisites

- Compressible flow: stagnation properties, Mach number, Fanno flow, and the
  Darcy (`f`) versus Fanning (`f_F = f/4`) friction-factor conventions.
- Lab 1 or the [Getting started](../guides/getting-started.md) page. Lab 2
  helps.

## Time

About 45 minutes of pre-lab work and 1.5 hours in the lab.

## Theory

**Fanno flow** is steady, adiabatic flow with wall friction in a duct of
constant area. The stagnation temperature `T₀` is constant along the duct.
Friction drives a subsonic flow toward `M = 1`. The duct length that brings
an inlet Mach number `M` exactly to `M = 1` at the exit is `L*`. With the
**Darcy** friction factor `f`:

```
f L*/D = (1 − M²)/(γ M²) + ((γ+1)/(2γ)) ln[ (γ+1) M² / (2 + (γ−1) M²) ]
p/p*   = (1/M) sqrt( (γ+1) / (2 + (γ−1) M²) )
T/T*   = (γ+1) / (2 + (γ−1) M²)
```

Many textbook tables are written with the Fanning factor and list
`4 f_F L*/D`, which is the same number as `f L*/D` with Darcy `f`.

**What a network solver normally leaves out.** By default, an OpenFLUME branch
relates `ΔP` to `ṁ` through friction alone, and the energy equation carries
static enthalpy `h`. That is correct at low Mach number. For compressible duct
flow, two opt-in settings close the quasi-1-D equations (user manual §4.1.2,
§4.1.4, and §3.11):

- **Momentum flux** (`settings.momentumFlux`) adds the pressure needed to
  accelerate the gas as its density falls:
  `ΔP_accel = (ṁ/A)² (1/ρ_to − 1/ρ_from)`.
- **Kinetic energy** (`settings.kineticEnergy`) transports stagnation enthalpy
  `h₀ = h + V²/2`, so the static temperature falls as the gas speeds up and `T₀`
  is conserved.

Both are checkboxes in the **Setup** tab, **Physics** section, under
_Compressible formulation_ (manual §6.6). Together they let a chain of `pipe`
branches with a constant friction factor reproduce Fanno flow. A third
control, **Momentum-flux scheme**, chooses how the acceleration term is
evaluated. The default, **Limited upwind**, converges from cold starts but is
first order at the choking cell. In the validation report, the choked mass
flow under the default scheme is 2–3.5 % from the analytic value on 21-node
clustered grids. **Central** is more accurate when it converges to the
physical root, but it needs a good starting guess.

**Limits.** There is no shock capture (manual §1.7). A boundary node imposes a
static pressure at the duct exit, whatever the flow there.

## The problem

Nitrogen, treated as an ideal gas, flows through a straight, adiabatic,
constant-area duct (validation report case 1):

| Quantity              | Value                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Gas                   | `R = 296.8 J/(kg·K)`, `γ = 1.4`, `cp = γR/(γ−1) = 1038.8 J/(kg·K)`, `μ = 1.78×10⁻⁵ Pa·s` |
| Diameter              | `D = 6 in = 0.1524 m`                                                                    |
| Darcy friction factor | `f = 0.002` (constant)                                                                   |
| Inlet static state    | `P₁ = 50 psia = 344.74 kPa`, `T₁ = 80 °F = 299.82 K`                                     |
| Inlet Mach number     | `M₁ = 0.5`                                                                               |

## Pre-lab hand calculation

1. From the Fanno relations or a table at `M = 0.5`, find `f L*/D`, `p/p*`,
   and `T/T*`.
2. Compute `L*` in metres and inches, the sonic pressure `P*`, the sonic
   temperature `T*`, and the stagnation temperature `T₀`.
3. Compute the inlet density, velocity, and Reynolds number, and the mass flow
   `ṁ = ρ₁ M₁ a₁ A`.
4. At the duct midpoint (`x = L*/2`), the remaining `f L/D` is half the inlet
   value. Find the Mach number, pressure, and static temperature there.
5. Predict qualitatively:
   1. The exit back pressure is lowered below `P*` with everything else
      fixed. What happens to `ṁ` and to the exit pressure in the real duct?
   2. The duct is cut to half length, `L*/2`, with the exit still at `P*`.
      Is it still choked? If so, what is the new inlet Mach number and
      mass flow?

## Procedure in OpenFLUME

Set **Units ▾** to **SI**. Every number below is SI.

### Part A: Build the duct

1. Click **New**.
2. Open the **Setup** tab.
   - **Fluids**: set the model to **Ideal Gas** and choose **Custom**. Enter
     `R` = 296.8, `gamma` = 1.4, `mu` = 1.78e-5, `cp` = 1038.8.
   - **Solver**: leave **Mode** on Steady.
   - **Physics**: tick **Momentum flux** and **Kinetic energy**. Read the
     formulation summary line beneath them. Leave **Momentum-flux scheme** on
     **Limited upwind (default)**.
3. On the **Model** tab, place two **Boundary node**s:
   - `Inlet`: **Pressure** 344738 Pa, **Temperature** 299.82 K.
   - `Exit`: **Pressure** 161236 Pa (your `P*`), **Temperature** 262.34 K
     (your `T*`; it matters only if flow reverses).
4. Connect `Inlet` to `Exit` with a **Pipe**. Set **Length** 81.462 m,
   **Diameter** 0.1524 m, **Roughness** 0, **Friction** to **Constant f**,
   and **Darcy friction factor f** 0.002.
5. Select the pipe and choose **Split…** from the selection-actions menu.
   Enter 20 segments and click **Split**. You now have 19 internal nodes and
   20 pipe segments.

As a check, or if you are short of time, you can paste the unsplit duct
through **Text view** → **Apply**, then do step 5:

```
// Fluid Network config v2
network "Lab 4 Fanno duct" {
settings: {"mode":"steady","tolerance":0.000001,"maxIterations":200,"relaxation":0.9,"momentumFlux":true,"kineticEnergy":true}
fluid: {"model":"idealGas","params":{"R":296.8,"gamma":1.4,"mu":0.0000178,"cp":1038.8}}
node "in" boundary @ (0, 0) data: {"pressure":344738,"temperature":299.82,"label":"Inlet"}
node "out" boundary @ (800, 0) data: {"pressure":161236,"temperature":262.34,"label":"Exit"}
branch "duct": "in" -> "out" pipe data: {"label":"Duct","length":81.462,"diameter":0.1524,"roughness":0,"frictionFactor":0.002}
}
```

### Part B: Run and compare with Fanno

1. Click **Run**. The status pill should read **Converged**.
2. Click any segment to read the mass flow (every segment carries the same
   flow). Compare it with your hand value.
3. Set **Color by** to **Mach**. Each segment reports the Mach number at its
   upstream end.
4. In the **Results** tab, click **+ Plot**, choose **Station along path** as
   the x axis, and plot the node pressures and node temperatures. Compare the
   pressure at the midpoint node (the 10th internal node) with your pre-lab
   value.
5. Look under the plot for **Findings**. Any segment at Mach 0.8 or above is
   reported as **Near-sonic flow**, and at Mach 1 or above as **Sonic flow**
   (`src/core/resultFindings.ts`).

### Part C: Grid convergence

1. Click **Undo** in the toolbar once to undo the split (a split is a single
   undo step). Select the pipe and split it into 10 segments. Run, and record `ṁ`.
2. Repeat with 40 segments, and with 80 if time allows.
3. Tabulate the mass-flow error against the number of segments and estimate
   the order of convergence.

### Part D: What the two settings do

Go back to 20 segments: click **Undo** once, then **Split…** the pipe into 20.

1. In **Setup** → **Physics**, untick **Kinetic energy** and run. Record `ṁ`,
   the temperature profile, and the largest Mach number.
2. Also untick **Momentum flux** and run again.
3. Tick both again before Part E.

### Part E: Beyond choking

1. With both settings on and 20 segments, set the `Exit` **Pressure** to
   120000 Pa and run. Record `ṁ` and the Mach number of the last segment.
2. Repeat with 101325 Pa.
3. Click **Undo** until the duct is a single pipe again. This also undoes the
   exit-pressure and Physics edits, so check that **Exit** is back at
   161236 Pa and both Physics boxes are ticked. Set **Length** to 40.731 m
   (`L*/2`), split into 20 again, and run.

## Questions

1. How far is the 20-segment solver mass flow from the Fanno value? Is the
   solver high or low? Where along the duct is the pressure error largest, and
   why there?
2. What order of grid convergence did you measure? The default scheme is
   documented as second order on smooth profiles and first order at the sonic
   cell (manual §4.1.2). Is your measured order consistent with that?
3. The validation report reaches 0.01 % on 21 nodes with the central scheme
   and a grid clustered toward the choked exit. Name two things in your setup
   that differ from that.
4. With **Kinetic energy** off, what happens to the static temperature along
   the duct, and why? With both settings off, the mass flow is far too high
   and the last segment reports a Mach number above 1. The **Findings** flag
   it, but the solve still converges. Why do the equations not prevent it?
5. In Part E, theory says the mass flow of a choked duct cannot increase when
   the back pressure is lowered: the exit stays at `P*`, and the gas expands to
   the back pressure outside the duct. What does the solver do instead, and
   why can a boundary node not represent the real exit?
6. For the half-length duct, compare the solver's mass flow with your pre-lab
   answer. Is the duct choked? How does the error compare with Part B?
7. How would you decide, for a real feed-line problem, whether you need these
   two settings at all? (Hint: look at the Mach number of the incompressible
   solution.)

## Extensions

- **Central scheme from a cold start.** In **Setup** → **Physics**, set
  **Momentum-flux scheme** to **Central**, leave the **Second-law
  admissibility audit** ticked, and run the 20-segment duct with exit at
  `P*`. Plot pressure along the path and look closely at the last two
  internal nodes. The manual (§4.1.2) explains why the central form can
  converge to a non-physical root unless it is seeded on the physical branch.
  The interface hint says the same: _"A clean residual is not by itself
  evidence of a physical answer here."_ Then seed it: set each segment's
  **Initial flow guess** to your hand `ṁ`, and the internal node pressures and
  temperatures to a falling profile. Does the result change?
- **Rayleigh flow.** Set the friction factor to 0 and add a **Heat Input** to
  each internal node (case 2 of the validation report). Compare the
  temperature peak with the Rayleigh maximum at `M = 1/sqrt(γ)`.
- **Long duct.** Set **Length** to `1.5 L*` with the exit still at `P*`.
  Show that the analytic flow is subsonic at the exit, and find the inlet
  Mach number that matches the exit pressure.

::: details Answer key

Hand values were computed in Python from the Fanno relations, with bisection
for inverse Mach lookups. The critical length matches the validation report
(3207 in). Solver values are OpenFLUME 0.3.1, run locally on the model above
with the default scheme and a cold start (internal nodes created by **Split…**
take the inlet state as their starting guess). Solver numbers to the
third significant figure may shift between versions. Report differences
larger than that.

**Pre-lab**

- At `M = 0.5`: `f L*/D = 1.0691`, `p/p* = 2.1381`, `T/T* = 1.1429`
  (`p₀/p₀* = 1.3398`).
- `L* = 1.0691 × 0.1524 / 0.002 = 81.46 m = 3207 in`. `P* = 161.24 kPa`.
  `T₀ = 314.81 K` and `T* = T₀/1.2 = 262.34 K`.
- `ρ₁ = 3.874 kg/m³`, `a₁ = 352.96 m/s`, `V₁ = 176.5 m/s`,
  `Re = 5.9×10⁶`, `A = 0.018241 m²`, so `ṁ = 12.472 kg/s`.
- Midpoint: `f L/D = 0.5345`, so `M = 0.589`, `p = 289.8 kPa`,
  `T = 294.36 K`.
- Step 5.1: `ṁ` does not change, and the exit pressure stays at `P*`. The
  expansion to the lower back pressure happens outside the duct.
- Step 5.2: for `f L/D = 0.5345` the choking inlet Mach number is
  `M₁ = 0.589`. That requires `P* = 191.8 kPa`, which is above the 161.2 kPa
  back pressure, so the half-length duct is choked with
  `ṁ = 14.70 kg/s`.

**Part B** (solver, 20 uniform segments)

- `ṁ = 12.926 kg/s`, which is 3.6 % high.
- Midpoint node pressure: 285.5 kPa, against 289.8 kPa analytic (−1.5 %).
  At the last internal node (`x = 0.95 L*`) the solver gives 185.4 kPa,
  against 201.3 kPa analytic. There the reported Mach number is 0.92,
  against 0.82 analytic. The error concentrates near the choke, where the
  gradients are steepest and the limited-upwind scheme drops to first order.
- Static temperature falls monotonically, from 299.8 K at the inlet to
  270.6 K at the last internal node. The exit node shows the boundary value,
  262.3 K.

**Part C** (solver, uniform segments)

| Segments | ṁ [kg/s] | error  | Mach at last segment |
| -------- | -------- | ------ | -------------------- |
| 10       | 13.221   | +6.0 % | 0.876                |
| 20       | 12.926   | +3.6 % | 0.916                |
| 40       | 12.749   | +2.2 % | 0.943                |
| 80       | 12.642   | +1.4 % | 0.962                |

The error falls by a factor of about 1.65 per halving, an observed order of
about 0.7. The mass-flow error is controlled by the choking cell, which is
first order. The report's 2.05 % for the default scheme used 21 nodes
**clustered** toward the exit, which is more accurate than 21 uniform nodes.
Its 0.01 % used the central scheme on the clustered grid, with the analytic
solution as the starting guess.

**Part D** (solver, 20 segments)

| Settings           | ṁ [kg/s]       | Temperature profile | Largest Mach |
| ------------------ | -------------- | ------------------- | ------------ |
| Both on            | 12.926         | falls to 270.6 K    | 0.92         |
| Momentum flux only | 12.355         | constant 299.8 K    | 0.93         |
| Both off           | 18.191 (+46 %) | constant 299.8 K    | 1.44         |

- Without **Kinetic energy**, the energy equation carries static enthalpy
  with no `V²/2`, so an adiabatic duct keeps its static temperature. That is
  wrong for Fanno flow, where `T₀` is conserved and `T` falls. With Momentum
  flux alone, the mass flow lands within 1 % of the Fanno value in this case,
  but the temperature field is wrong, so treat the agreement as a coincidence.
- With both off, the branch law is an algebraic `ΔP(ṁ)` with no Mach number
  in it (manual §1.7). Nothing in the equations limits the velocity. The
  Mach number shown is computed after the solve from `ṁ`, `ρ`, and `T`. The
  **Findings** report it as **Sonic flow**, but that is a check on the result,
  not a constraint in the equations.

**Part E** (solver)

| Exit pressure         | ṁ [kg/s] | Mach at last segment | Analytic ṁ      |
| --------------------- | -------- | -------------------- | --------------- |
| 161.2 kPa (`P*`)      | 12.926   | 0.92                 | 12.472          |
| 120 kPa               | 13.142   | 1.05                 | 12.472 (choked) |
| 101.3 kPa             | 13.207   | 1.11                 | 12.472 (choked) |
| 161.2 kPa, `L = L*/2` | 15.486   | 1.05                 | 14.70 (choked)  |

- The solver lets the mass flow keep rising slowly as the back pressure
  falls, and the last segment goes slightly supersonic. A boundary node
  imposes a static pressure at the exit station. The real exit sits at `P*`
  and expands outside the duct through waves, which a lumped network cannot
  represent. There is no shock capture (manual §1.7). The
  **LOX/RP-1 thruster (combustor)** example sets its exhaust boundary at the
  matched-expansion pressure for the same reason.
- The half-length duct is choked, and the 161.2 kPa exit pressure is below
  its own `P*` of 191.8 kPa. It is therefore in the same beyond-choking
  regime as the first two rows: the last segment goes supersonic and the
  solver overshoots the choked flow by 5.3 %.

**Extensions**

- Central scheme, cold start (OpenFLUME 0.3.1, local run): the solve reports
  **Converged** with `ṁ = 12.403 kg/s`. However, the pressure at the last
  internal node drops to about 122 kPa, _below_ the 161.2 kPa exit pressure,
  and the last segment reports Mach 1.25. This is an expansion-shock root of
  the kind §4.1.2 describes: subsonic to supersonic away from an area minimum.
  In our run the audit raised no warning. Students should identify the dip and
  the pressure _rise_ into the exit as non-physical. Report what your run
  shows. If your result differs, that is worth noting.
- Long duct, `L = 1.5 L*`, exit at 161.2 kPa: the analytic inlet Mach number is
  0.446, the exit Mach number is 0.90 (subsonic), and `ṁ = 11.12 kg/s`. The
  choking limit for that length would be `M₁ = 0.447` and `ṁ = 11.15 kg/s`,
  with `P* = 143.4 kPa`. The solver (20 segments) gives 11.42 kg/s.
- With the exit at 200 kPa (above `P*`), the analytic flow is unchoked:
  `M₁ = 0.493`, exit Mach 0.82, `ṁ = 12.30 kg/s`. The solver gives
  12.61 kg/s.

:::
