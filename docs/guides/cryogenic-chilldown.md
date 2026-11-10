---
title: "Tutorial: cryogenic line chilldown"
description: The Cryogenic line cooldown example — LH₂ quenching a warm copper line — its physics (HEM, Miropolskii film boiling), what it reproduces, and its limits.
---

# Tutorial: cryogenic line chilldown

The **Cryogenic line cooldown** example is the most demanding of the shipped
models. In one run it combines real-fluid two-phase
flow, a moving quench front, temperature-dependent wall properties, and film
boiling (manual §7.11).

**[Open "Cryogenic line cooldown" in the app →](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown)**

## What it reproduces

The example is built on the configuration of **NBS Report 9264, Figure 2**
(Brennan et al., 1966, _Cooldown of Cryogenic Transfer Lines_), which C&R
Technologies uses as a SINDA/FLUINT validation case. Saturated liquid hydrogen
at 75 psia enters a long copper transfer line that starts at room temperature.
The liquid boils on the hot wall, and the wall chills station by station from
inlet to outlet.

From `sindaFluintCryoLineCooldown` in
[`src/ui/examples.ts`](../../src/ui/examples.ts) and its header comment:

| Item            | Value                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Fluid           | CoolProp `Hydrogen` (normal hydrogen), real-fluid model                                                      |
| Inlet boundary  | 517 kPa (75 psia), quality 0 (saturated liquid, Tsat ≈ 27.3 K)                                               |
| Outlet boundary | 83 kPa (0.82 atm, Boulder CO), 300 K                                                                         |
| Line            | 61 m copper, 15.9 mm ID, 19 mm OD, roughness 1.5 µm                                                          |
| Discretization  | 20 axial segments of 3.05 m: 22 fluid nodes, 20 wall solid nodes, 21 pipe branches, 20 convection conductors |
| Per segment     | fluid volume ≈ 6.05×10⁻⁴ m³, copper wall mass ≈ 2.32 kg, wetted area ≈ 0.152 m²                              |
| Initial state   | walls and internal fluid at 300 K, internal nodes at outlet pressure                                         |
| Wall cp         | catalogue material `ofhc-copper` (NIST cryogenic fit, 4–300 K)                                               |
| Convection      | Miropolskii correlation on every conductor; no fixed h                                                       |
| Time stepping   | fixed dt = 1 s, end time 80 s                                                                                |

Formula bindings tie the geometry together (manual §3.10). Each node volume is
`pipe('segN').volume`, each conductor area is `pipe('segN').surfaceArea`, and
the correlation diameter and flow area come from the same pipe. Segments 2–21
inherit length, diameter, and roughness from segment 1, so editing segment 1
reshapes the whole line consistently.

## The physics

### Two-phase flow: homogeneous equilibrium

Hydrogen in the line passes from subcooled liquid through the saturation dome
to superheated vapor. OpenFLUME treats the two-phase region with the
**homogeneous equilibrium model (HEM)** (manual §4.2): both phases move at the
same velocity and are in thermodynamic equilibrium at the local pressure.

- **State from P and h.** Inside the dome T is fixed by P, so nodes evaluate
  their state from pressure and enthalpy (`statePH`), which fixes quality x.
- **Coupled enthalpy.** The network is solved as an extended `[P, ṁ, h]`
  system with nodal enthalpy as a coupled unknown, which lets a node sit on
  the saturation line for many steps without oscillating across it.
- **Pipe friction** uses the HEM mixture density and the McAdams mixture
  viscosity, 1/μ = x/μ_g + (1−x)/μ_f.

### Wall-to-fluid heat transfer: Miropolskii film boiling

Each wall segment is a lumped solid node (mass × cp(T)) tied to its fluid
node by a convection conductor using the **Miropolskii** dispersed-flow
film-boiling correlation (manual §4.4):

```
Nu = 0.023 · [Re_g · (x + (ρ_g/ρ_f)(1 − x))]^0.8 · Pr_g^0.4 · Y
Y  = 1 − 0.1 · (ρ_f/ρ_g − 1)^0.4 · (1 − x)^0.4
h  = Nu · k_g / D
```

Vapor properties are taken at saturation, and quality is clamped to
[0.01, 0.99] at the edges of the dome. When a node is single-phase, the
correlation falls back to Dittus–Boelter on that state, so one conductor can
follow a segment through the whole chilldown. The mass flux follows the GFSSP
convention: G is half the sum of |ṁ| over the node's attached branches,
divided by the flow area. Manual §8.5 records Miropolskii as "as used by GFSSP
for chilldown", citing Cross, Majumdar et al. (2002).

### Wall thermal mass

Copper's specific heat drops steeply on cooling. The header comment quotes
about 385 J/(kg·K) at 300 K, about 90 at 80 K, and order 1 near 20 K, so each
segment cools faster the colder it gets. The material catalogue and its validity ranges are in
[solid-properties-results.md](../solid-properties-results.md).

The comment also notes that for hydrogen most of the cooling comes from the
sensible heat of the cold vapor, at about 14:1 relative to latent heat.

## Run it and read the results

Click **Run**. This model takes much longer than the other examples because
every step is a real-fluid two-phase solve across 20 coupled segments. The
toolbar shows `t = … s / 80 s` progress; **Cancel** stops the run and keeps
the trajectory, labelled as partial.

1. **Model tab:** set **Color by** to **Temperature** and drag the time
   scrubber. The cold front moves down the line, turning the walls from red to
   blue one segment after another.
2. **Results tab, wall temperatures:** add a plot, type `wall` in the channel
   search box, and pick temperature channels for a few stations, such as walls
   1, 5, 10, 15, and 20. (The **Node & solid temperature** preset plots all 42
   temperatures, which gets busy.)
   Each wall stays warm until the front reaches it, then falls steeply once
   it is cold enough for copper's low heat capacity to take over.
3. **Fluid quality:** the **Quality / front / wetted fractions** preset shows
   each node's vapor quality as the two-phase region moves along the line.
4. **Flow:** the **Branch mass flow** preset shows low flow while the warm
   line boils liquid into vapor, rising as the line chills and liquid reaches
   further downstream.

`src/ui/tests/examples.test.ts` checks the shipped example: every wall ends
below its 300 K start, wall 1 ends below 50 K, and wall 1 drops below 50 K
before wall 20 does. These checks are **qualitative**; they confirm the front
is sequential and the inlet reaches cryogenic temperature.

## Comparison with the experiment

- **The shipped example demonstrates the NBS Figure 2 configuration.** The
  NBS 9264 comparison of chilldown times with the experiment and with GFSSP's
  predictions (manual §8.4) uses a separate, coarser two-phase line model
  (`buildChilldownTwoPhase`) in the slow test tier and the
  [chilldown report](../validation/chilldown-report.md), not this exact
  model.
- **Validation corpus and trust levels** (manual §8.4). Table 6 of the GFSSP
  Version 6 paper (AIAA 2015-3850) tabulates eighteen chilldown times from NBS
  Report 9264 for saturated and subcooled hydrogen and nitrogen, and eleven
  digitized oscillograph figures of the report provide 44 station traces
  (10 195 samples).
  - **Trust comes from the experimental record alone.** Seven runs
    (twenty-eight traces, saturated and subcooled) are **trusted**. Four
    subcooled hydrogen runs are **diagnostic only** because their records are
    compromised (overlapping cold tails, or a valve opened before the chart's
    zero time). Every Table-6 row is solved and reported.
  - **Chilldown-time results** ([report](../validation/chilldown-report.md)).
    Over the eighteen rows at three segments the mean absolute error is
    19.3 % against 7.6 % for GFSSP (10.1 % against 8.7 % over the eleven
    unflagged rows other than subcooled nitrogen); at GFSSP's 30 segments the
    three subset cases that reach the knee are at 13.5 % against 4.6 %.
    Saturated nitrogen at 30 segments is +8.1 % and the hydrogen cases are
    16–17 % early. Subcooled nitrogen depends on the outlet pressure and on
    GFSSP's unpublished exit restriction and is not quoted as a prediction. The knee
    uses one definition for model and data and each run starts from its
    measured initial wall temperature.
  - **CI acceptance band:** computed chilldown time at the instrumented
    station within a factor of 1.6 of experiment, with mean absolute error
    under 25 % across the four-case slow suite. Two-phase chilldown energy and
    enthalpy balances close within 10 % and 12 %.
  - Single-phase chilldown surrogates reproduce the plateau-then-plunge shape
    but are **not** comparable on absolute times.
- **Fluid choice brackets the data.** The example uses normal hydrogen. The
  header comment cites a C&R Technologies validation note (May 2009): normal-H₂
  over-predicts and para-H₂ under-predicts by about 20 %, with the test data in
  between. The validation reports have not re-derived this.
- **"Chilldown time" has no unique definition.** NBS 9264 defines it as the
  low-temperature knee of the wall-temperature curve 60.4 m from the supply
  dewar (quoted in
  [`src/validation/nbsChilldown.ts`](../../src/validation/nbsChilldown.ts)).
  In this model, wall 20 sits at x = 61 m and is the nearest station.

Together these support a factor-of-1.6 engineering band on the nitrogen and
hydrogen rows that converge, short of a precision prediction.

## Things to try

- **Para-hydrogen.** In **Setup → Fluids**, change the fluid to
  `ParaHydrogen` and run again. Use **+ Compare run…** to overlay a wall
  temperature from both runs. Per the C&R note above, the two should bracket
  the experiment.
- **Resolution.** A coarse version cannot resolve the front (manual §7.11),
  and diagnostic-run errors grow at coarse discretization (§8.4). **Repeat…** and **Split…** (manual §3.13) build finer chains; change
  one thing at a time and keep the formula bindings consistent.
- **Longer run.** Raise **End Time** in **Setup → Solver** if the last
  segments haven't chilled by 80 s.
- **Other correlations.** A convection conductor can use **Darr–Hartwig**,
  the 2020 cryogenic flow-boiling set with a regime map over film, nucleate,
  transition, and single-phase boiling. It needs an axial position, derivable
  from physical node positions. Its fitted envelope is LH₂ in vertical upward
  flow at 1 g, which excludes this horizontal line. The **TT-WF** closure is **research status and not validated** (manual §4.4,
  §8.5; [fluid-front-transport.md](../fluid-front-transport.md)).

## Limitations

- **HEM only.** No phase slip, stratification, or flow-regime map for
  horizontal two-phase flow, and no separated-flow pressure-drop multipliers
  such as Lockhart–Martinelli. HEM under-predicts pressure drop at high void
  fraction (manual §1.7).
- **Miropolskii is a film-boiling correlation** with a single-phase fallback;
  it does not model nucleate or transition boiling, or wall rewet.
- **Lumped walls.** Each 3.05 m segment is one temperature, with no axial
  conduction between wall segments and no radial gradient through the wall.
- **No pressure waves.** Surges and oscillations in real chilldown tests
  depend on acoustic and inertial dynamics this model does not resolve (manual
  §1.7).
- **Alpha software.** Treat results as engineering estimates within the
  evidence above. If you find a disagreement with a trusted reference,
  [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues) with the
  reference and tolerance.

## Related

- **LH2 tank no-vent fill** and **Extension: Cryo tank vent control** in the
  [examples gallery](../examples.md) cover cryogenic tanks rather than lines.
- [Coming from GFSSP or SINDA/FLUINT](from-gfssp.md) maps chilldown-model
  concepts between the codes.
