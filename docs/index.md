---
layout: home
title: OpenFLUME
titleTemplate: Open-source thermo-fluid network solver in the browser
description: GFSSP / SINDA-FLUINT-class thermo-fluid network solver that runs entirely in your browser. Steady and transient, real fluids, two-phase, conjugate heat transfer. Verified against NASA benchmarks.

hero:
  name: OpenFLUME
  text: Thermo-fluid network analysis in your browser
  tagline: A finite-volume network solver in the GFSSP / SINDA-FLUINT class. No install, no account, and your model never leaves your machine. Open source and checked against published benchmarks.
  actions:
    - theme: brand
      text: Launch the app
      link: https://openflume.github.io/OpenFLUME/
      target: _self
    - theme: alt
      text: Get started in 5 minutes
      link: /guides/getting-started
    - theme: alt
      text: See the verification record
      link: /validation/

features:
  - title: Zero install, local-first
    details: The solver runs in a Web Worker in your browser, with real-fluid properties from CoolProp compiled to WebAssembly. Nothing is uploaded, so it works on locked-down machines and with sensitive models.
  - title: Built for propulsion and thermal work
    details: Tanks, feed lines, orifices, valves, regulators, cavitating venturis, pumps, heated pipes, regenerative cooling, cryogenic chilldown, radiator loops, and CEA-coupled combustion junctions.
  - title: Steady and transient
    details: A Newton–Raphson steady solver and a backward-Euler transient solver with adaptive time steps. Fluid inertia, trapped-gas cushions, schedules, PID control, and stop conditions.
  - title: Real fluids, two-phase, compressible
    details: A 124-fluid CoolProp HEOS catalogue and a homogeneous-equilibrium two-phase model. Opt-in quasi-1-D compressible flow with Fanno/Rayleigh choking and converging–diverging nozzles.
  - title: Generated verification reports
    details: Ten validation reports are generated from live solves, each labeled analytic, code-to-code, or experimental. CI reruns the full scientific suite weekly.
  - title: Scriptable from Python
    details: pip install openflume drives the same solver core from Python, with sweeps, NumPy/pandas output, and a CLI. Save a model from the app and solve it in a notebook.
  - title: MIT licensed and auditable
    details: Every equation, closure, and tolerance is documented in the user manual, and the source is on GitHub. Cite it with the Zenodo DOI.
---

![Tank blowdown results in OpenFLUME: pressure and temperature histories of a venting tank](./figures/user-manual/tank-blowdown-results.png){.home-screenshot}

## Try a model now

Each link opens a working model in the app:

| Model                                                                                                                        | What it shows                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Sanity: orifice hand-calc](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc)                         | A steady result you can check by hand                                         |
| [Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown)                                                | Transient ideal-gas tank venting through a choked orifice                     |
| [Cryogenic line cooldown](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown)                            | Two-phase chilldown of a cryogenic transfer line with conjugate heat transfer |
| [LOX/RP-1 thruster (transient startup)](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-transient-startup)  | Feed system, CEA-coupled combustion chamber, and regen-cooled nozzle          |
| [Spacecraft radiator panel](https://openflume.github.io/OpenFLUME/#example=spacecraft-radiator-panel-ammonia-loop-heat-pipe) | Ammonia loop with a radiating panel                                           |
| [Capillary circuit](https://openflume.github.io/OpenFLUME/#example=capillary-circuit-stop-plus-trigger-valve)                | Microfluidic stop and trigger valves                                          |

All 14 built-in models are in the [examples gallery](./examples.md).

## Where it stands

OpenFLUME is **alpha** software (v0.3.1): a lumped-parameter network code (not CFD) with no shock capture, no method-of-characteristics water hammer, and HEM-only two-phase flow. The [scope boundaries](./user-manual.md#_1-7-scope-boundaries) list every limitation. If it disagrees with a reference you trust, [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose) with the details; well-documented disagreements are the most useful contributions.

New here? Start with the [5-minute guide](./guides/getting-started.md). Coming from GFSSP or SINDA/FLUINT? Read [the migration notes](./guides/from-gfssp.md). Teaching a course? See the [educator kit](./teach/index.md).
