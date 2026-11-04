---
title: Introducing OpenFLUME
description: An open-source, browser-based thermo-fluid network solver in the GFSSP and SINDA/FLUINT family. What v0.3.1 does, how it is verified, and its limits.
date: 2026-11-10
author: John Rising
---

# Introducing OpenFLUME

_John Rising · 2026-11-10_

OpenFLUME (Open FLUid Model Environment) is a finite-volume thermo-fluid network solver that runs entirely in your browser. You draw nodes and branches (pipes, orifices, valves, pumps, heated walls, capillary channels) and it solves the coupled mass, momentum, and energy equations, steady or transient. If you have used NASA's GFSSP or C&R's SINDA/FLUINT, the model will feel familiar: those codes inspired it, and much of the verification record is built on their published cases.

It is MIT-licensed, at version 0.3.1, and alpha software.

**[Open the app](https://openflume.github.io/OpenFLUME/)**: no install, no account.

## What it is

OpenFLUME is a lumped-parameter network code. Nodes carry pressure, enthalpy, and, in transients, stored mass and energy. Each branch carries a mass flow and supplies one momentum relation. Steady problems are solved by Newton–Raphson; transients use backward Euler with fixed or adaptive steps. Solids attach through conduction, convection, and radiation conductors, so you can model conjugate heat transfer such as a line chilling down, a heated pipe radiating to space, or a regeneratively cooled chamber wall.

The main capabilities, all documented in the [user manual](../user-manual.md):

- **19 branch component types**, from `pipe` and `orifice` through `cavitatingVenturi`, `dynamicCheckValve`, `regulator`, `rectChannel`, and `capillaryChannel`.
- **Four fluid models:** incompressible, ideal gas, thermally expandable liquid, and real fluids through CoolProp compiled to WebAssembly, with a generated 124-fluid HEOS catalogue.
- **Opt-in quasi-1-D compressible flow** (`momentumFlux` plus `kineticEnergy`), giving Fanno and Rayleigh choking and converging–diverging nozzles.
- **Transient two-phase flow** for real fluids with a homogeneous-equilibrium model (HEM), and Miropolskii film boiling for conjugate heat transfer.
- **Reacting flows:** node-level Arrhenius kinetics and CEA-coupled combustion junctions for LOX/RP-1 and LOX/CH₄.
- **Workflow tools:** subnetworks, Repeat and Split for discretizing lines, parameter sweeps, named variants, provenance-tracked run history, and a plain-text `.fn` file format that diffs cleanly.

## Running in the browser

I wanted a tool an engineer could open on a locked-down corporate laptop without an IT ticket, a license request, or a cloud-service review. The solver runs in a Web Worker in your browser tab, and CoolProp ships with the app instead of being fetched at run time. The app is static files; your network is never uploaded.

Running locally keeps model data on your machine; it doesn't by itself settle export-control questions, which remain yours to judge. The [contributing guide](../../CONTRIBUTING.md) covers the other direction: contributions must not include export-controlled material.

The **Share** button copies a link with the whole model compressed into the URL fragment (`#model=…`). Browsers never send the fragment to a server, so the link carries the model itself rather than pointing to an upload. Opening a shared link goes through the same validation and embedded-code trust prompt as opening a file.

## What is in v0.3.1

Recent releases, from the [changelog](../../CHANGELOG.md):

- **0.3.1:** a `pip install openflume` Python package. It runs the unmodified TypeScript core in a bundled Node.js runtime, so results match the library exactly. See [Python package](../python.md).
- **0.3.0:** microfluidic networks. `rectChannel` uses the exact laminar duct law for any aspect ratio. `capillaryChannel` handles Washburn filling with displaced-gas resistance, capillary pumps, stop (burst) and trigger valves, and air-trap detection. A new microfluidics validation report rebuilds six published networks from their papers.
- **0.2.2:** transient reacting junctions (with a LOX/RP-1 transient startup example), and Repeat and Split, which turn discretizing a line into one operation.

There are 14 built-in examples, each with a direct link. A few:

- [Sanity: orifice hand-calc](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc): converges to a closed-form answer, 0.8485 kg/s, that you can check by hand.
- [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown): an ideal-gas tank venting through an orifice, with time-history plots.
- [Cryogenic line cooldown](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown): saturated liquid hydrogen chilling a 61 m copper line, with temperature-dependent copper properties and film boiling.
- [LOX/RP-1 thruster (combustor)](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-combustor): a CEA reacting junction, choked nozzle, and regenerative jacket.
- [Capillary circuit (stop + trigger valve)](https://openflume.github.io/OpenFLUME/#example=capillary-circuit-stop-plus-trigger-valve): a pumpless microfluidic circuit with an event log.

## How the verification is organized

Every verification case belongs to one of three classes, kept separate ([user manual §8.1](../user-manual.md#_8-1-approach)):

1. **Analytic verification:** comparison against a closed-form or independently integrated solution. A discrepancy is a code defect.
2. **Code-to-code benchmarking:** agreement with published GFSSP or SINDA/FLUINT results. This supports the implementation but inherits the other code's assumptions.
3. **Validation against experiment:** comparison against digitized published test data. A disagreement could come from the model, the correlation, the discretization, or the experiment.

Seven validation reports cover incompressible hydraulics, compressible flow, thermal networks, fluid transients, tank transients, combustion, and microfluidics. A script under `scripts/` regenerates each from live solves of the current solver. Some results:

- The [compressible-flow report](../validation/compressible-report.md) recreates the NASA GFSSP TFAWS-2007 verification paper case for case. On default solver settings, all five cases land within the paper's own ~5 % agreement band.
- The [microfluidics report](../validation/microfluidics-report.md) reproduces a serial diluter's COMSOL inlet pressure (85.1 Pa against 85.2 Pa) and matches Shah & London's rectangular-duct constant to 0.002 %.
- The experimental chilldown corpus comes from NBS Report 9264. Four saturated runs are calibration-grade; seven subcooled runs are diagnostic only and are not quoted as agreement ([§8.4](../user-manual.md#_8-4-validation-against-experiment)).

Correlations without validation are marked as such in a status table ([§8.5](../user-manual.md#_8-5-correlation-status)). CI runs the full scientific suite on every push to `main` and weekly.

I wrote OpenFLUME alone with heavy AI assistance, as the README's "How This Was Built" section states, so I'd ask you to judge it by this record and the reports behind it.

## Limitations

Read these before using a result to support a decision. The authoritative list is [§1.7 Scope Boundaries](../user-manual.md#_1-7-scope-boundaries).

- **No shock capture.** With no Rankine–Hugoniot jump, there are no over-expanded nozzles, no shock position, and no thrust.
- **No acoustic wave propagation.** Lumped fluid inertia captures bulk surge, but there is no method-of-characteristics water hammer.
- **Cavitation is modeled only at the cavitating-venturi closure.** There is no general inception check on pumps, valves, or low-pressure nodes.
- **Turbomachinery is a pump curve.** There are no compressor or turbine maps and no shaft-work term.
- **No general junction mixing.** Outside a declared CEA reacting junction, unlike fluids may not meet at a node.
- **Two-phase is HEM only.** It under-predicts pressure drop at high void fraction; Lockhart–Martinelli multipliers are not yet implemented.
- **User code is trusted, not sandboxed.** Embedded components run through `new Function`, so treat model files that contain code like source code.
- **Steady closed ideal-gas loops need a pressure anchor.** Add a small leak to a boundary, or run in transient mode.

## How to try it

1. Open the [app](https://openflume.github.io/OpenFLUME/).
2. Open **Examples ▾** in the toolbar and choose **Sanity: orifice hand-calc**, or use [this direct link](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc).
3. Click **Run**. The status pill should read **Converged**. Select the orifice branch; its solved mass flow should match the hand calculation of 0.8485 kg/s to within 0.5 %.
4. Then open [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown), click **Run**, open the **Results** tab, and plot **Node pressure**.

From Python:

```bash
pip install openflume
```

To run from source, clone the [repository](https://github.com/OpenFLUME/OpenFLUME) and run `npm install && npm run dev` (requires Node.js 22).

## How to help

The most useful contribution is a **well-documented disagreement**: a case where OpenFLUME disagrees with a reference you trust, with the reference, the tolerance you expected, and the units. Please [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose).

Next most useful is a **validation case** from a lawfully published source, either a benchmark problem or digitized test data with clear provenance, that exercises a part of the solver the current reports don't cover. Read [CONTRIBUTING.md](../../CONTRIBUTING.md) first: numerical claims must state their reference, tolerance, and units, and tolerances may not be loosened without a physical or numerical justification.

If OpenFLUME contributes to your work, the citation is in the README and on Zenodo: [10.5281/zenodo.22051608](https://doi.org/10.5281/zenodo.22051608).
