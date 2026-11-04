---
title: "Tutorial: cryogenic line chilldown"
description: The Cryogenic line cooldown example — LH₂ quenching a warm copper line — its physics (HEM, Miropolskii film boiling), what it reproduces, and its limits.
---

# Tutorial: cryogenic line chilldown

This tutorial covers the **Cryogenic line cooldown** example, the most
demanding of the shipped models. In one run it combines real-fluid two-phase
flow, a moving quench front, temperature-dependent wall properties, and film
boiling (manual §7.11).

**[Open "Cryogenic line cooldown" in the app →](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown)**

## What it reproduces

The example is built on the configuration of **NBS Report 9264, Figure 2**
(Brennan et al., 1966, _Cooldown of Cryogenic Transfer Lines_), which C&R
Technologies uses as a SINDA/FLUINT validation case. Saturated liquid hydrogen
at 75 psia is admitted to a long copper transfer line that starts at room
temperature. The cold liquid boils on the hot wall, and the wall chills
station by station from the inlet to the outlet.

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
`pipe('segN').volume`. Each conductor area is `pipe('segN').surfaceArea`. The
correlation diameter and flow area come from the same pipe. Segments 2–21
inherit length, diameter, and roughness from segment 1. As a result, editing
segment 1 reshapes the whole line consistently.

## The physics

### Two-phase flow: homogeneous equilibrium

Hydrogen in the line goes from subcooled liquid, through the saturation dome,
to superheated vapor. OpenFLUME treats the two-phase region with the
**homogeneous equilibrium model (HEM)** (manual §4.2): both phases move at the
same velocity and are in thermodynamic equilibrium at the local pressure.

- **State from P and h.** Inside the dome, T no longer varies independently,
  so nodes evaluate their state from pressure and enthalpy (`statePH`).
  Enthalpy fixes the quality x.
- **Coupled enthalpy.** The network is solved as an extended `[P, ṁ, h]`
  system, with nodal enthalpy as a coupled unknown. This is what lets a node
  sit on the saturation line for many steps without oscillating across it.
- **Pipe friction** uses the HEM mixture density and the McAdams mixture
  viscosity, 1/μ = x/μ_g + (1−x)/μ_f.

### Wall-to-fluid heat transfer: Miropolskii film boiling

Each wall segment is a lumped solid node (mass × cp(T)) tied to its fluid
node by a convection conductor that uses the **Miropolskii** dispersed-flow
film-boiling correlation (manual §4.4):

```
Nu = 0.023 · [Re_g · (x + (ρ_g/ρ_f)(1 − x))]^0.8 · Pr_g^0.4 · Y
Y  = 1 − 0.1 · (ρ_f/ρ_g − 1)^0.4 · (1 − x)^0.4
h  = Nu · k_g / D
```

Vapor properties are taken at saturation. Quality is clamped to [0.01, 0.99]
at the edges of the dome. When a node is single-phase, the correlation falls
back to Dittus–Boelter on that state, which is why one conductor can follow a
segment all the way through chilldown. The mass flux follows the GFSSP
convention: G is half the sum of |ṁ| over the node's attached branches,
divided by the flow area. Manual §8.5 records Miropolskii as "as used by GFSSP
for chilldown", citing Cross, Majumdar et al. (2002).

### Wall thermal mass

Copper's specific heat drops steeply on cooling. The header comment quotes
about 385 J/(kg·K) at 300 K, about 90 at 80 K, and order 1 near 20 K. Each
segment therefore cools faster the colder it gets. According to the same
comment, a constant 385 J/(kg·K) "materially over-predicts the cold-end
cooldown time". The material catalogue and its validity ranges are documented
in [solid-properties-results.md](../solid-properties-results.md).

The comment also notes that for hydrogen, most of the cooling comes from
the sensible heat of the cold vapor rather than from latent heat. It quotes a
ratio of about 14:1.

## Run it and read the results

Click **Run**. This model takes much longer than the other examples: every
step is a real-fluid two-phase solve across 20 coupled segments. The toolbar
shows `t = … s / 80 s` as it goes. **Cancel** stops the run and keeps the
partial trajectory, labelled as partial.

Then:

1. **Model tab:** set **Color by** to **Temperature** and drag the time
   scrubber. The cold front moves down the line, with the walls going from
   red to blue one segment after another.
2. **Results tab, wall temperatures:** add a plot and type `wall` in the
   channel search box. Pick the temperature channels for a handful of
   stations, for example walls 1, 5, 10, 15, and 20. (The **Node & solid
   temperature** preset plots all 42 temperatures at once, which gets busy.)
   Each wall stays warm until the front reaches it and then falls steeply. The
   steep drop happens once the wall gets cold enough for copper's low heat
   capacity to take over.
3. **Fluid quality:** the **Quality / front / wetted fractions** preset shows
   each node's vapor quality as the two-phase region moves along the line.
4. **Flow:** the **Branch mass flow** preset shows the flow is low while the
   warm line is boiling liquid into vapor, then rises as the line chills and
   liquid reaches further downstream.

The shipped example is checked by `src/ui/tests/examples.test.ts`. That test
asserts that every wall ends below its 300 K start, that wall 1 ends below
50 K, and that wall 1 drops below 50 K before wall 20 does. These checks are
**qualitative**: they confirm the front is sequential and that the inlet
reaches cryogenic temperature.

## What is, and is not, claimed against the experiment

Read this section before quoting a number from this example.

- **The shipped example is a demonstration of the NBS Figure 2
  configuration.** Its own regression test is qualitative (see above). The
  manual (§7.11) says chilldown time at the instrumented station "is compared
  with the NBS experiment and with GFSSP predictions in the validation suite".
  That comparison runs in the slow test tier on the repository's chilldown
  builders, not as a pass/fail on this exact model.
- **Validation corpus and trust levels** (manual §8.4). The data come from NBS
  Report 9264. Table 6 provides eighteen chilldown-time points for saturated
  and subcooled hydrogen and nitrogen, and eleven digitized oscillograph
  figures provide 44 station traces (10 195 samples).
  - **Trusted (calibration grade):** four saturated runs, sixteen traces.
  - **Diagnostic only:** seven subcooled runs. At coarse axial discretization
    their errors reach +80 %, so they may inform a diagnosis but may not be
    quoted as agreement.
  - **CI acceptance band:** computed chilldown time at the instrumented
    station within a factor of 1.6 of experiment, with mean absolute error
    under 25 % across the four-case slow suite. Two-phase chilldown energy and
    enthalpy balances close within 10 % and 12 %.
  - Single-phase chilldown surrogates reproduce the plateau-then-plunge shape
    but are **not** comparable on absolute times.
- **Fluid choice brackets the data.** The example uses normal hydrogen. The
  header comment cites a C&R Technologies validation note (May 2009): normal-H₂
  over-predicts and para-H₂ under-predicts by about 20 %, with the test data in
  between. This comes from the source comment and has not been re-derived in
  the validation reports.
- **"Chilldown time" has no unique definition.** NBS 9264 defines it as the
  low-temperature knee of the wall-temperature curve 60.4 m from the supply
  dewar (quoted in
  [`src/validation/nbsChilldown.ts`](../../src/validation/nbsChilldown.ts)).
  In this model, wall 20 sits at x = 61 m and is the nearest station.

Together, these establish a factor-of-1.6 engineering band on trusted
saturated runs. They do not establish a precision prediction.

## Things to try

- **Para-hydrogen.** In **Setup → Fluids**, change the fluid to
  `ParaHydrogen` and run again. Use **+ Compare run…** to overlay a wall
  temperature from both runs. According to the C&R note above, the two runs
  should bracket the experiment.
- **Resolution.** A coarse version cannot resolve the front at all (manual
  §7.11), and errors on the diagnostic runs grow at coarse discretization
  (§8.4). **Repeat…** and **Split…** (manual §3.13) build finer chains. Change
  one thing at a time, and keep the formula bindings consistent.
- **Longer run.** Raise **End Time** in **Setup → Solver** if the last
  segments have not finished chilling by 80 s on your run.
- **Other correlations.** A convection conductor can use **Darr–Hartwig**,
  the 2020 cryogenic flow-boiling set with a regime map over film, nucleate,
  transition, and single-phase boiling. It needs an axial position, which can
  be derived from physical node positions. Its fitted envelope is LH₂ in
  vertical upward flow at 1 g, so this horizontal line lies outside it. The
  **TT-WF** closure is **research status and not validated** (manual §4.4,
  §8.5; [fluid-front-transport.md](../fluid-front-transport.md)).

## Limitations

- **HEM only.** There is no phase slip, no stratification, and no flow-regime
  map for horizontal two-phase flow. Separated-flow pressure-drop multipliers
  such as Lockhart–Martinelli are not implemented. HEM under-predicts pressure
  drop at high void fraction (manual §1.7).
- **Miropolskii is a film-boiling correlation** with a single-phase fallback.
  It does not model nucleate or transition boiling, or rewet of the wall.
- **Lumped walls.** Each 3.05 m segment is one temperature. This example has
  no axial conduction between wall segments and no radial gradient through the
  wall.
- **No pressure waves.** The surges and oscillations seen in real chilldown
  tests depend on acoustic and inertial dynamics, which this model does not
  resolve (manual §1.7).
- **Alpha software.** Treat results as engineering estimates within the
  evidence above. If you find a disagreement with a reference you trust,
  please [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues) with
  the reference and tolerance.

## Related

- **LH2 tank no-vent fill** and **Extension: Cryo tank vent control** in the
  [examples gallery](../examples.md) cover cryogenic tanks rather than lines.
- [Coming from GFSSP or SINDA/FLUINT](from-gfssp.md) maps chilldown-model
  concepts between the codes.
