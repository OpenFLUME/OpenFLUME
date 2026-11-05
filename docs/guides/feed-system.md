---
title: "Tutorial: build a propellant feed line"
description: Build a pressurized LOX feed line from scratch — tank, line, valve, injector, chamber — with CoolProp oxygen, run it steady, and interpret the results.
---

# Tutorial: build a propellant feed line

Build a pressure-fed liquid-oxygen line from an empty canvas (tank, feed line,
main valve, and injector orifice discharging against chamber pressure) with
CoolProp oxygen, run it steady, check it by hand, and see where the pressure
goes. Run the two cases in [Getting started](getting-started.md) first.
Reference material is in manual §1.2 (network definitions), §3 (data
structure), and §6 (interface).

## Concepts you need

OpenFLUME represents a system as a directed graph (manual §1.2):

- **Nodes** are control volumes holding pressure, temperature, and density;
  mass and energy are conserved there.
  - An **internal** node has unknown P and T that the solver finds.
  - A **boundary** node has P and T _imposed_ and acts as an infinite
    reservoir. Every network needs at least one, because it fixes the pressure
    level of the whole system.
- **Branches** connect two nodes and carry one unknown, the mass flow. The
  **component** sets the momentum relation ΔP(ṁ): pipe friction, valve,
  orifice, pump curve, and so on.
- **Sign convention:** each branch is drawn `from` → `to`. Positive ṁ flows in
  that direction; negative ṁ runs backward. ΔP ≡ P_from − P_to (manual §1.4).

Spatial resolution is up to you. One pipe branch has one flow rate and no
interior profile; to resolve a gradient along a line, split it into segments
(manual §3.13, **Split…**). A single-phase liquid feed line doesn't need that.

In **steady** mode an internal node's volume is ignored and its P and T serve
only as the starting guess. A **transient** run needs a positive volume on
every internal node (manual §3.2).

## The system

```
LOX tank ──pipe──▶ valve inlet ──valve──▶ injector manifold ──orifice──▶ chamber
(boundary)        (internal)              (internal)                    (boundary)
 2.0 MPa, 90 K                                                           1.0 MPa
```

| Element                  | Kind          | Parameters (SI)                                   |
| ------------------------ | ------------- | ------------------------------------------------- |
| `tank` — LOX tank        | boundary node | P = 2 000 000 Pa, T = 90 K                        |
| `n1` — Valve inlet       | internal node | initial guess P = 1 900 000 Pa, T = 90 K          |
| `n2` — Injector manifold | internal node | initial guess P = 1 800 000 Pa, T = 90 K          |
| `chamber`                | boundary node | P = 1 000 000 Pa, T = 90 K                        |
| `line` — Feed line       | `pipe`        | length 3 m, diameter 0.02 m, roughness 1.5×10⁻⁶ m |
| `valve` — Main valve     | `valve`       | area 3×10⁻⁴ m², Cd = 0.9, position 1              |
| `inj` — Injector         | `orifice`     | area 3×10⁻⁵ m², Cd = 0.7                          |

The numbers are illustrative and describe no particular engine.

**Why the chamber is a boundary node.** The chamber is a fixed back-pressure;
its 90 K temperature is used only if flow reverses into the line. Liquid oxygen
cannot mix into a hot-gas node, because OpenFLUME has no general mixing of
unlike fluids at a junction other than a CEA reacting junction. For
combustion, see the **LOX/RP-1 thruster** examples and [combustion.md](../combustion.md).

## Step 1: start a new model and choose the fluid

1. Click **New** and type a name into the network-name field, such as
   `LOX feed line`.
2. Set **Units ▾** to **SI** so the values you type match the table above.
   Any preset works; the stored model is always SI (manual §1.3).
3. Open the **Setup** tab.
   - **Solver**: leave **Mode** at **Steady** with the defaults (tolerance
     1×10⁻⁶, 200 iterations, relaxation 0.9).
   - **Fluids**: in the default fluid's card, set the model to **Real fluid
     (CoolProp)**, then search the catalogue for **Oxygen**, one of the
     curated favorites at the top of the list.

**Which fluid model to use.** The
[fluid catalogue](../fluid-catalogue.md) lists 124 CoolProp HEOS fluids.
`Oxygen`, `Nitrogen`, `Hydrogen`, `ParaHydrogen`, `Methane`, and `Helium` are
among the nine favorites. RP-1 is **not** in the catalogue: CoolProp has no
RP-1 equation of state. For a hydrocarbon fuel line, use an incompressible
fluid with custom ρ, μ, and cp, or a catalogue hydrocarbon as a surrogate if
you can justify it.

For a first water model, use **Incompressible** with the **Water** preset,
which needs no CoolProp.

The CoolProp WebAssembly module (about 6.5 MB) loads the first time you select
a real fluid (manual §4.2). If it fails to start, the status pill shows
**Fluid init failed**.

## Step 2: place the nodes

From the left rail, under **Fluid nodes**:

1. Click **Boundary node**, select it, and in the **Properties** panel set
   **Label** `LOX tank`, **Pressure** `2000000`, and **Temperature** `90`.
2. Add two **Internal node**s, `Valve inlet` and `Injector manifold`, with
   pressure guesses `1900000` and `1800000` and temperature `90`. These only
   seed the Newton iteration, but a sensible guess is the best help for a hard
   real-fluid case (manual §3.2).
3. Add a second **Boundary node** labelled `Chamber`, at `1000000` Pa and
   `90` K.

Drag the nodes into a left-to-right row; canvas positions don't affect the
solution.

A real-fluid node's **State variable** can be switched from **Temperature** to
**Vapour quality**. That isn't needed here: at 2 MPa and 90 K, oxygen is a
subcooled liquid.

## Step 3: connect the branches

Drag from the tank's connection handle to `Valve inlet`. On release, the
**Connect with** chooser opens; pick **Pipe**. The new branch is selected with
default parameters; set **Length** `3`, **Diameter** `0.02`, and **Roughness**
`1.5e-6`, and leave **Friction** on **Correlation (Swamee–Jain)**.

Repeat for the other two branches:

- `Valve inlet` → `Injector manifold`: **Valve**, area `3e-4`, Cd `0.9`,
  position `1` (fully open; position runs from 0 to 1).
- `Injector manifold` → `Chamber`: **Orifice**, area `3e-5`, Cd `0.7`.

To make several connections of one type, arm the component in the palette,
then click a source node and a target node. The tool stays armed for the next
connection (manual §6.4).

The status pill should now read **Ready to solve**. If it shows **N issue(s)
to fix**, click it; each listed issue selects the offending element.

### Or load it as text

The same model as a `.fn` file, generated with the project's serializer
(`serializeText` in
[`src/substrate/textProjection.ts`](../../src/substrate/textProjection.ts)),
parses back without errors. Save it as `lox-feed.fn` and **Load** it, or open
**Text view**, replace the contents, and click **Apply**.

```
// Fluid Network config v2
network "LOX feed line" {
settings: {"mode":"steady","tolerance":0.000001,"maxIterations":200,"relaxation":0.9}
fluid: {"model":"realFluid","params":{"fluidName":"Oxygen"}}
node "tank" boundary @ (0, 0) data: {"pressure":2000000,"temperature":90,"label":"LOX tank"}
node "n1" internal @ (200, 0) data: {"pressure":1900000,"temperature":90,"label":"Valve inlet"}
node "n2" internal @ (400, 0) data: {"pressure":1800000,"temperature":90,"label":"Injector manifold"}
node "chamber" boundary @ (600, 0) data: {"pressure":1000000,"temperature":90,"label":"Chamber"}
branch "line": "tank" -> "n1" pipe data: {"label":"Feed line","length":3,"diameter":0.02,"roughness":0.0000015}
branch "valve": "n1" -> "n2" valve data: {"label":"Main valve","area":0.0003,"cd":0.9,"position":1}
branch "inj": "n2" -> "chamber" orifice data: {"label":"Injector","area":0.00003,"cd":0.7}
}
```

The format has one record per line, in SI. Each record's `data` object holds
every field that isn't already on the record line (manual Appendix C).

## Step 4: run and check

Click **Run**. A single-phase liquid line converges quickly.

**Hand check.** The injector is far smaller than the line or the valve, so it
should take almost all of the 1 MPa available. The liquid orifice law is
ṁ = Cd·A·√(2ρΔP) (manual §4.3.2; the expansibility factor is ≈ 1
for a liquid). CoolProp gives ρ ≈ 1146 kg/m³ for oxygen at 2 MPa and 90 K. If
the injector took the full 1 MPa:

```
ṁ ≤ 0.7 × 3e-5 × √(2 × 1146 × 1.0e6) ≈ 1.005 kg/s
```

The solved flow should come out slightly below this, because the line and the
valve take a small share of the drop. When this tutorial was written, the model
gave ṁ ≈ 0.996 kg/s with an injector ΔP of about 0.98 MPa; use those as a
cross-check and confirm them on your own run.

Verify each component the same way:

- **Valve:** ΔP = ṁ² / (2ρ(Cd·A·p)²) (manual §4.3.6). With Cd·A·p =
  2.7×10⁻⁴ m², that comes to a few kPa.
- **Pipe:** Darcy–Weisbach with a Swamee–Jain friction factor (manual
  §4.3.1). At about 2.8 m/s in a 20 mm line, the drop is on the order of
  10 kPa.
- **Mass balance:** all three branches must carry the same ṁ.

## Step 5: interpret the results

- **Per element:** click any branch or node. The **Results** block in the
  **Properties** panel lists every solved quantity: ṁ, ΔP, velocity, Reynolds
  and Mach numbers, etc. for branches; P, T, density, enthalpy, phase, etc. for
  real-fluid nodes.
- **Where the pressure goes:** on the **Results** tab, set the plot's x axis to
  **Station along path**, then add the node pressures. Off the time axis, each
  channel becomes a point along the network, so the plot is the hydraulic grade
  line and shows _where_ pressure is lost (manual §6.8).
- **Findings:** under the plot, OpenFLUME lists deterministic readings of the
  result when there is something to report, such as the component dominating
  the pressure drop, branches running backward, or near-sonic flow. Here it
  should point at the injector.
- **On the diagram:** set **Color by** to **Pressure drop** or **Pressure**.

## Step 6: change something

- **Throttle the valve.** Set the valve position to `0.3` and rerun. Flow
  barely changes: the valve's ΔP rises to tens of kPa, still small next to the
  injector's, as expected in an injector-dominated feed system. **Sweep** the
  position from 0.05 to 1 (manual §6.9) to see where the valve takes control.
- **Raise tank pressure** to 3 MPa. Flow should rise roughly as
  √(ΔP_injector).
- **Compare runs:** **+ Compare run…** overlays earlier runs on one plot.
  Simulation variants keep several designs in one file (manual §6.12).
- **Make it transient.** Set **Mode** to **Transient** in **Setup → Solver**,
  give both internal nodes a positive **Volume**, and drive the tank
  **Pressure Schedule** or the valve `positionSchedule`. For a fast valve
  closure, lumped fluid inertia on pipes captures bulk surge, but OpenFLUME has
  **no acoustic wave propagation**, so it cannot predict water-hammer wave
  timing or peak pressure (manual §1.7).

## Same model from Python

The `.fn` file you saved runs unchanged from the Python package
([python.md](../python.md)):

```python
import openflume as of

net = of.load("lox-feed.fn")
assert net.validate() == []
res = net.solve()
print(res.converged, res.branch("inj")["mdot"])        # kg/s
print(res.nodes_frame())                              # pandas, if installed

net.branch("valve")["component"]["position"] = 0.3     # edit and re-solve
print(net.solve().branch("inj")["mdot"])
```

## Scope notes for feed systems

- Cavitation is checked only at a `cavitatingVenturi` closure, not on valves,
  orifices, pumps, or low-pressure liquid nodes. If you throttle a liquid line
  close to saturation, check local pressure against vapor pressure yourself.
- A pump is a pressure-rise-versus-volumetric-flow curve only, with no
  shaft-work term, so pump heating of the fluid is not captured.
- Two-phase flow uses the homogeneous equilibrium model (HEM), which matters if
  your line flashes or is still chilling down; see the
  [chilldown tutorial](cryogenic-chilldown.md).
