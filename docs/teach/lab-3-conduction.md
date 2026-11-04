---
title: "Lab 3: Conduction and thermal networks"
description: Build solid nodes and conductors in OpenFLUME — composite wall, radiation–convection equilibrium, lumped cooldown, and a conjugate heated pipe.
---

# Lab 3: Conduction and thermal networks

OpenFLUME has a thermal network that runs alongside the fluid network. It is
made of solid nodes (lumped masses), ambient nodes (fixed-temperature
reservoirs), and conductors of three kinds: conduction, convection, and
radiation. In this lab students build four small thermal models, predict each
one by hand, and then check the energy balance of the shipped conjugate
example, **Heated pipe with radiating wall (conjugate HT)**.

Parts A to C reproduce cases 1 to 3 of the
[thermal network validation report](../validation/thermal-network-report.md).

## Learning objectives

By the end of the lab, students should be able to:

1. Build solid and ambient nodes and connect them with conduction,
   convection, and radiation conductors.
2. Solve a composite wall as thermal resistances in series, and predict the
   surface and interface temperatures.
3. Find the nonlinear equilibrium temperature of a body that loses heat by
   both convection and radiation.
4. Integrate a lumped-capacitance cooldown by hand with backward Euler and
   predict the solver's discrete answer exactly.
5. Close the energy balance of a conjugate (solid–fluid) model.
6. Discretize a fin into a conductor ladder and measure the discretization
   error (extension).

## Prerequisites

- Heat transfer: thermal resistance, Newton's law of cooling, radiation
  between a small body and large surroundings, lumped capacitance.
- Lab 1 or the [Getting started](../guides/getting-started.md) page.

## Time

About 45 minutes of pre-lab work and 2 hours in the lab.

## Theory

**Elements** (user manual §3.4–3.6, Appendix B).

| Element      | What it is                                                                                                                 | Key fields                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Solid node   | Lumped mass. In steady state its temperature floats to balance its heat flows. In a transient it also stores `m cp dT/dt`. | **Temperature** (initial value), **Mass**, **cp**, **Heat Input** |
| Ambient node | Fixed-temperature reservoir of unlimited capacity                                                                          | **Temperature**                                                   |
| Conduction   | `Q = (k A / L)(T_from − T_to)`, between two thermal nodes                                                                  | **k**, **Area**, **Length**                                       |
| Convection   | `Q = h A (T_solid − T_fluid)`, between exactly one fluid node and one thermal node                                         | **Area**, **h**                                                   |
| Radiation    | `Q = ε σ A F (T_from⁴ − T_to⁴)`, between two thermal nodes                                                                 | **Emissivity**, **Area**, **View Factor**                         |

`σ = 5.670374419×10⁻⁸ W/(m²·K⁴)` (`src/core/solver/thermal.ts`). A conductor's
heat rate is positive from its `from` end to its `to` end, and a **Heat Input**
is positive into the node (manual §1.4).

**Every model needs a fluid network.** A model must have at least one fluid
node, one boundary node, and one branch (manual §3.1). Convection also needs a
fluid node at one end. For the pure-conduction problems below, use the same
arrangement as the validation report: two fluid boundary nodes at the required
fluid temperatures, joined by a **Flow Source** branch with zero mass flow.
These nodes act as fixed-temperature fluid reservoirs.

**Series resistances.** In steady state the same `Q` passes through every
element of a chain:

```
R_conv = 1/(h A),   R_cond = L/(k A),   Q = (T_hot − T_cold) / ΣR
```

**Radiation–convection equilibrium.** A body with heat input `q`, losing heat
to surroundings at `T∞`, settles where

```
q = h A (T − T∞) + ε σ A F (T⁴ − T∞⁴)
```

This is a quartic in `T`. Solve it with Newton's method, using
`dQ/dT = h A + 4 ε σ A F T³`.

**Lumped capacitance.** `m c dT/dt = −h A (T − T∞)` gives
`T = T∞ + (T₀ − T∞) exp(−t/τ)` with `τ = m c/(h A)`. Backward Euler replaces
this with `T_(n+1) − T∞ = (T_n − T∞) / (1 + Δt/τ)`, so after `n` steps

```
T_n = T∞ + (T₀ − T∞) (1 + Δt/τ)^(−n)
```

The solver applies this formula exactly, so your hand result should match it
to round-off.

## Pre-lab hand calculation

### Part A: Composite wall

A furnace wall of area `A = 1 m²` separates hot gas at 500 K (film coefficient
40 W/(m²·K)) from room air at 300 K (10 W/(m²·K)). It has two layers: brick,
10 cm thick with `k = 1.2 W/(m·K)`, and insulation, 5 cm thick with
`k = 0.05 W/(m·K)`.

1. Compute the four resistances, `ΣR`, and `Q`.
2. Compute the hot-face, interface, and cold-face temperatures.
3. What fraction of the total resistance is the insulation?
4. Predict `Q` if the insulation is doubled to 10 cm.

### Part B: Radiation–convection equilibrium

A small solid with heat input `q` convects to 300 K air (`h = 15 W/(m²·K)`,
`A = 0.05 m²`) and radiates to 300 K surroundings (`ε = 0.8`, `A = 0.05 m²`,
`F = 1`).

1. For `q = 500 W`, estimate `T` assuming convection only. Why is this
   estimate far too high?
2. Solve the quartic with Newton's method for `q = 500 W` and `q = 1000 W`.
   Report `T` and the fraction of `q` that leaves by radiation.

### Part C: Lumped cooldown

A 1 kg solid with `c = 500 J/(kg·K)`, initially at 400 K, cools by convection
(`hA = 10 W/K`) to 300 K fluid.

1. Compute `τ`, `T(50 s)`, and `T(150 s)` from the exact solution.
2. Compute the backward-Euler values at the same times for `Δt = 2 s` and
   `Δt = 0.5 s`.

### Part D: Heated pipe with radiating wall

Read the model description in the
[examples gallery](../examples.md#heated-pipe-with-radiating-wall-conjugate-ht).
Water at 300 K flows from a 200 kPa inlet through two pipes (each `L = 0.5 m`,
`D = 30 mm`) and an outlet orifice (`A = 1×10⁻⁴ m²`, `Cd = 0.6`) to 100 kPa.
Two wall nodes, one per pipe, each receive 5000 W. Each wall convects to its
fluid node with `h = 1000 W/(m²·K)` over the pipe's inner surface `π D L`,
radiates to a 300 K ambient (`ε = 0.8`, `A = 0.5 m²`, `F = 1`), and conducts
to the other wall (`k = 50`, `A = 0.05 m²`, `L = 0.1 m`).

1. Estimate the water mass flow by assuming the orifice takes the whole
   100 kPa: `ṁ = Cd A sqrt(2 ρ ΔP)`.
2. If all 10 kW went into the water, what would the outlet temperature rise
   be? (Water preset: `cp = 4182 J/(kg·K)`.)
3. Estimate the wall temperature by ignoring radiation and wall conduction:
   `T_w ≈ T_fluid + 5000/(h A)`. Then estimate how much the walls radiate at
   that temperature, and correct your estimate once.

## Procedure in OpenFLUME

Set **Units ▾** to **SI**. The left rail places **Boundary node**, **Solid
node**, and **Ambient node**. Connections are made by dragging from one node's
handle to another and choosing from **Connect with**. Conductors are listed
under **Thermal ties**. The canvas rejects illegal connections with a red
banner. For example, convection must have exactly one fluid end (manual §6.4).

### Part A: Composite wall

1. Click **New**. A new model is steady-state incompressible water, which is
   what this part needs.
2. Place two **Boundary node**s. Label them `Hot gas` and `Cold air`, set both
   **Pressure** values to 101325 Pa, and set **Temperature** to 500 K and 300 K.
3. Connect `Hot gas` to `Cold air` and choose **Flow Source**. Set its
   **Mass Flow** to 0.
4. Place three **Solid node**s: `Hot face`, `Interface`, `Cold face`. In
   steady state they need no mass or `cp`. Their **Temperature** is only a
   starting guess.
5. Make the chain:
   - `Hot gas` → `Hot face`: **Convection**, **h** 40, **Area** 1.
   - `Hot face` → `Interface`: **Conduction**, **k** 1.2, **Area** 1,
     **Length** 0.1.
   - `Interface` → `Cold face`: **Conduction**, **k** 0.05, **Area** 1,
     **Length** 0.05.
   - `Cold face` → `Cold air`: **Convection**, **h** 10, **Area** 1.
6. Click **Run**. Click each solid node to read its temperature, and each
   conductor to read its heat rate. Every conductor should carry the same
   `Q`.
7. Change the insulation **Length** to 0.1 and run again.

If you are short of time, or want to check your build, click **New**, open
**Text view**, paste the model below, and click **Apply**:

```
// Fluid Network config v2
network "Lab 3 composite wall" {
settings: {"mode":"steady","tolerance":0.000001,"maxIterations":200,"relaxation":0.9}
fluid: {"model":"incompressible","preset":"water"}
node "hot" boundary @ (0, 0) data: {"pressure":101325,"temperature":500,"label":"Hot gas"}
node "cold" boundary @ (600, 0) data: {"pressure":101325,"temperature":300,"label":"Cold air"}
solid "s1" solid @ (150, 150) data: {"temperature":450,"label":"Hot face"}
solid "s2" solid @ (300, 150) data: {"temperature":400,"label":"Interface"}
solid "s3" solid @ (450, 150) data: {"temperature":320,"label":"Cold face"}
branch "hold": "hot" -> "cold" flowSource data: {"label":"Zero flow","massFlow":0}
conductor "h1": "hot" -> "s1" convection data: {"label":"Hot film","h":40,"area":1}
conductor "kA": "s1" -> "s2" conduction data: {"label":"Brick","k":1.2,"area":1,"length":0.1}
conductor "kB": "s2" -> "s3" conduction data: {"label":"Insulation","k":0.05,"area":1,"length":0.05}
conductor "h2": "s3" -> "cold" convection data: {"label":"Cold film","h":10,"area":1}
}
```

### Part B: Radiation–convection equilibrium

1. Starting from the Part A model, delete the three solid nodes. Their
   conductors are deleted with them, or you can delete the conductors
   yourself. Set `Hot gas` to 300 K.
2. Place one **Solid node** with **Heat Input** 500 W, and one **Ambient
   node** with **Temperature** 300 K.
3. Connect the solid node to `Hot gas` with **Convection** (**h** 15, **Area**
   0.05), and to the ambient node with **Radiation** (**Emissivity** 0.8,
   **Area** 0.05, **View Factor** 1).
4. Run, and record the solid temperature and both heat rates. Repeat with
   **Heat Input** 1000 W.

### Part C: Lumped cooldown

1. Starting from Part B, delete the radiation conductor and set the solid's
   **Heat Input** to 0. Set the solid's **Temperature** to 400 K, **Mass** to
   1 kg, and **cp** to 500 J/(kg·K). Set the convection **h** to 10 and
   **Area** to 1.
2. In **Setup** → **Solver**, set **Mode** to Transient, choose **Fixed dt**,
   and set **Time Step** to 2 s and **End Time** to 150 s.
3. Run. In the **Results** tab, plot the solid temperature against **Time**
   (the **Node & solid temperature** set includes it). Read `T` at 50 s and
   150 s.
4. Change **Time Step** to 0.5 s and run again. Overlay the two runs with
   **+ Compare run…**.

### Part D: Heated pipe with radiating wall

1. Open the example:
   **[Heated pipe with radiating wall (conjugate HT)](https://openflume.github.io/OpenFLUME/#example=heated-pipe-with-radiating-wall-conjugate-ht)**.
   Opening it replaces your model, so **Save** Part C first if you want to
   keep it.
2. Check the parameters in the property panel. Click **Conv w1-f1**: its
   **Area** is a formula, `pipe('b_in').surfaceArea`. Use the **f(x)** preview
   to read the value.
3. Click **Run**.
4. Record the mass flow in the outlet orifice; the temperatures of **Wall 1**,
   **Wall 2**, **Fluid 1**, and **Fluid 2**; and the heat rates of all five
   conductors.
5. Set **Color by** to **Temperature** and look at where the temperature
   differences are.
6. Close the energy balance. Compare the 10 kW input with the heat convected
   to the water plus the heat radiated. Then compare the convected heat with
   `ṁ cp (T_Fluid2 − T_inlet)`.

## Questions

1. Part A: which layer controls the heat loss? Where would you add
   insulation, and where would a better hot-side film coefficient matter?
2. Part B: why is the convection-only estimate so far off at 500 W? At what
   heat input does radiation carry about half the load?
3. Part C: your backward-Euler hand calculation and the solver should agree to
   round-off. Why is that a stronger check than agreement with the exact
   exponential?
4. Part C: the error at 150 s fell by a factor of about 4 when the step fell by
   a factor of 4. What order of accuracy does that imply?
5. Part D: heat flows between the two walls through **Cond w1-w2**. In which
   direction, and why? (Hint: compare the fluid temperatures next to each
   wall.)
6. Part D: about 8 % of the heat is radiated rather than carried by the water.
   Which single parameter would you change to raise that fraction, and by
   roughly how much would the wall temperature have to rise to double it?
7. In Part D the water warms by only about 2.6 K, yet the walls run about 100 K
   above the water. What does that tell you about where the thermal
   resistance is?

## Extensions

- **Fin.** Model a pin fin as a ladder of solid nodes: aluminium-like
  `k = 200 W/(m·K)`, `D = 10 mm`, `L = 100 mm`, base held at 400 K (an
  ambient node), convection `h = 20 W/(m²·K)` to 300 K fluid, adiabatic tip.
  Use `N` equal cells with a solid node at each cell centre. The base
  conductor has length `Δx/2`, the cell-to-cell conductors have length `Δx`,
  each cell has a convection conductor of area `π D Δx` to a fluid boundary
  node, and nothing is attached to the tip. Compare the base heat rate for
  `N = 2, 5, 10` with the analytic fin result `Q = sqrt(h P k A_c) θ_b tanh(mL)`.
  The **Repeat…** selection action (manual §3.13) can chain a unit cell, or
  you can place five cells by hand.
- **Sweep.** In Part B, use the **Sweep** tab with the solid node's
  **Heat Input** as the target, from 100 to 4000 W. Compare with Figure 4 of
  the validation report.
- **Heat exchanger.** Open the **Water-water counterflow heat exchanger**
  example. Section 7.9 of the user manual and case 5 of the validation report
  show that segment count controls accuracy (first order in 1/N).

::: details Answer key

Hand values were computed in Python from the formulas above, including a
Newton solve of the quartic and a direct solve of the four-unknown Part D
energy balance and of the fin ladder. Solver values are OpenFLUME 0.3.1, run
locally on the models described here. In every part, hand and solver agree to
at least six significant figures. Parts A to C also match the validation
report.

**Part A**

- Resistances (K/W): hot film 0.0250, brick 0.0833, insulation 1.0000,
  cold film 0.1000. `ΣR = 1.2083 K/W`, so `Q = 165.52 W`.
- Hot face 495.86 K, interface 482.07 K, cold face 316.55 K (report case 1).
- Insulation share: 82.8 %.
- Insulation doubled: `ΣR = 2.2083 K/W`, so `Q = 90.57 W`. The solver gives
  hot face 497.74 K, interface 490.19 K, cold face 309.06 K.

**Part B**

| q [W] | Convection-only T [K] | T_eq [K] | Convection [W] | Radiation [W] | Radiated share |
| ----- | --------------------- | -------- | -------------- | ------------- | -------------- |
| 500   | 966.7                 | 599.79   | 224.84         | 275.16        | 55 %           |
| 1000  | 1633.3                | 741.85   | 331.39         | 668.61        | 67 %           |

The report (case 2) gives 599.786 K and 741.854 K. The convection-only
estimate ignores a loss that grows as `T⁴`. At 967 K radiation alone would
remove about 1960 W, four times the input. Radiation and convection carry
equal shares at `q ≈ 370 W` (`T ≈ 548 K`). The report's sweep runs from 33 %
radiated at 100 W to 85 % at 4000 W.
A simple fixed-point iteration using a linearized radiation coefficient
oscillates about the root. Newton's method converges in a few steps.

**Part C**

`τ = m c/(hA) = 50 s`. Exact: `T(50) = 336.788 K`, `T(150) = 304.979 K`.

| Δt [s] | T(50 s) backward Euler [K] | T(150 s) backward Euler [K] | Error at 150 s [K] |
| ------ | -------------------------- | --------------------------- | ------------------ |
| 2      | 337.512                    | 305.278                     | 0.300              |
| 0.5    | 336.971                    | 305.053                     | 0.0747             |

The solver reproduces these backward-Euler values to round-off. The ratio
0.300/0.0747 = 4.01 for a 4× step reduction (report case 3) is first-order
accuracy.

**Part D** (solver; a hand Newton solve of the same equations gives identical
values)

- Orifice-only estimate: `ṁ = 0.6e-4 × sqrt(2 × 998 × 10⁵) = 0.8477 kg/s`.
  The solved flow is 0.8453 kg/s. The two pipes take 0.28 kPa each, and the
  orifice takes the remaining 99.44 kPa.
- All heat into the water: `ΔT = 10 000 / (0.8453 × 4182) = 2.83 K`.
- `h A = 1000 × π × 0.03 × 0.5 = 47.12 W/K`. With no radiation,
  `T_w ≈ 300 + 5000/47.12 = 406 K`. At 406 K each wall would radiate about
  0.43 kW, so the convective load falls to about 4.57 kW and `T_w` falls to
  about 397–398 K, close to the solved 399 K.

| Quantity                | Value                                       |
| ----------------------- | ------------------------------------------- |
| Wall 1 / Wall 2         | 399.38 K / 399.97 K                         |
| Fluid 1 / Fluid 2       | 301.307 K / 302.605 K                       |
| Conv w1-f1 / Conv w2-f2 | 4621.5 W / 4588.4 W                         |
| Rad w1-amb / Rad w2-amb | 393.3 W / 396.8 W                           |
| Cond w1-w2              | −14.86 W (heat flows from Wall 2 to Wall 1) |

- Balance: 9209.9 W convected + 790.1 W radiated = 10 000.0 W.
  Water: `0.84530 × 4182 × (302.605 − 300) = 9209.9 W`.
- Q5: Fluid 2 is 1.3 K warmer than Fluid 1, so Wall 2 must run slightly hotter
  to push its heat into the water, and a little heat conducts back to Wall 1.
- Q6: Raise emissivity or radiating area. Radiation is proportional to
  `T⁴ − 300⁴`. Doubling it from about 395 W per wall needs `T_w ≈ 455 K`,
  a rise of about 55 K, unless `εA` is doubled instead.
- Q7: The water's capacity rate `ṁ cp ≈ 3535 W/K` is much larger than the wall
  film conductance `hA ≈ 47 W/K`. Almost all of the temperature difference is
  across the convective film.

**Fin extension** (`m = sqrt(hP/(kA_c)) = 6.325 m⁻¹`, `mL = 0.632`)

Analytic: `Q = 5.561 W`, tip temperature 382.87 K, fin efficiency 0.885.

| N   | Q base [W] | Error   |
| --- | ---------- | ------- |
| 2   | 5.475      | −1.5 %  |
| 5   | 5.547      | −0.25 % |
| 10  | 5.557      | −0.06 % |
| 20  | 5.560      | −0.02 % |

The error falls about fourfold when N doubles. This cell-centred ladder is
second order in `Δx`. OpenFLUME 0.3.1 gives the same values to five
significant figures as the hand solve of the ladder equations.

:::
