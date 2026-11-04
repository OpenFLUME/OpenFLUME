---
title: "Cryogenic line chilldown: NBS 9264, film boiling, and what agrees"
description: How OpenFLUME models cryogenic transfer-line chilldown with HEM two-phase flow and Miropolskii film boiling, checked against NBS Report 9264 with stated trust levels.
date: 2026-12-08
author: John Rising
---

# Cryogenic line chilldown: NBS 9264, film boiling, and what agrees

_John Rising · 2026-12-08_

When cryogenic liquid enters a warm transfer line, it boils violently on the wall. The vapor races ahead and pre-cools the line, and a quench front moves downstream until the wall is cold enough to carry liquid. How long that takes, and how much propellant boils off along the way, matters for any cryogenic propulsion or ground system. It is also one of the harder things to ask of a network code. It combines two-phase real-fluid flow, a moving front, strongly temperature-dependent wall properties, and a boiling-heat-transfer correlation, all at once.

This post covers how OpenFLUME models chilldown, what experimental data it is checked against, where it agrees, and where it does not. The quantitative claims come from [user manual §8.4](../user-manual.md#_8-4-validation-against-experiment) and from the source and test files named inline.

## The experiment: NBS Report 9264

In 1966, Brennan, Brentari, Smith, and Steward at the National Bureau of Standards ran chilldown tests on a roughly 200 ft (about 61 m) copper transfer line with liquid hydrogen and liquid nitrogen. They used saturated and subcooled inlets across a range of driving pressures: "Cooldown of Cryogenic Transfer Lines — An Experimental Report," NBS Report 9264. Thermocouple stations sat at 20, 80, 141, and 198 ft from the inlet. Decades later, the GFSSP team used the same data as a benchmark: Majumdar et al., AIAA 2015-3850, Table 6.

OpenFLUME's corpus has two parts, both documented in `src/validation/nbsChilldown.ts` and `src/validation/nbsTraceCorpus.ts`:

- **18 chilldown-time points** from Table 6: saturated and subcooled LH₂ and LN₂. The module header records that all 18 rows were verified digit for digit against the NTRS scan, and the LH₂ rows were cross-checked against an earlier GFSSP paper.
- **44 station traces** digitized from eleven oscillograph figures, 10,195 samples in all, rebuilt from source CSVs by `npm run gen:trace-corpus`.

Table 6 also lists GFSSP's predicted times. The repository keeps them alongside the data as "the published baseline to beat — never treat them as data."

## What "chilldown time" means

This turned out to matter more than I expected. The NBS report is candid about it:

> The question of cooldown time is usually an important one, but, unfortunately, this quantity is not uniquely defined. … For the purposes of this report, cooldown time was defined as the time associated with the low temperature knee in the temperature vs. time curve 60.4 m from the supply dewar.

So the measured number belongs to **station 4**, the last point on the line to chill, and it is read graphically at a knee. OpenFLUME interpolates the wall temperature in space to station 4. It does not snap to the nearest node, because at three or four segments, three of the four stations collapse onto the same solid node. It then takes a smoothly interpolated threshold crossing near the local saturation temperature. Because the definition is graphical, the sensitivity to it is computed and reported rather than hidden: the baseline test sweeps five alternative definitions.

The dataset module also records an earlier mistake. A comparison of a node about 40.6 m down the line against Table 6 had produced a confounded "−27 %…−32 %" error, because an upstream station chills earlier than station 4. Any honest chilldown comparison has to begin with the definition.

## The model

**Two-phase flow is HEM** (homogeneous equilibrium): liquid and vapor share one velocity and are in equilibrium at the local pressure ([§4.2](../user-manual.md#_4-2-equations-of-state)). Inside the saturation dome, temperature stops being an independent coordinate, so the state is evaluated from pressure and enthalpy (`statePH`), and nodal enthalpy is a coupled Newton unknown in the `[P, ṁ, h]` system. That coupling lets a node sit on the saturation line for many steps without oscillating across it. Pipe, orifice, and valve pressure drops use the HEM mixture density and a McAdams mixture viscosity, so the friction factor stays continuous through the dome.

**Wall heat transfer uses Miropolskii film boiling** ([§4.4](../user-manual.md#_4-4-convection-correlations)):

```
Nu = 0.023 [Re_g (x + (ρ_g/ρ_f)(1 − x))]^0.8 · Pr_g^0.4 · Y
Y  = 1 − 0.1 (ρ_f/ρ_g − 1)^0.4 (1 − x)^0.4
```

Vapor properties are taken at saturation, and quality is clamped to [0.01, 0.99] at the dome edges. When a node is single-phase, the correlation falls back to Dittus–Boelter on that state. That fallback is what makes it usable across a chilldown, where nodes pass through the dome. GFSSP uses the same correlation for chilldown. Its status in the correlation table is "As used by GFSSP for chilldown" ([§8.5](../user-manual.md#_8-5-correlation-status)).

**The wall** uses sourced, temperature-dependent material properties. The OFHC copper specific heat falls from about 385 J/(kg·K) at 300 K to about 90 at 80 K, and to order 1 near 20 K. A wall therefore speeds up its own cooldown as it chills, and a constant specific heat materially over-predicts the cold-end time.

## The example you can run

[Cryogenic line cooldown](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown) is the C&R Technologies SINDA/FLUINT validation case drawn from NBS Report 9264, Figure 2 ([§7.11](../user-manual.md#_7-11-cryogenic-line-cooldown)). Saturated liquid hydrogen at 75 psia is admitted to a 61 m copper line with a 15.9 mm inside diameter, initially at 300 K, venting to 0.82 atm. The model has twenty axial segments: 22 fluid nodes, 20 copper wall nodes, 21 pipes, and 20 Miropolskii convection conductors. It runs at a fixed 1 s step.

Open it and click **Run**. In the **Results** tab, plot the wall temperatures against time, or go back to the **Model** tab and scrub through time while the canvas is colored by temperature. The walls chill one after another, from inlet to outlet.

Be clear about what this example's automated test checks. It checks that every wall chills below its 300 K start, that wall 1 ends below 50 K, and that wall 1 chills before wall 20. That is a structural check, not an agreement figure. The example source carries the C&R note that a normal-hydrogen model over-predicts and a para-hydrogen model under-predicts, by about 20 %, with the test data bracketed between them. The example uses normal hydrogen. Ortho/para fraction is one of the unknowns the NBS data cannot pin down.

This is also the clearest demonstration in the app of why axial discretization matters. A coarse version cannot resolve the front at all.

## What agrees

The quantitative comparison runs on the saturated **LN₂** Table-6 points in `src/ui/tests/chilldownBaseline.test.ts`, using a deliberately coarse three-segment line so that it fits in CI:

| Driving pressure | NBS measured | GFSSP predicted |
| ---------------- | ------------ | --------------- |
| 61.74 psia       | 165 s        | 185 s           |
| 74.97 psia       | 150 s        | 160 s           |
| 86.73 psia       | 130 s        | 140 s           |

- **The CI gate** runs on every pull request with one representative case (saturated, 74.97 psia, experiment 150 s). The station-4 time must fall between 0.5× and 1.6× of experiment. The test comment records measured values of about 128–160 s across solver versions. That band is wide on purpose. It catches gross regressions, such as no crossing or a factor-of-two drift, "without pretending the coarse-N model is exact."
- **The full slow suite** runs on `main` and weekly. The test comment records a mean absolute error of 12.8 % across the three saturated LN₂ points at N = 3, and the suite asserts under 25 % as a regression sentinel.
- **Trends** are asserted, not just magnitudes. Chilldown time strictly decreases with driving pressure. At a matched 74.97 psia, subcooling shortens chilldown.
- **Structure.** At four segments, the two-phase model reproduces the shape of the published wall-temperature curves (`chilldownTwoPhase.test.ts`): a plateau and then a plunge at downstream stations, completion gaps that shrink as the front accelerates, a common asymptote near saturation, and downstream steepening. That last feature, a steeper maximum dT/dt at the last station than at the first, is physically impossible in a single-phase gas model, and the test file says so.
- **Conservation.** Two-phase chilldown energy balances close within 10 %, and the subcooled flashing case's global enthalpy balance closes within 12 %.

## What does not agree, and the trust levels

**Subcooled runs.** The trace corpus is split by trust level, and that split is enforced in code. The four saturated runs (sixteen traces) are **trusted** and calibration-grade. The seven subcooled runs are **diagnostic only**: at coarse axial discretization their errors reach +80 %. They can inform a diagnosis, but they may not be quoted as agreement. The corpus validator throws if a subcooled run is not marked that way. In the Table-6 slow suite, the matched subcooled LN₂ point at 74.97 psia comes out at 128.1 s against a measured 100 s. Subcooling shortens the predicted chilldown in the right direction, but the number is well off.

**The single-phase surrogate.** A separate builder models chilldown with cold nitrogen vapor in place of boiling liquid. It reproduces the qualitative plateau-then-plunge structure but is **not** comparable on absolute times, and it is asserted on trends only.

**The experiment's own uncertainty.** The NBS report flags its own low-temperature thermocouple inaccuracies. In some tests, station 3 reads warmer than station 4, which is physically inconsistent for a front moving downstream. The knee is read off oscillograph charts by eye. The initial liquid temperature was not recorded, the copper alloy's heat capacity is uncertain, and later re-analysis identified a ±1 % tube-ID tolerance as a dominant sensitivity. Some of the disagreement belongs to the data.

**Model-form limits.**

- HEM is suited to dispersed, high-mixing, or low-quality flows. It under-predicts pressure drop at high void fraction, and separated-flow multipliers such as Lockhart–Martinelli are not implemented ([§1.7](../user-manual.md#_1-7-scope-boundaries)).
- A single film-boiling correlation is a simplification of GFSSP's regime blending, as the two-phase test file notes.
- Two other chilldown correlations ship with clear labels. Darr–Hartwig is verified structurally against its published equations, with a fitted envelope of LH₂ in vertical upflow at 1 g. Outside that envelope, it is an extrapolation. TT-WF is my own design and is labeled **research status, not validated**.

**Discretization.** The CI comparisons run at three or four segments because finer two-phase grids are expensive. The test file itself calls the quantitative band wide.

## Summary

Here is my honest one-paragraph version. On saturated LN₂ at coarse discretization, OpenFLUME's chilldown time at the NBS definition lands within a mean absolute error recorded at 12.8 %, with the correct pressure trend and the correct curve structure. Subcooled cases are not defensible yet, and they are labeled so they cannot be quoted. The shipped LH₂ example shows the physics but is not an agreement claim.

If you have chilldown data with clear provenance, or a reason to think one of these comparisons is set up wrong, please [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose). I would much rather fix a bad comparison than defend it.
