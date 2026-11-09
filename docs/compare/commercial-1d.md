---
title: OpenFLUME and commercial 1-D system tools
description: Where an open-source browser solver fits beside Flowmaster, AFT Fathom/Arrow, GT-SUITE and similar tools — preliminary design, teaching, and auditable analysis.
---

# An open-source alternative to Flowmaster, AFT Fathom, or GT-SUITE for preliminary design

Commercial 1-D system-simulation tools cover much of the same ground as
OpenFLUME: pipe networks, pressure drop and flow distribution, thermal
coupling, and transients. Examples include Simcenter Flowmaster (Siemens),
AFT Fathom and AFT Arrow (Applied Flow Technology), GT-SUITE (Gamma
Technologies), EcosimPro, Simscape Fluids (MathWorks), and Modelica-based
environments.

**OpenFLUME does not replace these tools in general.** It is Alpha software
from a single author, its component library is much smaller, and it has no
industrial qualification history. It is useful for preliminary sizing,
teaching, and analysis that has to be auditable end to end.

## What the commercial tools generally offer

These are general, publicly known characteristics; check each vendor for
current features, licensing, and pricing.

- **Licensed, installed desktop applications** (or toolboxes inside a host
  platform such as MATLAB/Simulink for Simscape Fluids). Modelica is an open
  modeling language; OpenModelica is an open-source environment, and
  commercial Modelica tools also exist.
- **Large, sector-specific component libraries** built up over many years,
  often with vendor-maintained loss and performance data.
- **A record of industrial use** in each tool's target sectors, plus vendor
  documentation, training, and commercial support.
- **Capabilities OpenFLUME lacks**, varying by product: for example dedicated
  surge and waterhammer analysis, compressor and turbine maps, wider two-phase
  modeling, co-simulation interfaces, and integration with other engineering
  tools.

## What OpenFLUME offers instead

- **Zero install.** The [app](https://openflume.github.io/OpenFLUME/) runs
  in a browser. No account, license server, or IT ticket.
- **Local-first.** The solver runs in a Web Worker on your machine and model
  data is not uploaded.
- **Open source, MIT licensed.** The equations, closures, tolerances, and
  tests are public, so a reviewer can trace any result to the code that
  produced it.
- **Published verification.** Thirteen reports are
  [generated from live solves](../validation/index.md) by scripts in the
  repository, and their gate tests run in CI.
- **Scriptable.** `pip install openflume` drives the same core from Python,
  and models are plain-text `.fn` files that diff cleanly in version control.

## Where OpenFLUME fits

**Reasonable uses:**

- **Preliminary and conceptual sizing.** First-pass line sizes, orifice and
  venturi areas, tank blowdown times, pressurant budgets, heat-exchanger
  segment counts, and rough chilldown trends, before a model is built in the
  tool of record.
- **Independent cross-checks.** A second solver with a different code base
  can check a result from your primary tool, especially when the case reduces
  to one of the [verified problem types](../validation/index.md).
- **Teaching.** Students open a model from a link and run it in the browser.
  The verification reports show the closed-form solutions next to the
  computed ones.
- **Auditable analysis.** Open source, a config hash on every run, and
  stale-result marking ([§8.7](../user-manual.md#_8-7-result-provenance))
  give a reviewer every assumption behind a result.
- **Scripted studies.** Parameter sweeps and optimizer loops from Python.

**Poor fits (use a qualified commercial tool or a specialist code):**

- **Water hammer and fast valve transients** governed by acoustic wave
  timing. OpenFLUME has lumped inertia only, with no method of
  characteristics.
- **Compressor or turbine systems.** Turbomachinery is a pump curve only,
  with no shaft-work heating.
- **Shocks**, over-expanded nozzles, or supersonic-to-subsonic transitions.
- **High-void-fraction two-phase pressure drop.** OpenFLUME uses HEM only,
  which under-predicts it.
- **Cavitation risk on pumps and valves.** Cavitation is modeled only at the
  cavitating-venturi closure.
- **Mixing of unlike fluids** at junctions, outside CEA reacting junctions.
- **Results of record** for design reviews, certification, or safety cases,
  where your organization requires a qualified, supported tool.
- **Large libraries of vendor-specific components** (valves, fittings, HVAC,
  automotive, process plant). OpenFLUME has 19 branch types, plus user
  JavaScript components you would have to write and validate yourself.

The full list of structural limits is
[§1.7 Scope Boundaries](../user-manual.md#_1-7-scope-boundaries).

## Using OpenFLUME alongside commercial tools

1. **Start from a verified case.** Open the nearest built-in example or
   report case and confirm it matches before extending it.
   [Sanity: orifice hand-calc](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc)
   converges to a closed form you can check by hand.
2. **Check against hand calculations.** The incompressible solver reproduces
   its closed-form references to the Newton tolerance
   ([hydraulics report](../validation/incompressible-hydraulics-report.md)).
   If your model disagrees with a hand calculation, find out why.
3. **Refine the discretization.** Spatial resolution is up to you
   ([§1.2](../user-manual.md#_1-2-network-flow-analysis)). Refine until the
   answer you care about stops changing.
4. **Check correlation status.** Some closures are marked research status
   ([§8.5](../user-manual.md#_8-5-correlation-status)).
5. **Carry results forward into the tool of record** when the decision
   matters.

If OpenFLUME and a commercial tool disagree on a case where you trust the
reference,
[open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose)
with the reference value, tolerance, units, and the `.fn` file.

## Example links

- [Water distribution network](https://openflume.github.io/OpenFLUME/#example=water-distribution-network)
- [Three-pipe junction](https://openflume.github.io/OpenFLUME/#example=three-pipe-junction)
- [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown)
- [Water-water counterflow heat exchanger](https://openflume.github.io/OpenFLUME/#example=water-water-counterflow-heat-exchanger)
- [LOX/RP-1 thruster (combustor)](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-combustor)

See also the [comparison overview](index.md),
[NASA GFSSP](gfssp.md), and [SINDA/FLUINT](sinda-fluint.md).
