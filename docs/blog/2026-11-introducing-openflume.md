---
title: Introducing OpenFLUME
description: An open-source, browser-based thermo-fluid network solver in the GFSSP and SINDA/FLUINT family. What it is, what v0.3.1 does, and how to check it.
date: 2026-11-10
author: John Rising
---

# Introducing OpenFLUME

_John Rising · 2026-11-10_

OpenFLUME (Open FLUid Model Environment) is a finite-volume thermo-fluid network solver that runs entirely in your browser. You draw a network of nodes and branches, which can be pipes, orifices, valves, pumps, heated walls, or capillary channels. It then solves the coupled mass, momentum, and energy equations, steady or transient. If you have used NASA's GFSSP or C&R's SINDA/FLUINT, the model will feel familiar. Those two codes are its inspiration, and a good part of the verification record is built on their published cases.

It is MIT-licensed, at version 0.3.1, and it is alpha software. This post covers what it is, why I built it the way I did, what is in the current release, how the verification is organized, how it was built, and what it cannot do.

**[Open the app](https://openflume.github.io/OpenFLUME/)**: no install, no account.

## What it is

OpenFLUME is a lumped-parameter network code. Nodes carry pressure, enthalpy, and (in transients) stored mass and energy. Branches carry mass flow and supply one momentum relation each. The steady solver is Newton–Raphson. The transient solver is backward Euler with fixed or adaptive steps. Solids attach through conduction, convection, and radiation conductors, so you can model conjugate heat transfer: a line chilling down, a heated pipe radiating to space, a regeneratively cooled chamber wall.

The headline capabilities, all documented in the [user manual](../user-manual.md):

- **19 branch component types**, from `pipe` and `orifice` through `cavitatingVenturi`, `dynamicCheckValve`, `regulator`, `rectChannel`, and `capillaryChannel`.
- **Four fluid models:** incompressible, ideal gas, thermally expandable liquid, and real fluids through CoolProp compiled to WebAssembly, with a generated 124-fluid HEOS catalogue.
- **Opt-in quasi-1-D compressible flow** (`momentumFlux` plus `kineticEnergy`), which gives Fanno and Rayleigh choking and converging–diverging nozzles.
- **Transient two-phase flow** for real fluids using a homogeneous-equilibrium model (HEM), with Miropolskii film boiling for conjugate heat transfer.
- **Reacting flows:** node-level Arrhenius kinetics and CEA-coupled combustion junctions for LOX/RP-1 and LOX/CH₄.
- **Workflow tools:** subnetworks, Repeat and Split for discretizing lines, parameter sweeps, named variants, provenance-tracked run history, and a plain-text `.fn` file format that diffs cleanly.

## Why the browser, and why local-first

I wanted a tool an engineer could open on a locked-down corporate laptop without filing an IT ticket, a license request, or a cloud-service review. The solver runs in a Web Worker inside your browser tab. CoolProp is bundled with the app, so it is not fetched at run time. Your model is never uploaded: the app is static files, and nothing about your network goes to a server.

That matters in environments where the model itself is sensitive: proprietary designs, or work done near ITAR-controlled programs. Let me be precise about the limits of that claim. OpenFLUME's architecture keeps your data on your machine. That is a technical property. It is not a compliance determination, and I make no claim that using OpenFLUME satisfies any export-control obligation. Whether a given model, file, or workflow is controlled is still your responsibility and your organization's. The [contributing guide](../../CONTRIBUTING.md) says the same thing from the other side: contributions must not include export-controlled material.

The app also has a **Share** button. It copies a link with the whole model compressed into the URL fragment (`#model=…`). Browsers never send the fragment to a server, so sharing does not break the local-first property: the link _is_ the model, not a pointer to an upload. Opening a shared link goes through the same validation and embedded-code trust prompt as opening a file.

I will write more about this architecture, and what it costs, in a later post.

## What is in v0.3.1

The recent releases, from the [changelog](../../CHANGELOG.md):

- **0.3.1:** a `pip install openflume` Python package. It does not reimplement anything. It runs the unmodified TypeScript core in a bundled Node.js runtime, so results match the library exactly. See [Python package](../python.md).
- **0.3.0:** microfluidic networks. The new `rectChannel` uses the exact laminar duct law for any aspect ratio. The new `capillaryChannel` handles Washburn filling with displaced-gas resistance, capillary pumps, stop (burst) and trigger valves, and air-trap detection. A new microfluidics validation report rebuilds six published networks from their papers.
- **0.2.2:** transient reacting junctions (a LOX/RP-1 transient startup example), and the Repeat and Split commands that turn discretizing a line into one operation.

There are 14 built-in examples. Each opens directly from a link:

- [Sanity: orifice hand-calc](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc): converges to a closed-form answer, 0.8485 kg/s, that you can check by hand.
- [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown): an ideal-gas tank venting through an orifice, with time-history plots.
- [Cryogenic line cooldown](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown): saturated liquid hydrogen chilling a 61 m copper line, with temperature-dependent copper properties and film boiling.
- [LOX/RP-1 thruster (combustor)](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-combustor): a CEA reacting junction, choked nozzle, and regenerative jacket.
- [Capillary circuit (stop + trigger valve)](https://openflume.github.io/OpenFLUME/#example=capillary-circuit-stop-plus-trigger-valve): a pumpless microfluidic circuit with an event log.

## How the verification is organized

A solver is only as useful as the evidence that it is right, so the verification record is the part of the project I care most about. Every case falls into one of three deliberately separate classes ([user manual §8.1](../user-manual.md#_8-1-approach)):

1. **Analytic verification:** comparison against a closed-form or independently integrated solution. A discrepancy here is a code defect.
2. **Code-to-code benchmarking:** agreement with GFSSP or SINDA/FLUINT published results. This supports the implementation but inherits the other code's assumptions.
3. **Validation against experiment:** comparison against digitized published test data. Here a disagreement could come from the model, the correlation, the discretization, or the experiment.

Seven validation reports cover incompressible hydraulics, compressible flow, thermal networks, fluid transients, tank transients, combustion, and microfluidics. A script under `scripts/` regenerates each one from live solves of the current solver. The numbers are never transcribed by hand. A few examples:

- The [compressible-flow report](../validation/compressible-report.md) recreates the NASA GFSSP TFAWS-2007 verification paper case for case. On the default solver settings, all five cases land within the paper's own ~5 % agreement band.
- The [microfluidics report](../validation/microfluidics-report.md) reproduces a serial diluter's COMSOL inlet pressure (85.1 Pa against 85.2 Pa) and matches Shah & London's rectangular-duct constant to 0.002 %.
- The experimental chilldown corpus comes from NBS Report 9264. Its per-corpus trust levels are stated outright: four saturated runs are calibration-grade, and seven subcooled runs are diagnostic only and may not be quoted as agreement ([§8.4](../user-manual.md#_8-4-validation-against-experiment)).

Correlations that have not been validated are labeled that way in a status table ([§8.5](../user-manual.md#_8-5-correlation-status)). The full scientific suite runs in CI on every push to `main` and weekly, not only at release.

## How it was built

I wrote OpenFLUME alone, with heavy AI assistance, over a short calendar period. The README says so in its "How This Was Built" section, and I want to say it here too, plainly.

That fact is the reason the verification record looks the way it does. When generating plausible-looking code is cheap, plausibility proves nothing, and evidence is the only thing that separates a correct solver from a convincing one. So my request is the same as the README's: **check it rather than trust it.** Every report names its reference, tolerance, units, and assumptions, and every one can be regenerated. A later post covers how I tried to make an AI-assisted codebase checkable, including concrete defects the verification suite caught.

## Limitations

These are structural, and you should read them before using a result to support a decision. The authoritative list is [§1.7 Scope Boundaries](../user-manual.md#_1-7-scope-boundaries).

- **No shock capture.** There is no Rankine–Hugoniot jump, so no over-expanded nozzles, no shock position, and no thrust.
- **No acoustic wave propagation.** Lumped fluid inertia captures bulk surge, but there is no method-of-characteristics water hammer.
- **Cavitation is modeled only at the cavitating-venturi closure.** There is no general inception check on pumps, valves, or low-pressure nodes.
- **Turbomachinery is a pump curve.** There are no compressor or turbine maps and no shaft-work term.
- **No general junction mixing.** Outside a declared CEA reacting junction, unlike fluids may not meet at a node.
- **Two-phase is HEM only.** It under-predicts pressure drop at high void fraction, and Lockhart–Martinelli multipliers are not yet implemented.
- **User code is trusted, not sandboxed.** Embedded components run through `new Function`, so treat model files that contain code like source code.
- **Steady closed ideal-gas loops need a pressure anchor.** Use a small leak to a boundary, or run in transient mode.

And again: it is alpha software.

## How to try it

1. Open the [app](https://openflume.github.io/OpenFLUME/).
2. Open **Examples ▾** in the toolbar and choose **Sanity: orifice hand-calc**, or use [this direct link](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc).
3. Click **Run**. The status pill should report **Converged**. Select the orifice branch, and its solved mass flow should agree with the hand calculation of about 0.8485 kg/s to within 0.5 %.
4. Then try [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown), click **Run**, open the **Results** tab, and plot **Node pressure**.

From Python:

```bash
pip install openflume
```

To run from source, clone the [repository](https://github.com/OpenFLUME/OpenFLUME) and run `npm install && npm run dev`. That needs Node.js 22.

## How to help

The most valuable contribution is not code. It is a **well-documented disagreement**: a case where OpenFLUME disagrees with a reference you trust, together with the reference, the tolerance you expected, and the units. Please [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose).

The second most valuable is a **validation case** from a lawfully published source, either a benchmark problem or digitized test data with clear provenance, that exercises a part of the solver the current reports do not cover. Read [CONTRIBUTING.md](../../CONTRIBUTING.md) first. Numerical claims must state their reference, tolerance, and units. Tolerances may not be loosened without a physical or numerical justification. No export-controlled material, ever.

If OpenFLUME contributes to your work, the citation is in the README and on Zenodo: [10.5281/zenodo.22051608](https://doi.org/10.5281/zenodo.22051608).
