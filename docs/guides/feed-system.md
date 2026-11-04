---
title: "Tutorial: build a propellant feed line"
description: Build a pressurized LOX feed line from scratch — tank, line, valve, injector, chamber — with CoolProp oxygen, run it steady, and interpret the results.
---

# Tutorial: build a propellant feed line

This tutorial builds a model from an empty canvas: a pressure-fed liquid-oxygen
line running from a tank, through a feed line and a main valve, to an injector
orifice that discharges against chamber pressure. Oxygen properties come from
CoolProp. You will run the model steady, check the answer by hand, and see
where the pressure goes.

It assumes you have already run the two cases in
[Getting started](getting-started.md). The reference material behind each step
is in manual §1.2 (network definitions), §3 (data structure), and §6
(interface).

## Concepts you need

OpenFLUME represents a system as a directed graph (manual §1.2):

- **Nodes** are control volumes. They hold pressure, temperature, and density,
  and they are where mass and energy are conserved.
  - An **internal** node has unknown P and T that the solver finds.
  - A **boundary** node has P and T _imposed_. It acts as an infinite
    reservoir. Every network needs at least one boundary node, because that
    is what fixes the pressure level of the whole system.
- **Branches** connect two nodes and carry one unknown, the mass flow. The
  branch's **component** sets the momentum relation ΔP(ṁ): pipe friction, a
  valve, an orifice, a pump curve, and so on.
- **Sign convention:** each branch is drawn `from` → `to`. A positive ṁ flows
  in that direction, and a negative ṁ means the fluid runs backward through the
  branch. ΔP ≡ P_from − P_to (manual §1.4).

Spatial resolution is up to you. One pipe branch has one flow rate and no
interior profile. To resolve a gradient along a line, split it into several
segments (manual §3.13, **Split…**). A feed line with a single liquid phase
doesn't need that.

In **steady** mode, an internal node's volume is ignored, and any P and T you
give it serve only as the starting guess. A **transient** run needs a positive
volume on every internal node (manual §3.2).

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

The numbers are illustrative. They describe no particular engine.

**Why the chamber is a boundary node.** This model treats the chamber as a
fixed back-pressure. Its 90 K temperature is only used if flow reverses into
the line. Liquid oxygen cannot actually mix into a hot-gas node, because
OpenFLUME has no general mixing of unlike fluids at a junction. The only
exception is a CEA reacting junction. To model combustion, see the
**LOX/RP-1 thruster** examples and [combustion.md](../combustion.md).

## Step 1: start a new model and choose the fluid

1. Click **New** in the toolbar and type a name into the network-name field,
   for example `LOX feed line`.
2. Set **Units ▾** to **SI**, so the values you type match the table above.
   You can work in any preset. The stored model is always SI (manual §1.3).
3. Open the **Setup** tab.
   - **Solver**: leave **Mode** at **Steady**. The defaults for a new network
     (tolerance 1×10⁻⁶, 200 iterations, relaxation 0.9) are fine.
   - **Fluids**: in the default fluid's card, set the model to **Real fluid
     (CoolProp)**, then search the catalogue for **Oxygen**. Oxygen is one of
     the curated favorites at the top of the list.

**Which fluid model to use.** The fluid catalogue
([fluid-catalogue.md](../fluid-catalogue.md)) lists 124 CoolProp HEOS fluids.
`Oxygen`, `Nitrogen`, `Hydrogen`, `ParaHydrogen`, `Methane`, and `Helium` are
among the nine favorites. RP-1 is **not** in the catalogue: CoolProp has no
RP-1 equation of state. For a hydrocarbon fuel line you can use an
incompressible fluid with custom ρ, μ, and cp. You can also pick a catalogue
hydrocarbon as a surrogate, if you can justify it.

For a first water model, use **Incompressible** with the **Water** preset. It
needs no CoolProp at all.

The CoolProp WebAssembly module (about 6.5 MB) loads the first time you select
a real fluid (manual §4.2). If it fails to start, the status pill shows
**Fluid init failed**.

## Step 2: place the nodes

From the left rail, under **Fluid nodes**:

1. Click **Boundary node**. Select it, and in the **Properties** panel set
   **Label** `LOX tank`, **Pressure** `2000000`, and **Temperature** `90`.
2. Add two **Internal node**s, labelled `Valve inlet` and `Injector manifold`.
   Give them pressure guesses of `1900000` and `1800000` and a temperature of
   `90`. In steady mode these values only seed the Newton iteration, but a
   sensible guess is the best help for a hard real-fluid case (manual §3.2).
3. Add a second **Boundary node** labelled `Chamber`, at `1000000` Pa and
   `90` K.

Drag the nodes into a left-to-right row. Their canvas positions don't affect
the solution.

For a real-fluid node you can switch the **State variable** from
**Temperature** to **Vapour quality**. You don't need that here: at 2 MPa and
90 K, oxygen is a subcooled liquid.

## Step 3: connect the branches

Drag from the tank's connection handle to `Valve inlet`. When you release, the
**Connect with** chooser opens. Pick **Pipe**. The branch is created with
default parameters and selected, so set **Length** `3`, **Diameter** `0.02`,
and **Roughness** `1.5e-6`. Leave **Friction** on **Correlation
(Swamee–Jain)**.

Repeat for the other two branches:

- `Valve inlet` → `Injector manifold`: **Valve**, area `3e-4`, Cd `0.9`,
  position `1` (fully open; position runs from 0 to 1).
- `Injector manifold` → `Chamber`: **Orifice**, area `3e-5`, Cd `0.7`.

There is a faster way to make several connections of one type. Arm the
component in the palette, then click a source node and a target node. The tool
stays armed for the next connection (manual §6.4).

The toolbar status pill should now read **Ready to solve**. If it shows
**N issue(s) to fix** instead, click it: each issue in the list selects the
offending element on the canvas.

### Or load it as text

The same model as a `.fn` file is below. The listing was generated with the
project's own serializer (`serializeText` in
[`src/substrate/textProjection.ts`](../../src/substrate/textProjection.ts)) and
parses back without errors. To use it, either save it as `lox-feed.fn` and
**Load** it, or open **Text view**, replace the contents, and click **Apply**.

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

The format has one record per line. Values are SI. Each record's `data` object
holds every field that isn't already on the record line (manual Appendix C).

## Step 4: run and check

Click **Run**. A single-phase liquid line converges quickly.

**Hand check first.** The injector is far smaller than the line or the valve,
so it should take almost all of the 1 MPa available. The orifice law for a
liquid is ṁ = Cd·A·√(2ρΔP) (manual §4.3.2; the expansibility factor is ≈ 1
for a liquid). CoolProp gives ρ ≈ 1146 kg/m³ for oxygen at 2 MPa and 90 K. If
the injector took the full 1 MPa:

```
ṁ ≤ 0.7 × 3e-5 × √(2 × 1146 × 1.0e6) ≈ 1.005 kg/s
```

The solved flow should come out slightly below this, because the line and the
valve take a small share of the drop. When this page was written, the model
above gave ṁ ≈ 0.996 kg/s with an injector ΔP of about 0.98 MPa. Treat those
figures as a cross-check, not a reference value, and confirm them on your own
run.

You can verify each component the same way:

- **Valve:** ΔP = ṁ² / (2ρ(Cd·A·p)²) (manual §4.3.6). With Cd·A·p =
  2.7×10⁻⁴ m², that comes to a few kPa.
- **Pipe:** Darcy–Weisbach with a Swamee–Jain friction factor (manual
  §4.3.1). At about 2.8 m/s in a 20 mm line, the drop is on the order of
  10 kPa.
- **Mass balance:** all three branches must carry the same ṁ.

## Step 5: interpret the results

- **Per element:** click any branch or node. The **Results** block in the
  **Properties** panel lists every solved quantity for it: ṁ, ΔP, velocity,
  Reynolds number, Mach number, and so on for branches; P, T, density,
  enthalpy, phase, and so on for real-fluid nodes.
- **Where the pressure goes:** on the **Results** tab, set the plot's x axis to
  **Station along path**, then add the node pressures. Off the time axis, each
  channel becomes a point along the network, so this plot is the hydraulic
  grade line: it shows _where_ pressure is lost, not just how much (manual
  §6.8).
- **Findings:** under the plot, OpenFLUME lists deterministic readings of the
  result when it has something to report. Examples are the component that
  dominates the pressure drop, branches running backward, or near-sonic flow.
  Here it should point at the injector.
- **On the diagram:** set **Color by** to **Pressure drop** or **Pressure**.

## Step 6: change something

- **Throttle the valve.** Set the valve position to `0.3` and run again. The
  flow barely changes: the valve's ΔP rises to tens of kPa, which is still
  small next to the injector's. This is how an injector-dominated feed system
  behaves. Run a **Sweep** of the valve position from 0.05 to 1 (manual §6.9)
  to see where the valve starts to take control.
- **Raise tank pressure** to 3 MPa. Flow should rise roughly as
  √(ΔP_injector).
- **Compare runs:** **+ Compare run…** overlays earlier runs on the same
  plot. To keep several designs in one file, use simulation variants (manual
  §6.12).
- **Make it transient.** Set **Mode** to **Transient** in **Setup → Solver**,
  give both internal nodes a positive **Volume**, and drive the tank
  **Pressure Schedule** or the valve `positionSchedule`. Note the limits before
  modeling a fast valve closure. Lumped fluid inertia on pipes captures bulk
  surge. OpenFLUME has **no acoustic wave propagation**, so it cannot predict
  water-hammer wave timing or peak pressure (manual §1.7).

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

- Cavitation is only checked at a `cavitatingVenturi` closure. There is no
  cavitation-inception check on valves, orifices, pumps, or low-pressure liquid
  nodes. If you throttle a liquid line close to saturation, check the local
  pressure against vapor pressure yourself.
- A pump is a pressure-rise-versus-volumetric-flow curve only. There is no
  shaft-work term, so pump heating of the fluid is not captured.
- Two-phase flow uses the homogeneous equilibrium model (HEM). This matters if
  your line flashes or is still chilling down. See the
  [chilldown tutorial](cryogenic-chilldown.md).
