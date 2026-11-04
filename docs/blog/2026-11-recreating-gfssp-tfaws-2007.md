---
title: Recreating NASA's GFSSP compressible-flow verification paper in a browser
description: A case-by-case walk through OpenFLUME's recreation of the TFAWS-2007 GFSSP study (Fanno, Rayleigh, combined, and C-D nozzle flow) and what the agreement proves.
date: 2026-11-17
author: John Rising
---

# Recreating NASA's GFSSP compressible-flow verification paper in a browser

_John Rising · 2026-11-17_

In 2007, Bandyopadhyay and Majumdar presented a short paper at the Thermal & Fluids Analysis Workshop: "Modeling of Compressible Flow with Friction and Heat Transfer using the Generalized Fluid System Simulation Program (GFSSP)" (TFAWS 2007, MSFC-464, [NTRS 20070036728](https://ntrs.nasa.gov/citations/20070036728)). It took a network code, a family of solvers that normally neglects inertia and kinetic energy, and showed it could reproduce friction choking, thermal choking, and nozzle flow.

When I added compressible duct flow to OpenFLUME, I used that paper as the test plan. Same geometry, same boundary conditions, same fluid, and the same figures, so the results can sit side by side with the original. This post walks through the generated [compressible-flow validation report](../validation/compressible-report.md) case by case. All the numbers below come from that report, which `scripts/compressible-validation-report.ts` regenerates from live solves. The CI gate is `src/core/__tests__/compressibleDuctFlow.test.ts`.

## What is being solved

OpenFLUME's compressible capability is two opt-in settings ([user manual §4.1.4](../user-manual.md#_4-1-4-compressible-duct-flow-kineticenergy)):

- **`momentumFlux`** adds the convective-acceleration term `(ṁ/A)²(1/ρ_dn − 1/ρ_up)` to each branch's momentum equation. On a tapered branch, each end contributes its own flow area.
- **`kineticEnergy`** switches the energy equation to transport stagnation enthalpy, `h₀ = h + v²/2`. Friction and acceleration are then evaluated at the resulting static states. Friction uses the harmonic mean of the endpoint static densities, which is the correct integral weighting for a flow that accelerates along a segment.

With both settings on, a chain of `pipe` branches with a constant `frictionFactor` (and, for nozzles, a linear taper via `diameterOut`) closes the quasi-1-D equations. As in GFSSP, the mass flow is not prescribed. Pressure is imposed at both ends and the flow rate is a result.

The fluid is nitrogen as an ideal gas (γ = 1.4, R = 296.8 J/kg·K). One point matters for everything that follows: **the reference in every case is analytic.** It is a fourth-order Runge–Kutta integration of the generalized 1-D compressible-flow ODE (4000 sub-steps per station interval), cross-checked against the closed-form Fanno and Rayleigh relations to machine precision. The GFSSP paper supplies the problem set and the agreement band. It does not supply the numbers OpenFLUME is graded against. I come back to why that distinction matters at the end.

## Cases 1–3: the constant-area pipe

The pipe is 6 in in diameter and 3207 in long, with an inlet at 50 psia and 80 °F. That length is the Fanno critical length for the case-1 conditions, so the flow chokes exactly at the exit.

![Schematic of the constant-area pipe](../validation/figures/compressible/fig01-pipe-schematic.svg)

The grid uses 21 nodes with cosine clustering toward the inlet and the choked exit. The original study reached the same conclusion: clustering near the choke point is what buys accuracy.

![Cosine-clustered 21-node distribution](../validation/figures/compressible/fig03-grid-distribution.svg)

### Case 1: Fanno flow

With an inlet Mach number of 0.5, a Darcy friction factor of 0.002, and a 6 in pipe, the computed Fanno critical length is 3207 in, the paper's value. The report compares three grids:

| Grid         | ṁ error | max ΔP/P | max ΔM/M |
| ------------ | ------- | -------- | -------- |
| 21 uniform   | 0.05 %  | 0.2 %    | 0.3 %    |
| 21 clustered | 0.01 %  | 0.0 %    | 0.0 %    |
| 41 clustered | 0.00 %  | 0.0 %    | 0.0 %    |

The uniform grid converges, but its peak pressure deviation near the choked exit is about an order of magnitude worse than the clustered grid's (0.2 % against 0.01 %). That matches the benefit of non-uniform gridding that the original paper reports.

![Fanno flow pressure distribution for three grids](../validation/figures/compressible/fig04-fanno-pressure.svg)

![Fanno flow Mach number](../validation/figures/compressible/fig06-fanno-mach.svg)

Mach number is derived from the solved mass flow, pressure, and temperature. The small offset visible even at the inlet exists because the flow rate is computed, not prescribed: 0.01 % from the analytic choked value on the 21-node clustered grid.

### Case 2: Rayleigh flow

Same pipe, zero friction, uniform wall heat flux, inlet Mach 0.46. The analytically computed choking heat rate is 2073 Btu/s. The paper gives 2088 Btu/s, a 0.7 % difference that the report attributes to the paper's imperial unit constants.

This was the worst of the five cases on the accurate scheme: up to 2.5 % on pressure and Mach number and 1.6 % on temperature, over 18 stations. The static temperature first rises with heating and then falls as the flow accelerates past the Rayleigh maximum at M = 1/√γ, and the numerical solution follows that turn.

![Rayleigh flow temperature distribution](../validation/figures/compressible/fig07-rayleigh-temperature.svg)

![Rayleigh flow Mach number](../validation/figures/compressible/fig09-rayleigh-mach.svg)

There is one exclusion, and I want to be explicit about it. The station nearest the exit sits at an analytic M ≈ 0.95. There the node-lumped heat allocation chokes the discrete solution one node early, so that station is excluded from the statistics. The original paper reports the same near-choking discrepancy and makes the same kind of exclusion. The rule is written into the report: the last station is excluded when analytic M > 0.95 for cases 1 and 3, and M > 0.92 for case 2.

### Case 3: combined friction and heat transfer

No standard table exists for this case, so the reference is the RK4 integration alone. With inlet Mach 0.45, f = 0.002, and Q = 555 Btu/s spread uniformly, agreement is within 1.6 % on the thermodynamic profiles and 1.4 % on Mach number, with a mass-flow error of 0.18 %.

![Combined friction and heat: temperature](../validation/figures/compressible/fig10-combined-temperature.svg)

![Combined friction and heat: Mach number](../validation/figures/compressible/fig12-combined-mach.svg)

## Cases 4 and 5: the converging–diverging nozzle

The paper describes its nozzle dimensions as arbitrary. The report follows its description: the diameter tapers linearly from 8 in at the inlet to 6 in at the throat (x = 12 in), then back out to 7.2 in at the exit (L = 30 in). The friction factor is a constant 0.05. Case 5 adds a constant wall heat flux. The exit pressure is taken from the analytical solution so that the inlet Mach number is 0.25, which is the same procedure as the paper and keeps the flow subsonic throughout.

![Converging-diverging nozzle schematic](../validation/figures/compressible/fig02-nozzle-schematic.svg)

A 65-node grid, clustered near the inlet and the throat, is grid-independent. Whatever residual error remains concentrates at the throat, where straight tapered segments represent the slope discontinuity. The paper reports error at the same place. Here it stays below 0.1 %.

![Nozzle grid study](../validation/figures/compressible/fig13-nozzle-grid-study.svg)

![Nozzle Mach number, friction only and friction plus heat](../validation/figures/compressible/fig14-nozzle-mach.svg)

![Nozzle pressure, friction only and friction plus heat](../validation/figures/compressible/fig15-nozzle-pressure.svg)

Mass-flow errors are 0.03 % (case 4) and 0.01 % (case 5). All four numerical series track their analytic counterparts within 0.1 % on Mach number.

## The scheme question, and the honest table

Every number quoted so far uses `momentumFluxScheme: "central"`, the exact endpoint (integral) form of the acceleration term. **That is not the default.** The default is `"upwind"`: GFSSP-style donor-cell momentum advection with a MUSCL/van Albada limited face density. Here are the same cases on the default:

| Case                        | ṁ error | max ΔM/M |
| --------------------------- | ------- | -------- |
| 1 — Fanno                   | 2.05 %  | 2.2 %    |
| 2 — Rayleigh                | 3.48 %  | 4.0 %    |
| 3 — Combined                | 2.19 %  | 2.6 %    |
| 4 — Nozzle, friction        | 0.38 %  | 0.6 %    |
| 5 — Nozzle, friction + heat | 0.36 %  | 0.6 %    |

The paper reports 1.7–5 % on its own first-order upwind discretization, so the default lands in that band. The error concentrates at the choking cell, where the limiter correctly falls back to first order. Refining the Fanno grid from 21 to 41 nodes halves it, which is first-order convergence at the choke.

So why is the less accurate scheme the default? That brings me to what was hard.

## What was hard

**Spurious transonic roots.** The central form is more accurate, but its discrete equations admit roots that are not physical. A station can dip onto the supersonic branch mid-convergent, which amounts to a discrete expansion shock. Newton will happily converge to one of those roots from a poor starting guess. Version 0.2.0 added the limited-upwind faces precisely because they remove those roots by construction. Under upwind, entropy-violating states do not satisfy the discrete equations at all, so even a flat cold start converges to the physical branch ([user manual §1.7](../user-manual.md#_1-7-scope-boundaries)). The price is the 2–6 % at the choke shown in the table above.

**Certifying the central root.** The central scheme is still available, so it needed a guard. A second-law admissibility audit (`settings.transonicAdmissibility`) checks a converged central-scheme root after the fact, re-seeds when it fails, and reports warnings. The central-scheme profile figures in the report are roots the audit has certified.

**Seeding.** Under the central scheme, the near-choked cases need an initial mass-flow guess (`branches[].initialMdot`) plus monotonically falling nodal pressure and temperature profiles. GFSSP requires initial guesses too. Under upwind they converge from cold starts.

**Holding a near-sonic exit.** A segregated energy update cannot hold states near M = 1. With `kineticEnergy` on, the solver couples node enthalpies into the Newton system with pressures and mass flows (the `[P, ṁ, h]` system), and that is what lets it sit at a choked exit.

**Reporting what was actually solved.** One bug from development is worth naming. Under `momentumFlux`, the _reported_ branch pressure drop used to be re-derived from a legacy constant-area central acceleration term. That term disagreed with the default upwind scheme, with tapered branches, and with junction-inlet exclusions. The solution itself was fine, but the number shown to the user was not the one the solver had converged. Since 0.2.0, the reported ΔP mirrors the converged momentum row exactly ([CHANGELOG](../../CHANGELOG.md)).

## What this agreement does and does not prove

This study is often described as code-to-code benchmarking against GFSSP. Strictly, it is not. Every comparison is against an analytic reference, and that is why the user manual files it under _analytic verification_ ([§8.2](../user-manual.md#_8-2-analytic-verification)). The paper contributes the cases, the geometry, the reporting format, and an agreement band to measure against.

What it does show:

- For ideal-gas flow with constant friction factor and uniform wall heat flux, OpenFLUME's discretization of the quasi-1-D equations converges to the analytic solution. It converges at the expected order, and its largest errors fall where the original study's did: the last node before a choked exit, and the nozzle throat's slope discontinuity.
- On the default scheme, its accuracy is in the same class as GFSSP's published accuracy on the same problems.

What it does not show:

- **That OpenFLUME agrees with GFSSP point by point.** I compared against the analytic solution, not against digitized GFSSP output. Matching the same band against the same reference is weaker evidence than matching each other directly.
- **Anything about real fluids** in this report. Real-fluid transonic flow is a separate test (`realFluidTransonic.test.ts`). There a CoolProp nitrogen choked C-D nozzle matches an analytic ideal-gas twin on mass flow to 0.17 %.
- **Anything about experiment.** This is verification, not validation. It shows the equations are solved correctly, not that the equations describe a particular piece of hardware.
- **Anything supersonic past a shock.** OpenFLUME has no shock capture and no Rankine–Hugoniot jump, so over-expanded and separated nozzle flow, shock position, and thrust are out of scope. A supersonic exhaust can be reached only by smooth expansion.
- **Variable friction or heat transfer correlations.** Constant f was used deliberately to match the benchmark. Correlation-driven friction is a different question.

## Try it yourself

Rerun the report from a clone with `npx tsx scripts/compressible-validation-report.ts`. A choked nozzle also appears in the shipped [LOX/RP-1 thruster (combustor)](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-combustor) example, checked in the [combustion report](../validation/combustion-report.md).

If you have a compressible-flow case where you expect OpenFLUME to fail, with a published reference and a tolerance, please [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose).
