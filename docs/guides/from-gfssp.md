---
title: Coming from GFSSP or SINDA/FLUINT
description: How GFSSP and SINDA/FLUINT concepts map onto OpenFLUME, what is the same, what differs, what is missing, and how to rebuild an existing model.
---

# Coming from GFSSP or SINDA/FLUINT

OpenFLUME solves the same class of problem as NASA's GFSSP and C&R
Technologies' SINDA/FLUINT: networks of control volumes joined by flow
elements, thermally coupled to lumped solid structure. If you have built
models in either code, most of what you know carries over. This page maps the
concepts, then lists the differences and gaps you should know about before
you rely on a result.

Some facts on this page are about the other codes rather than OpenFLUME. They
are limited to their general, widely documented vocabulary. The OpenFLUME side
of every mapping is grounded in the [user's manual](../user-manual.md).

::: warning No input-deck import
OpenFLUME cannot read GFSSP or SINDA/FLUINT input files. To bring a model
across, you rebuild it, either in the editor or programmatically (see
[Rebuilding a model](#rebuilding-a-model) below).
:::

## Concept mapping: GFSSP

| GFSSP                                                            | OpenFLUME                                                                                   | Notes                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Boundary node                                                    | **Boundary node** (`type: "boundary"`)                                                      | P plus T (or quality, for real fluids) imposed. Time histories via `pressureSchedule` / `temperatureSchedule` (manual §3.7).                                                                                                                                                                                       |
| Internal node                                                    | **Internal node** (`type: "internal"`)                                                      | Needs a positive `volume` in transient runs; in steady runs, volume is ignored (§3.2).                                                                                                                                                                                                                             |
| Branch                                                           | **Branch** with a `component`                                                               | One mass-flow unknown per branch. Positive ṁ runs `from` → `to` (§1.4).                                                                                                                                                                                                                                            |
| Resistance options (pipe, restriction, valve, pump, fittings, …) | **Component types** (19; Appendix A)                                                        | `pipe` (Darcy–Weisbach + Swamee–Jain), `orifice` (with gas expansibility and choking), `valve` (area·Cd·position, optional schedule), `pump` (ΔP–Q curve), `checkValve`, `dynamicCheckValve`, `reliefValve`, `regulator`, `bend`, `areaChange`, `resistance` (K), `cavitatingVenturi`, `flowSource`, `heatedPipe`. |
| Tabulated / user-defined resistance                              | `dpTable`, `customResistance` (constant K or K(Re)), `userComponent`                        | §4.3.16, §4.3.5, §4.3.17.                                                                                                                                                                                                                                                                                          |
| Solid node                                                       | **Solid node**                                                                              | Lumped m·cp. cp can be a constant, a catalogue material, a table, an expression, or a time table (§3.4).                                                                                                                                                                                                           |
| Ambient node                                                     | **Ambient node**                                                                            | Fixed-temperature reservoir, optionally scheduled.                                                                                                                                                                                                                                                                 |
| Solid-to-solid conductor                                         | **Conduction** conductor (k, A, L)                                                          | k may be temperature-dependent or a catalogue material.                                                                                                                                                                                                                                                            |
| Solid-to-fluid conductor                                         | **Convection** conductor                                                                    | Exactly one fluid endpoint. Fixed h or a correlation: Dittus–Boelter, Miropolskii, Darr–Hartwig, TT-WF, custom expression (§4.4).                                                                                                                                                                                  |
| Solid-to-ambient convection                                      | **Conduction** conductor sized so kA/L = hA                                                 | A convection conductor needs a fluid endpoint, so an h·A film to an ambient node is written as an equivalent conduction tie. Manual §3.6 uses conductances like this to clamp walls.                                                                                                                               |
| Radiation conductor                                              | **Radiation** conductor (ε, A, view factor)                                                 | Endpoints are solid or ambient nodes.                                                                                                                                                                                                                                                                              |
| Fluid inertia option                                             | Pipe `inertia` (transient only)                                                             | Lumped (L/A)·dṁ/dt (§4.5.1). Trapped gas uses the internal node's `gasCushion` (§4.5.2).                                                                                                                                                                                                                           |
| User subroutines                                                 | User components (JavaScript), registers, logic rules, PID controllers, custom-h expressions | [usercode.md](../usercode.md). Code is trusted, not sandboxed.                                                                                                                                                                                                                                                     |
| Multiple fluids                                                  | Named fluids in `fluids` as **isolated continua**                                           | Unlike fluids never mix at a node. They couple only through solid walls (§3.9). The single exception is a CEA reacting junction (§3.9.2).                                                                                                                                                                          |

## Concept mapping: SINDA/FLUINT

| SINDA/FLUINT                                                  | OpenFLUME                                                                       | Notes                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tank (lump with volume)                                       | Internal node with `volume`                                                     | Mass and internal-energy storage are integrated in time.                                                                                                    |
| Junction (zero-volume lump)                                   | Internal node                                                                   | Fine in steady mode. In transient mode **every** internal node needs a positive volume, so there is no true zero-volume junction. Give it a small volume.   |
| Plenum                                                        | Boundary node                                                                   |                                                                                                                                                             |
| Tube (path with inertia)                                      | `pipe` with `inertia: true`                                                     | Transient only. Set **Initial flow guess** to the real starting flow, because for an inertial pipe it is the t = 0 condition (§6.5).                        |
| Connector / STUBE (quasi-steady path)                         | `pipe` without inertia, or another component                                    | Branch momentum is quasi-steady by default.                                                                                                                 |
| Connector device models (losses, valves, pumps, check valves) | `resistance`, `customResistance`, `valve`, `checkValve`, `pump`, …              | Match the ΔP(ṁ) relation (Appendix A, §4.3).                                                                                                                |
| Tie (lump ↔ thermal node)                                     | **Convection** conductor                                                        | Coupled implicitly: the fluid and solid energy residuals carry the same heat rate (§3.5).                                                                   |
| Diffusion node                                                | Solid node with `mass` and `cp`                                                 |                                                                                                                                                             |
| Arithmetic node (no capacitance)                              | Solid node                                                                      | Steady: `mass`/`cp` are not required. Transient: every solid node needs a positive mass, so give it a small one, which also gives it a short time constant. |
| Boundary node                                                 | Ambient node                                                                    |                                                                                                                                                             |
| Heater / source                                               | `heatInput` on a solid or fluid node                                            | Positive heat is added to the node (§1.4).                                                                                                                  |
| Linear conductor                                              | Conduction conductor                                                            |                                                                                                                                                             |
| Radiation conductor                                           | Radiation conductor                                                             |                                                                                                                                                             |
| Logic blocks                                                  | Registers, logic rules (including stop rules), PID controllers, user components | §3.8. Logic can write registers and stop a run, but cannot change component settings directly.                                                              |
| Twinned tanks (`LTWIN`)                                       | **No equivalent**                                                               | Emulated with registers and logic in the **LH2 tank no-vent fill** example (manual §7.13).                                                                  |
| Moveable ties (`PUTTIE`)                                      | **No equivalent**                                                               | Conductors bind to two fixed node ids. Emulated in the same example by computing tie heat in logic and applying it as `heatInput`.                          |

## What is the same

- **Staggered node/branch formulation.** Mass and energy are conserved at
  nodes, and momentum is solved on branches (manual §1.2). Junctions with any
  number of branches need no special handling.
- **You choose the spatial resolution.** One branch has one flow rate. To
  resolve a gradient along a line, you discretize it yourself. **Repeat…**
  and **Split…** (§3.13) build such chains.
- **Implicit solution.** Steady state uses coupled Newton–Raphson, with
  pseudo-transient continuation and trust-region globalization for hard cases.
  Transients use fully implicit backward Euler with fixed or adaptive steps
  (§4.6).
- **Some GFSSP conventions are followed on purpose.** The mass flux passed to
  convection correlations uses the GFSSP convention (§4.4). The default
  momentum-flux faces are "GFSSP-style" limited-upwind (§4.1.2). Miropolskii
  film boiling is the correlation "as used by GFSSP for chilldown" (§8.5).

## What is different

- **It runs in a browser, locally.** The solver runs in a Web Worker. Nothing
  is uploaded, and there is no license server. The same core runs in Node.js
  and from Python (`pip install openflume`; [python.md](../python.md)).
- **SI only in storage.** Models, `.fn` files, and the scripting API are SI
  with no unit metadata. The **Units ▾** presets (SI, Metric engineering, US
  customary) change only what the property fields display and accept (§1.3).
  Values typed into the sweep workspace and Model Text are always SI.
- **Text model files.** `.fn` is a line-oriented, lossless text projection of
  the model (Appendix C), so models can be diffed and kept in version
  control. **Share** puts the whole model in a link
  ([Sharing models](sharing.md)).
- **Real fluids from CoolProp.** There are 124 HEOS fluids
  ([fluid-catalogue.md](../fluid-catalogue.md)), alongside incompressible,
  ideal-gas, and thermal-expansion liquid models. Different equation-of-state
  classes can coexist in one network when they are coupled only through a
  wall.
- **Provenance.** Every run hashes the model that produced it. Results become
  **stale** as soon as the model changes (§8.7).
- **Exploration tools.** Single-parameter sweeps (§6.9), named simulation
  variants stored in the model file (§6.12), and run overlays on one plot
  (§6.8).
- **Open source (MIT).** You can read and change the closures. Correlation
  constants are exposed in **Setup → Physics → Closure calibration**.

## What is missing

These are listed in manual §1.7 or follow from the validation rules. Check
them against your model before you start rebuilding.

- **No shock capture.** Quasi-1-D compressible duct flow (Fanno and Rayleigh
  choking, seeded converging–diverging nozzles) is available as an opt-in, but
  there is no Rankine–Hugoniot jump and no way to compute thrust.
- **No acoustic wave propagation.** Lumped inertia captures bulk surge.
  Water-hammer wave timing and reflections cannot be modeled.
- **Two-phase flow is HEM only.** There is no slip, no flow-regime map, and no
  Lockhart–Martinelli multiplier. Pressure drop at high void fraction is
  under-predicted.
- **Cavitation is checked only at `cavitatingVenturi`.**
- **Turbomachinery is a pump curve.** There are no compressor or turbine maps
  and no shaft-work term in the energy equation.
- **No general mixing of unlike fluids** outside a declared CEA reacting
  junction. Species transport exists, but only for transient ideal-gas
  networks (§3.9).
- **No zero-volume nodes in transient runs** (fluid or solid). See the
  junction and arithmetic-node rows above.
- **No twinned tanks or moveable ties.** They can be emulated with logic, as
  in the LH₂ fill example, but this is effort, and the coupling it produces is
  explicit (lagged one step).
- **Solid–fluid coupling at very high NTU per node.** The LH₂ example's
  module header ([`src/ui/lh2StorageTank.ts`](../../src/ui/lh2StorageTank.ts))
  documents a case where heat-exchanger ducts at NTU ≈ 29 per node could not
  be solved by the segregated solid–fluid coupling. That is why the
  vapor-cooled shield and internal heat exchanger in that example are not
  resolved as flow paths.
- **Steady closed ideal-gas loops** need a pressure anchor (a boundary node)
  or a transient run.
- **No input-deck import** from either code.

OpenFLUME is alpha software (0.3.1) by a single author, built with heavy AI
assistance. Every validation report is regenerated from live solves so that
you can check the claims rather than trust them.

## Rebuilding a model

1. **Inventory.** List every lump or node, every path or branch, every thermal
   node, and every conductor or tie. Note where your original model relies on
   a feature from the "missing" list above.
2. **Choose the fluid model** for each continuum in **Setup → Fluids**. Use a
   CoolProp name where the original used a property library. Use
   incompressible or ideal-gas models where the original used constant
   properties.
3. **Translate each flow element by its ΔP(ṁ) relation**, not by its name. The
   governing equation for every component is in manual §4.3. If nothing fits,
   use `dpTable` (tabulated ΔP versus ṁ) or `customResistance` (K versus Re).
4. **Convert to SI** and check the sign conventions: branch direction,
   `elevationChange = z_to − z_from`, and heat added to a node is positive
   (§1.4).
5. **Build it.** Small models are quickest in the editor (manual §6.4; the
   [feed-system tutorial](feed-system.md) is a worked example). For large or
   repetitive models, generate the configuration in a script. The schema is
   plain JSON (manual §3.0). For example, from Python:

   ```python
   import openflume as of

   N = 10
   nodes = [{"id": "in", "type": "boundary", "x": 0, "y": 0,
             "pressure": 3e5, "temperature": 300}]
   nodes += [{"id": f"n{i}", "type": "internal", "x": 100 * i, "y": 0,
              "pressure": 2e5, "temperature": 300, "volume": 1e-4}
             for i in range(1, N)]
   nodes += [{"id": "out", "type": "boundary", "x": 100 * N, "y": 0,
              "pressure": 1e5, "temperature": 300}]
   ids = [n["id"] for n in nodes]
   branches = [{"id": f"p{i + 1}", "from": ids[i], "to": ids[i + 1],
                "component": {"type": "pipe", "length": 1.0,
                              "diameter": 0.02, "roughness": 1e-5}}
               for i in range(N)]

   net = of.Network.from_dict({
       "meta": {"name": "Line", "version": 2},
       "settings": {"mode": "steady", "tolerance": 1e-6,
                    "maxIterations": 200, "relaxation": 0.9},
       "fluid": {"model": "incompressible", "preset": "water"},
       "nodes": nodes,
       "branches": branches,
   })
   assert net.validate() == []
   net.save("line.fn")            # open in the web app with Load
   ```

6. **Verify before comparing.** First run a sub-case with a known answer,
   such as one branch against its hand calculation. Then compare the full
   model with the original code's output. Expect differences where the
   closures differ: friction correlation, convection correlation, or property
   source.

## Code-to-code benchmarks

These published cases have already been rebuilt and compared. Each is a useful
template for the matching kind of model:

| Case                                                                   | Reference                                                                     | Where                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compressible duct flow, 5 cases (Fanno, Rayleigh, combined, CD nozzle) | GFSSP TFAWS-2007 paper (NTRS 20070036728)                                     | [Compressible-flow report](../validation/compressible-report.md)                                                                                                      |
| Water-water counterflow heat exchanger                                 | GFSSP Example 5 (v5 manual)                                                   | Example **Water-water counterflow heat exchanger**; manual §7.9, §8.3; architecture mirrored in the [thermal-network report](../validation/thermal-network-report.md) |
| Entrapped-air line                                                     | Lee & Martin, GFSSP Figure 10, plus independent RK4 rigid column              | Example **Entrapped-air line**; manual §7.10; [fluid-transient report](../validation/fluid-transient-report.md)                                                       |
| Conduction rod with convection                                         | GFSSP Example 13 (NASA/TM-2011-216470 §6.13)                                  | Manual §8.3                                                                                                                                                           |
| N₂–N₂ counterflow heat exchanger                                       | JANNAF 2024, Majumdar & LeClair                                               | Manual §8.3                                                                                                                                                           |
| LH₂ no-vent tank fill                                                  | SINDA/FLUINT Sample Problem F (`TVS`)                                         | Example **LH2 tank no-vent fill**; manual §7.13                                                                                                                       |
| Cryogenic line chilldown                                               | NBS Report 9264 (experiment); GFSSP predictions; SINDA/FLUINT validation case | Example **Cryogenic line cooldown**; manual §7.11, §8.4; [chilldown tutorial](cryogenic-chilldown.md)                                                                 |

Manual §8.3 lists the tolerances for each case. For example, the GFSSP
Example 5 outlet temperatures are reproduced to 0.44 K (hot) and 0.19 K
(cold), and the SINDA/FLUINT Sample F fill fraction, pressure, vapor
temperature, and vent flow agree within about 1 % at 15 minutes. Remember
that agreement with another code supports the implementation but inherits
that code's assumptions (§8.1).
