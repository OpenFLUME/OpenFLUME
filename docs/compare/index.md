---
title: How OpenFLUME compares
description: An honest comparison of OpenFLUME with NASA GFSSP, SINDA/FLUINT, and commercial 1-D system tools, including where OpenFLUME is weaker.
---

# How OpenFLUME compares to other 1-D thermo-fluid network tools

OpenFLUME belongs to an established class of tools: finite-volume
node-and-branch network solvers for pressure, flow, and temperature in pipe
systems, with lumped solid thermal networks attached. The best-known members
of the class are NASA's GFSSP and C&R Technologies' SINDA/FLUINT. A set of
commercial 1-D system-simulation packages also overlaps with it.

This page sets out where OpenFLUME stands among them. OpenFLUME is **Alpha
software (version 0.3.1)**. The other tools have years or decades of
production use behind them, and OpenFLUME does not. Its case rests on
access, transparency, and auditability, not on maturity.

## What OpenFLUME is

- A finite-volume network solver: nodes store mass and energy, and branches
  carry mass flow governed by a momentum relation. The steady solver is
  Newton–Raphson. The transient solver is backward Euler with fixed or
  adaptive time steps.
- Real-fluid properties come from CoolProp compiled to WebAssembly. Ideal-gas,
  incompressible, and thermal-expansion-liquid models are also available.
- It runs entirely in the browser. The solver runs in a Web Worker, and no
  model data is sent to a server. The same core is available from Python
  (`pip install openflume`, see [Python package](../python.md)).
- MIT licensed. The source, the tests, and the scripts that generate the
  [verification reports](../validation/index.md) are all public.

## Comparison matrix

Entries for third-party tools are general and publicly known. Licensing
terms, prices, versions, and detailed capabilities change over time, so check
the vendor or distributor for anything that matters to your decision. "Check
vendor" means we have not verified the point, not that the capability is
missing.

|                                   | OpenFLUME                                                                  | NASA GFSSP                                                                   | SINDA/FLUINT                                                   | Commercial 1-D system tools (Flowmaster, AFT Fathom/Arrow, GT-SUITE, EcosimPro, Simscape Fluids, Modelica-based tools) |
| --------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Origin / owner**                | Open-source project, single author                                         | NASA Marshall Space Flight Center                                            | C&R Technologies (commercial)                                  | Commercial vendors. Modelica is an open language with both open-source and commercial tools                            |
| **How you get it**                | Open a URL, or `pip install openflume`                                     | NASA software release process; check NASA's software catalog for eligibility | Commercial license from C&R                                    | Commercial license from each vendor (OpenModelica is open source)                                                      |
| **Installation**                  | None (browser)                                                             | Installed desktop software                                                   | Installed desktop software                                     | Installed desktop software, or a toolbox inside a host platform (e.g. Simscape needs MATLAB/Simulink)                  |
| **Source code available**         | Yes (MIT)                                                                  | Check distributor                                                            | No (commercial)                                                | Generally no. Modelica libraries are often readable source                                                             |
| **Data locality**                 | Runs locally in the browser; nothing leaves the machine                    | Local                                                                        | Local                                                          | Local desktop. Check vendor for cloud options                                                                          |
| **Maturity / heritage**           | Alpha; no flight or program qualification heritage                         | Long NASA use in propulsion and fluid systems                                | Long industry use in spacecraft and aerospace thermal analysis | Long industrial use in their target sectors                                                                            |
| **Formulation**                   | Node/branch finite volume, Newton–Raphson, backward Euler                  | Node/branch finite volume (the formulation OpenFLUME follows)                | Lumped thermal network (SINDA) and fluid network (FLUINT)      | Varies by product                                                                                                      |
| **Component library**             | 19 branch types plus user JavaScript components                            | Extensive; user subroutines                                                  | Extensive; user logic                                          | Typically large, sector-specific libraries                                                                             |
| **Two-phase**                     | HEM only (no Lockhart–Martinelli yet)                                      | Check documentation                                                          | Check vendor                                                   | Varies; check vendor                                                                                                   |
| **Water hammer / acoustic waves** | No. Lumped inertia only, no method of characteristics                      | Check documentation                                                          | Check vendor                                                   | Some vendors ship dedicated surge/waterhammer tools; check vendor                                                      |
| **Shock capture**                 | No                                                                         | Check documentation                                                          | Check vendor                                                   | Varies                                                                                                                 |
| **Verification evidence**         | Seven reports generated from live solves; tests in public CI               | Published NASA reports and papers                                            | Vendor documentation and sample problems                       | Vendor documentation                                                                                                   |
| **Scripting**                     | Python package; TypeScript core library; plain-text `.fn` model files      | Input files; check documentation                                             | Input decks with user logic                                    | Varies (APIs, co-simulation, FMI for some)                                                                             |
| **Sharing a model**               | **Share** button puts the model in a URL fragment (not sent to any server) | Exchange input files                                                         | Exchange input files                                           | Exchange project files; recipient needs a license                                                                      |
| **Support**                       | GitHub issues; no commercial support                                       | Check NASA                                                                   | Commercial support from C&R                                    | Commercial support from vendor                                                                                         |

## Where OpenFLUME is weaker

Read this section before choosing OpenFLUME for work that matters. The full
list is [§1.7 Scope Boundaries](../user-manual.md#_1-7-scope-boundaries).

- **Alpha.** Version 0.3.1. Interfaces and file formats may change. Results
  have no program, flight, or certification heritage.
- **No shock capture.** Quasi-1-D compressible duct flow (Fanno and Rayleigh
  choking, converging–diverging nozzles) is supported. Normal shocks,
  over-expanded or separated nozzles, and supersonic-to-subsonic transitions
  are not. Thrust is not computed.
- **No acoustic wave propagation.** Lumped fluid inertia captures bulk surge.
  There is no method-of-characteristics water hammer, so wave timing and
  reflections cannot be simulated.
- **Two-phase is HEM only.** No separated-flow (Lockhart–Martinelli)
  pressure-drop multipliers yet, so high-void-fraction pressure drop is
  under-predicted.
- **Cavitation only at the cavitating-venturi closure**, with no general
  inception check.
- **Turbomachinery is a pump curve.** No compressor or turbine maps, and no
  shaft-work heating.
- **No general junction mixing** of unlike fluids, except at CEA reacting
  junctions.
- **Smaller component library** than mature tools: 19 branch types, plus
  user code.
- **User code is trusted, not sandboxed.**
- **Steady closed ideal-gas loops** need a pressure anchor.
- **Cryogenic chilldown** is validated only to a factor-of-1.6 regression band
  on chilldown time ([§8.4](../user-manual.md#_8-4-validation-against-experiment)).
- **One author, heavy AI assistance, no commercial support.** That is the
  reason the verification evidence is published in full.

## Where OpenFLUME is stronger

- **Nothing to install.** Open the
  [app](https://openflume.github.io/OpenFLUME/) and run a built-in example. No
  account and no license server.
- **Local-first.** The solver runs in your browser. Models and results stay on
  your machine, and share links keep the model in the URL fragment, which
  browsers do not send to servers.
- **Open source and auditable (MIT).** Every equation, closure, and tolerance
  is in a public repository. Where the user manual makes a claim, you can
  find the code that implements it.
- **Generated verification reports.** Seven reports are written by scripts
  from live solves, and the gate tests run in CI on every pull request and
  weekly with the slow suite ([overview](../validation/index.md)).
- **Scriptable.** `pip install openflume` drives the same core from Python
  for sweeps, optimizers, notebooks, and CI checks on models.
- **Plain-text models.** `.fn` files diff cleanly in version control.
- **Teaching and review.** Models open from a link, so a student or reviewer
  can rerun the exact case.

## Detailed comparisons

- [Open-source alternative to NASA GFSSP](gfssp.md)
- [Open-source alternative to SINDA/FLUINT](sinda-fluint.md)
- [OpenFLUME and commercial 1-D tools (Flowmaster, AFT Fathom/Arrow, GT-SUITE, …)](commercial-1d.md)
