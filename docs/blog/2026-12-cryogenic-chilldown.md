---
title: "Cryogenic line chilldown: modeling it and checking it against NBS 9264"
description: How OpenFLUME models cryogenic transfer-line chilldown with HEM two-phase flow and Miropolskii film boiling, and how it compares with NBS Report 9264.
date: 2026-12-08
author: John Rising
---

# Cryogenic line chilldown: modeling it and checking it against NBS 9264

_John Rising · 2026-12-08_

Cryogenic liquid entering a warm transfer line boils violently on the wall. The vapor runs ahead and pre-cools the line, and a quench front moves downstream until the wall can carry liquid. The time and boil-off this costs drive cryogenic propulsion and ground-system design. For a network code it is a hard case: two-phase real-fluid flow, a moving front, strongly temperature-dependent wall properties, and a boiling correlation all interact. Quantitative claims below come from [user manual §8.4](../user-manual.md#_8-4-validation-against-experiment) and the files named inline.

## The experiment: NBS Report 9264

In 1966, Brennan, Brentari, Smith, and Steward at the National Bureau of Standards chilled a roughly 200 ft (61 m) copper transfer line with liquid hydrogen and liquid nitrogen, saturated and subcooled, over a range of driving pressures ("Cooldown of Cryogenic Transfer Lines — An Experimental Report," NBS Report 9264). Thermocouple stations sat at 20, 80, 141, and 198 ft from the inlet. The GFSSP team later used the same data as a benchmark (Majumdar et al., AIAA 2015-3850, Table 6).

OpenFLUME's corpus, in `src/validation/nbsChilldown.ts` and `src/validation/nbsTraceCorpus.ts`, has two parts:

- **18 chilldown-time points** from Table 6 (saturated and subcooled LH₂ and LN₂), verified digit for digit against the NTRS scan, with the LH₂ rows cross-checked against an earlier GFSSP paper.
- **44 station traces** digitized from eleven oscillograph figures, 10,195 samples, rebuilt from source CSVs by `npm run gen:trace-corpus`.

Table 6 also lists GFSSP's predicted times, stored next to the data as "the published baseline to beat — never treat them as data."

## Defining chilldown time

From the NBS report:

> The question of cooldown time is usually an important one, but, unfortunately, this quantity is not uniquely defined. … For the purposes of this report, cooldown time was defined as the time associated with the low temperature knee in the temperature vs. time curve 60.4 m from the supply dewar.

The measured number belongs to **station 4**, the last point to chill, read graphically at a knee. OpenFLUME interpolates wall temperature in space to station 4 rather than snapping to the nearest node, since at three or four segments three of the four stations would land on the same solid node. It then takes a smoothly interpolated threshold crossing near the local saturation temperature, and the baseline test sweeps five alternative definitions to report the sensitivity.

An earlier comparison, recorded in the dataset module, used a node about 40.6 m down the line and got a confounded "−27 %…−32 %" error: an upstream station chills earlier than station 4.

## The model

**Two-phase flow is HEM** (homogeneous equilibrium): liquid and vapor share one velocity and are in equilibrium at the local pressure ([§4.2](../user-manual.md#_4-2-equations-of-state)). Inside the dome temperature is not an independent coordinate, so the state comes from pressure and enthalpy (`statePH`), with nodal enthalpy a coupled Newton unknown in the `[P, ṁ, h]` system. A node can then sit on the saturation line for many steps without oscillating across it. Pipe, orifice, and valve pressure drops use the HEM mixture density and a McAdams mixture viscosity, so the friction factor stays continuous through the dome.

**Wall heat transfer uses Miropolskii film boiling** ([§4.4](../user-manual.md#_4-4-convection-correlations)):

```
Nu = 0.023 [Re_g (x + (ρ_g/ρ_f)(1 − x))]^0.8 · Pr_g^0.4 · Y
Y  = 1 − 0.1 (ρ_f/ρ_g − 1)^0.4 (1 − x)^0.4
```

Vapor properties are taken at saturation, and quality is clamped to [0.01, 0.99]. On single-phase nodes it falls back to Dittus–Boelter, so it works through a chilldown as nodes cross the dome. The correlation table lists it as "As used by GFSSP for chilldown" ([§8.5](../user-manual.md#_8-5-correlation-status)).

**The wall** uses sourced, temperature-dependent properties. OFHC copper specific heat falls from about 385 J/(kg·K) at 300 K to about 90 at 80 K, and to order 1 near 20 K, so the wall accelerates its own cooldown. Every wall node exchanges heat with a solved fluid node, as in GFSSP's model of the line: the inlet wall with the first internal node rather than the fixed inlet state, and the two end wall nodes carry half a segment, so the wall's total mass and wetted area are the line's.

## The example you can run

[Cryogenic line cooldown](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown) is the C&R Technologies SINDA/FLUINT validation case drawn from NBS Report 9264, Figure 2 ([§7.11](../user-manual.md#_7-11-cryogenic-line-cooldown)). Saturated liquid hydrogen at 75 psia enters a 61 m copper line (15.9 mm ID) at 300 K, venting to 0.82 atm. Twenty axial segments give 22 fluid nodes, 20 copper wall nodes, 21 pipes, and 20 Miropolskii convection conductors, stepped at a fixed 1 s.

Click **Run**, then plot wall temperatures in the **Results** tab, or scrub through time on the **Model** tab with the canvas colored by temperature. The walls chill in sequence from inlet to outlet; a coarse version of the line cannot resolve the front at all.

The example's automated test is structural: every wall chills below 300 K, wall 1 ends below 50 K, and wall 1 chills before wall 20. The source carries the C&R note that normal-hydrogen and para-hydrogen models bracket the test data, over- and under-predicting by about 20 %. The example uses normal hydrogen; the ortho/para fraction is one of the unknowns the NBS data cannot pin down.

## Agreement on saturated LN₂

`src/ui/tests/chilldownBaseline.test.ts` compares against the saturated **LN₂** Table-6 points on a deliberately coarse three-segment line that fits in CI:

| Driving pressure | NBS measured | GFSSP predicted |
| ---------------- | ------------ | --------------- |
| 61.74 psia       | 165 s        | 185 s           |
| 74.97 psia       | 150 s        | 160 s           |
| 86.73 psia       | 130 s        | 140 s           |

- **CI gate.** Every pull request runs one case (saturated, 74.97 psia, experiment 150 s). The station-4 time must fall within 0.5×–1.6× of experiment; the current value is 129.4 s. The band catches gross regressions, such as a missing crossing or a factor-of-two drift, "without pretending the coarse-N model is exact."
- **Slow suite.** On `main` and weekly, all three points run at N = 3. The recorded mean absolute error is 7.8 % (all three early, by 4–14 %), against 8.8 % for GFSSP's predictions; the suite asserts under 25 % as a regression sentinel.
- **Trends.** Chilldown time strictly decreases with driving pressure. Subcooling does not shorten it at a matched 74.97 psia in this model (149.4 s subcooled against 129.4 s saturated, where the measurement is 100 s against 150 s), so the suite no longer asserts that ordering and the report states the deficiency.
- **Curve shape.** At four segments the two-phase model reproduces the published wall-temperature curves (`chilldownTwoPhase.test.ts`): plateau then plunge downstream, completion gaps that shrink as the front accelerates, a common asymptote near saturation, and downstream steepening. That last feature, a steeper maximum dT/dt at the last station than the first, cannot occur in a single-phase gas model.
- **Conservation.** Two-phase chilldown energy balances close within 10 %, and the subcooled flashing case's global enthalpy balance closes within 12 %.

## Disagreements and trust levels

**Trust levels.** The trace corpus is split by trust level in code, assigned from the experimental record alone. Four subcooled hydrogen runs (Figs. 3, 4, 6, 7) are **diagnostic only**: their cold tails overlap so that they cannot be assigned to stations, or the valve opened before the chart's zero time. The other seven runs (twenty-eight traces) are **trusted**. All eighteen Table-6 rows are solved and reported; their mean absolute error is 19.3 % at N = 3, against 7.6 % for GFSSP. The knee uses one definition for the model and for the digitized traces, and each run starts from the initial wall temperature measured in its traces (271–307 K).

**Subcooled runs.** Subcooled LN₂ is the weakest case: late by 29–57 % at three segments, and it depends on an input GFSSP never published (the knee waits on the outlet node turning liquid, and at the documented 12.05 psia outlet without GFSSP's exit restriction it stays two-phase and the 61.74 psia case goes from +49 % to +102 %). At GFSSP's 30 segments the three subset cases that reach the knee have a mean absolute error of 13.5 %, against 4.6 % for GFSSP; saturated LN₂ is +8.1 % and hydrogen is about 16 % early.

**Single-phase surrogate.** A separate builder replaces the boiling liquid with cold nitrogen vapor. It reproduces the plateau-then-plunge shape but not absolute times, so its tests assert trends only.

**Experimental uncertainty.** The NBS report flags low-temperature thermocouple inaccuracies; in some tests station 3 reads warmer than station 4, impossible for a downstream-moving front. The knee is read off oscillograph charts by eye, the initial liquid temperature was not recorded, the copper alloy's heat capacity is uncertain, and later re-analysis found a ±1 % tube-ID tolerance to be a dominant sensitivity. Part of the disagreement belongs to the data.

**Model form.**

- HEM suits dispersed, high-mixing, or low-quality flows and under-predicts pressure drop at high void fraction; separated-flow multipliers such as Lockhart–Martinelli are not implemented ([§1.7](../user-manual.md#_1-7-scope-boundaries)).
- A single film-boiling correlation simplifies GFSSP's regime blending.
- Two other chilldown correlations ship. Darr–Hartwig is verified structurally against its published equations; its fitted envelope is LH₂ in vertical upflow at 1 g, and anything else is extrapolation. TT-WF is my own design and is labeled **research status, not validated**.

**Discretization.** CI runs three or four segments because finer two-phase grids are expensive, hence the wide band.

## Summary

On a three-segment line OpenFLUME's station-4 chilldown time has a recorded 19.3 % mean absolute error against NBS 9264 over all eighteen Table-6 rows (7.6 % for GFSSP), with the correct pressure trend. At GFSSP's 30 segments saturated LN₂ is within 9 % and three subset cases are at 13.5 % (GFSSP 4.6 %). Subcooled LN₂ depends on an unpublished GFSSP input and cannot be quoted, and the LH₂ example is a physics demonstration only.

If you have chilldown data with clear provenance, or think one of these comparisons is set up wrong, please [open an issue](https://github.com/OpenFLUME/OpenFLUME/issues/new/choose).
