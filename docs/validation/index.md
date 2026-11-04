---
title: Verification and validation
description: How OpenFLUME is checked — analytic verification, code-to-code benchmarks, and validation against experiment, with ten reports generated from live solves.
---

# Verification and validation

OpenFLUME is Alpha software. It was written by one engineer with heavy AI
assistance (see "How This Was Built" in the
[README](../../README.md#how-this-was-built)), so it has to be checked, not
trusted. This page is the index to that evidence: what kind of evidence each
result is, how the reports are produced, how often the checks run, and where
the evidence stops.

The authoritative record is
[§8 of the user's manual](../user-manual.md#_8-verification-and-validation).
Before using a result to support a decision, read
[§1.7 Scope Boundaries](../user-manual.md#_1-7-scope-boundaries) as well.

## Three classes of evidence

The manual (§8.1) separates three kinds of evidence. They mean different
things, and a result should be cited with its class:

| Class | Compared against | What a disagreement means |
| ----- | ---------------- | ------------------------- |
| **Analytic verification** | A closed-form solution, or an independent reference (e.g. RK4 integration of the exact ODE) converged far below the solver's own tolerance | A code defect, or discretization error that should shrink as the grid or time step is refined |
| **Code-to-code benchmarking** | Published output of another established program (NASA GFSSP, SINDA/FLUINT sample decks, COMSOL results in papers) | Supports the implementation, but inherits the other code's assumptions |
| **Validation against experiment** | Measured data, digitized with cited provenance | Could be the model, the closure correlation, the discretization, or the experiment |

Where a correlation has research status or has not been validated, the manual
says so and gives no agreement figure for it
([§8.5](../user-manual.md#_8-5-correlation-status)).

## How the reports are generated

Each of the ten reports below is written by a script in
[`scripts/`](../../scripts/), which builds the cases, runs the current
solver, computes the reference solutions, and writes the Markdown and SVG
figures. None of the numbers are typed in by hand.

| Report | Generator | CI gate tests named in the report |
| ------ | --------- | --------------------------------- |
| [Compressible flow](compressible-report.md) | `scripts/compressible-validation-report.ts` | `src/core/__tests__/compressibleDuctFlow.test.ts` |
| [Incompressible hydraulics](incompressible-hydraulics-report.md) | `scripts/hydraulics-validation-report.ts` | `solver.test.ts`, `benchmarks.test.ts` |
| [Thermal network](thermal-network-report.md) | `scripts/thermal-validation-report.ts` | `thermal.test.ts`, `solidThermalTransient.test.ts` |
| [Fluid transient](fluid-transient-report.md) | `scripts/fluid-transient-validation-report.ts` | `fluidTransient.test.ts` |
| [Tank transient](tank-transient-report.md) | `scripts/tank-transient-validation-report.ts` | `transient.test.ts`, `benchmarks.test.ts` |
| [Combustion](combustion-report.md) | `scripts/combustion-validation-report.ts` | `reactingJunction.test.ts` and the examples suite |
| [Microfluidics](microfluidics-report.md) | `scripts/microfluidics-validation-report.ts` | `src/validation/__tests__/microfluidics.test.ts`, plus `rectChannel`, `capillaryChannel` and `flowScaledTolerance` tests |
| [Cryogenic chilldown](chilldown-report.md) | `scripts/chilldown-validation-report.ts` | `src/ui/tests/chilldownBaseline.test.ts` (slow tier), `nbsTraceCorpus.test.ts`, `traceBaseline.test.ts` |
| [Choked flow and cavitation](choked-flow-report.md) | `scripts/choked-flow-validation-report.ts` | `src/validation/__tests__/chokedFlow.test.ts`, `cavitationHord.test.ts`, `experimentalData.test.ts` |
| [Tank self-pressurization](tank-self-pressurization-report.md) | `scripts/tank-pressurization-validation-report.ts` | `src/validation/__tests__/tankSelfPressurization.test.ts` |

To regenerate a report from a clone:

```bash
npx tsx scripts/compressible-validation-report.ts
```

The scripts are run by hand. CI does not rewrite the reports. A report
therefore shows the solver as it was when the report was last regenerated,
while the gate tests named in its header recheck the same physics on every CI
run.

## CI cadence

From [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml):

- **Every pull request and every push to `main`:** lint, format check, the
  fast test tier (`npm test`), and a production build. A
  `scientific-validation` job runs every Vitest file (`npm run test:all`) and
  the fluid-catalogue drift check.
- **Push to `main`, weekly schedule (Mondays 03:17 UTC), and manual dispatch:**
  the same `scientific-validation` job runs with `RUN_SLOW=1`, which turns on
  the expensive opt-in sweeps and convergence studies. On pull requests these
  slow blocks are skipped.
- **Python package:** the wheel is built and the installed wheel is tested on
  Linux, macOS, and Windows.
- **End-to-end:** the Playwright suite runs in four shards against the
  production build.

The test tiers are described in
[§8.6](../user-manual.md#_8-6-test-tiers) and
[`testing-slow.md`](../testing-slow.md).

## The ten reports

The headline figures below are copied from each report's abstract or summary
table. Each report gives the definitions, normalizations, and excluded
stations behind its figures. Read those before quoting a number.

| Report | Cases | Reference | Headline agreement |
| ------ | ----- | --------- | ------------------ |
| [Compressible flow](compressible-report.md): recreation of the NASA GFSSP TFAWS-2007 study | 5 cases (Fanno, Rayleigh, combined, two nozzles), 7 grid configurations | RK4 of the generalized 1-D ODE, cross-checked with Fanno/Rayleigh closed forms | With `central` momentum faces: mass flow within 0.18 %, worst profile error 2.5 % (Rayleigh ΔP/P and ΔM/M). With the default `upwind` faces: mass flow 0.36–3.48 %, max ΔM/M 4.0 %. The original study reports 1.7–5 % for GFSSP |
| [Incompressible hydraulics](incompressible-hydraulics-report.md) | 6 cases, 49 compared quantities | Closed forms (Hagen–Poiseuille, Darcy–Weisbach, hydrostatics) and independently converged references (Hardy-Cross network, pump operating point) | All 49 within 9.98e-10 %, which is the Newton tolerance (10⁻⁹). The friction closure and the reference are the same expression, so this verifies the network solve, not the friction law |
| [Thermal network](thermal-network-report.md) | 5 cases | Series resistance, radiation–convection balance, lumped capacitance, heated-pipe exponential, ε–NTU | Composite wall 6.9e-14 %. Lumped cooldown within 0.18 % of span at dt = τ/100 (error ratio 4.01 for a 4× step refinement). 20-segment heat exchanger: effectiveness within 2.62 %, outlets within 1.730 K. The error shrinks as segmentation is refined |
| [Fluid transient](fluid-transient-report.md) | 4 cases | Exact tanh/hyperbolic rigid-column laws, RK4 gas-spring oscillator, polytropic law | Startup/decay within 0.05 % RMS at the refined step. Oscillator period within 0.2 % (linearized) and 0.1 % (RK4). Method-of-characteristics water hammer is explicitly out of scope |
| [Tank transient](tank-transient-report.md) | 5 cases (including a 4-level dt study) | RK4 of the lumped ODEs, choked blowdown closed form, equalization equilibrium, fill-heating limit | Every trace within 1.5 % at dt = 0.05 s. Mass conserved to 0.001 % or better. First-order convergence in dt confirmed |
| [Combustion](combustion-report.md): CEA reacting junction and LOX/RP-1 thruster | 5 groups of checks | CEA identities, choked-flow/orifice closed forms, RK4 quasi-1-D nozzle ODE, exact wall-resistance network | Local nozzle profile error 3.16 % (subsonic) and 4.87 % (supersonic). Mass flow biased 3.01 % by the sonic cell. Wall temperatures 2.3e-13 K. Startup ramp vs. quasi-static reference 7.8e-5 % |
| [Microfluidics](microfluidics-report.md) | 5 closed-form cases (Part A) + 6 published networks (Part B) | Shah & London, Washburn, Jurin; papers' COMSOL values, design values and measurements | Duct friction constant 0.002 %. Serial diluter inlet pressure 85.1 Pa vs. 85.2 Pa (COMSOL). Capillaric valve pressures within 1.3 %. Siphon flow 2.87 µL/s at nominal diameter vs. 3.63 ± 0.07 µL/s measured. The measurement lies inside the ±27 % flow band set by the stated diameter uncertainty |
| [Cryogenic chilldown](chilldown-report.md): NBS Report 9264 | 4 Table-6 LN₂ cases (3 trusted, 1 diagnostic), grid study N = 3–12, 4 trusted trace runs | Measured chilldown times and digitized wall traces; GFSSP's published predictions | Saturated LN₂ station-4 chilldown time +13.0 %, +6.9 %, +18.6 % (N = 3; mean 12.8 %) against GFSSP's +12.1 %, +6.7 %, +7.7 % (8.8 %); +2.1 % to +18.6 % over N = 3–12. Subcooled +19.1 % (diagnostic). Trace RMSE 49–61 K: the inlet wall chills too slowly and the modeled front is 2–5 times broader than measured |
| [Choked flow and cavitation](choked-flow-report.md): NASA TP-1484, TM X-71760, CR-2054 | 326 nozzle and 26 orifice points (N₂, CH₄), 32 LH₂ venturi cavities | Measured maximum mass flux; measured cavity pressures; HEM as a reference model | Subcooled-liquid nozzle inlets: median +4.5 % (−3.4 % to +17.1 %). Gas: −5.6 % to +4.7 %. Near-saturated liquid under-predicted (down to 0.15×); supercritical over-predicted (median +30 %) by the frozen-κ expansibility closure. Sharp-edged orifice at measured back pressure, C_d = 0.61: −6.1 % to +1.3 % (subcooled). Venturi leading-edge cavity pressure 6–55 % below P_v(T₀) |
| [Tank self-pressurization](tank-self-pressurization-report.md): NASA TM-103804 | 3 heat fluxes, 4.89 m³ LH₂ tank | Measured rise rates; the paper's homogeneous model; analytic homogeneous reference | Lumped tank equals the analytic homogeneous rate to 0.15 % and the paper's model to −3.9 % to +5.6 %. Measured rise 1.07, 2.47 and 3.05 times faster (stratification, not represented) |

Most of these reports are analytic verification. The compressible report
recreates a code-to-code study case for case, but its references are
analytic. The chilldown, choked-flow, and tank self-pressurization reports
are validation against experiment; each reports its disagreements as
findings. Part B of the microfluidics report mixes classes: COMSOL values are
code-to-code, while the siphon, dilution-ratio, and bead-trap outcomes are
compared with measurements.

![Mach number along the Fanno-flow duct: OpenFLUME against the RK4 analytical reference](figures/compressible/fig06-fanno-mach.svg)

_Fanno flow, Mach number along the duct, from the
[compressible-flow report](compressible-report.md)._

![Heat-exchanger effectiveness error against the number of wall segments](figures/thermal/fig08-hx-segmentation.svg)

_Counterflow heat-exchanger segmentation study, from the
[thermal-network report](thermal-network-report.md). The ε–NTU discrepancy
shrinks as the wall is refined._

![Tank pressure during adiabatic blowdown through a choked orifice, solver against RK4 reference](figures/tank/fig03-blowdown-pressure.svg)

_Choked adiabatic blowdown, tank pressure, from the
[tank-transient report](tank-transient-report.md)._

## Code-to-code benchmarks outside the reports

The manual's §8.3 lists further benchmarks, each gated by a test:

| Benchmark | Result (from §8.3) |
| --------- | ------------------ |
| GFSSP Example 13, conduction rod with convection | Solid temperatures within 3.0 K; conduction heat flows within 7 %; energy balance within 0.5 % |
| N₂–N₂ counterflow heat exchanger (JANNAF 2024, Majumdar & LeClair) | Duty within 5 %; outlets within 2.5 K |
| GFSSP Example 5, water-water heat exchanger | Hot outlet 295.67 ± 1.0 K; cold outlet 290.94 ± 0.5 K; duty within 3 % |
| Lee & Martin entrapped air (GFSSP Figure 10) | First peak within 15 %; trace within 8 % of an RK4 rigid column at refined step |
| SINDA/FLUINT Sample Problem F, LH₂ no-vent fill | Fill fraction, pressure, vapor temperature, and vent flow within about 1 % at 15 min |
| NURETH-16 gas-cooled reactor loop | Published trends only; geometry is representative |

See [OpenFLUME vs. GFSSP](../compare/gfssp.md) and
[OpenFLUME vs. SINDA/FLUINT](../compare/sinda-fluint.md) for what these
benchmarks do and do not show.

## Experimental corpora and trust levels

From [§8.4](../user-manual.md#_8-4-validation-against-experiment):

- **NBS Report 9264 cryogenic chilldown** (Brennan et al., 1966). Table 6
  provides eighteen chilldown-time points for saturated and subcooled LH₂ and
  LN₂. Eleven digitized oscillograph figures provide forty-four station traces
  (10 195 samples), rebuilt from source CSVs by `npm run gen:trace-corpus`.
  - **Trusted, calibration-grade:** four saturated runs (sixteen traces).
  - **Diagnostic only:** seven subcooled runs. At coarse axial discretization
    their errors reach +80 %. They may be used to diagnose a problem but may
    not be quoted as agreement.
  - **CI baseline:** computed chilldown time at the instrumented station must
    stay within a factor of 1.6 of experiment, with mean absolute error under
    25 % across the four-case slow suite. Two-phase chilldown energy and
    enthalpy balances close within 10 % and 12 %.
  - Single-phase chilldown surrogates match the plateau-then-plunge shape only.
    They are not comparable on absolute times and are asserted as trends.

A factor-of-1.6 band is a regression guard, not a precision claim. Cryogenic
chilldown is the least mature area of the code.

Three further experimental comparisons have their own reports (above):
critical flow of nitrogen and methane through nozzles and a sharp-edged
orifice (NASA TP-1484, TM X-71760), Hord's liquid-hydrogen venturi
cavitation (NASA CR-2054), and the self-pressurization of a liquid-hydrogen
tank (NASA TM-103804). Their datasets are transcribed into
`src/validation/generated/experimentalData.ts` by
`npm run gen:experimental-data`, with a source hash checked in CI.

The repository carries further digitized datasets under
[`validation/data/digitized/`](../../validation/data/digitized/) that no
report uses yet: Hord's hydrofoil and ogive cavitation series, the other
NASA tank tests (no-vent fill, pressurant injection, vent systems), further
chilldown studies, and two-phase boiling pressure-drop data. The choked-flow
and tank reports state why the ones in their directories were left out.
Treat them as available reference data, not as validation claims.

## Correlation status

Closure correlations are where network codes most often go wrong.
[§8.5](../user-manual.md#_8-5-correlation-status) records the status of each
one. Swamee–Jain and Dittus–Boelter are standard. Miropolskii film boiling is
used as GFSSP uses it for chilldown. Darr–Hartwig is verified structurally
against its published equations, inside an LH₂ / vertical-upflow / 1 g
envelope. TT-WF is **research status, not validated**. A custom expression is
the user's responsibility.

## Result provenance

Every run hashes the configuration that produced it. If the model is edited
after a run, that result is marked **stale**. Exports and sweep CSVs carry
the model name, a solver-settings summary, and the config hash
([§8.7](../user-manual.md#_8-7-result-provenance)).

## Reporting a disagreement

If OpenFLUME disagrees with a reference you trust,
[open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose).
The project treats a well-documented disagreement as one of the most useful
contributions it can receive. The bug-report template asks for:

- the reference value and its source (analytical, published benchmark, or
  experiment);
- the tolerance you consider acceptable;
- units and assumptions;
- the model, as an attached `.fn` file or a pasted JSON config.

New validation cases are welcome too. See
[CONTRIBUTING.md](../../CONTRIBUTING.md). Numerical claims must state their
reference, tolerance, and units. Do not relax tolerances without physical or
numerical justification. Do not submit export-controlled material.
