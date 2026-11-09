# MRS thermal-vacuum validation protocol (pre-registered)

This file fixes the comparison set, the exclusions, the modelling choices and the metrics for the Modular Radiator System (MRS) system case before any OpenFLUME run. It is committed together with the data. Nothing in it is changed after the first OpenFLUME result is seen. If a later change cannot be avoided it is recorded in a dated amendment at the end of this file and reported alongside the results.

## Scope

The case is a thermal-network system case. It checks conduction in the fins, radiation to a sink, convection to the fluid and the series and parallel bookkeeping of imposed leg flows through eight panels. It makes no hydraulic claim. Panel pressure drop in the test is dominated by unpublished per-tube orifices, so pressure drop is neither modelled nor compared.

No parameter is tuned to the test data. Every input below comes from the reports, from a cited property source or from a stated engineering choice made before the run.

## Source

| Item | Value |
| --- | --- |
| Test report | LTV Aerospace, Vought Systems Division, Report T169-28, Shuttle Active Thermal Control System Development Testing, Volume III, Modular Radiator System Test Data Correlation with Thermal Model, 18 December 1973 |
| Author | M. A. Phillips |
| NASA number | NASA CR-140269 (confirmed in the NTRS record) |
| NTRS id | 19740026229 |
| Test description | Volume II, NASA CR-140268, NTRS 19740026228 (Scheps, Howell, Voss, 23 October 1973) |
| Tube anomaly report | Volume VIII, NASA CR-140275, NTRS 19740026235 |
| Rights | NTRS copyright determination GOV_PUBLIC_USE_PERMITTED, distribution PUBLIC, no third-party material, export control NO, for all three records |

## The system

Eight flat panels, each 6 ft by 12 ft. Each panel has 12 extruded aluminum tubes in a U pattern. The innermost tube is the prime tube and the other eleven are the main tubes. The main tubes have lengths of 3, 5, 7 and so on up to 23 ft (143 ft in total), inside diameter 0.125 in and wall 0.033 in. The tubes are welded to 0.020 in aluminum sheet on 6.0 in centres. The coolant is Freon-21 (R21). The panels are coupled in series and parallel by the plumbing configuration of each test point, and a ground cart imposes the flows. Radiation goes to a simulated environment and the sink is taken as -280 F. Absorbed infrared flux per panel is given in Table 2 of Volume III and is derived by the test laboratory.

## Prime tube and mixed outlet

The 1973 model has two separate models with no thermal connection between them. At high load about 99 percent of the flow goes through the main bank and essentially all of the panel heat rejection comes from the main tubes. The main bank is represented by one tube (tube 6) with a factor of 11. The prime tube is a separate circuit that matters only at low load. The report states that its prediction is poor because it ignores heat exchange with the neighbouring hot main tube, and that it has a negligible effect on total heat at high load. This case follows the report and models the main bank only. Panel outlet temperatures are main outlet temperatures. The system mixed main outlet is the flow-weighted enthalpy mixture of the leg end main temperatures. The system outlet that mixes main and prime flow is not scored.

## Test points

### Primary comparison set (11 points)

The primary set is the high-load points used by the prior independent hand calculation, less TP56.

| Test point | Configuration | Sides | Environment | Panels with a test outlet |
| --- | --- | --- | --- | --- |
| 1A | alpha | 1 | hot | 8 |
| 4 | alpha | 1 | hot | 8 |
| 32 | gamma | 1 | hot | 8 |
| 10 | half-alpha | 1 | cold | 4 |
| 51 | gamma | 2 | cold | 8 |
| 49 | gamma | 1 | skewed | 8 |
| 53 | gamma | 2 | skewed | 8 |
| 54 | gamma | 2 | skewed | 8 |
| 55 | gamma | 2 | skewed | 8 |
| 59 | gamma | 2 | skewed | 8 |
| 27 | gamma | 2 | skewed | 8 |

This gives 84 panel outlet temperatures. The prior calculation also used TP56, which gives 92. The 1973 model RMS of 4.6 F quoted for the prior set refers to those 92 outlets.

### Exclusions fixed before any OpenFLUME run

| Test point | Treatment | Reason, independent of any model result |
| --- | --- | --- |
| 56 | excluded | Per-panel test heats in Volume III exceed the system total, so the test data are internally inconsistent. Reported for reference only. |
| 17, 17A, 36, 47 | excluded and not run | Low load frozen-tube regime. The main tubes are partly stagnant, the 1973 model itself calls its low-load prediction unreliable, and the maps were not transcribed. |
| 14 | secondary, reported separately | Low load skewed, also in the frozen-tube regime. Reported as a limitation. |
| 45 | secondary, reported separately | Inlet temperature is ambiguous and only four of eight panels have a test outlet. |

Secondary points do not enter any primary statistic.

## Data decisions

| Item | Decision | Basis |
| --- | --- | --- |
| TP51 sides | Two-sided, effective area factor as for the other two-sided points | Volume II Table 14 lists TP51 under the two-sided set point changes. Volume III Table 2 prints 1. |
| TP59 environment | Volume II Appendix A values 129.3, 128.7, 124.9, 124.1, 17.3, 18.7, 11.1, 11.1 Btu per hour square foot | The Table 2 row for TP59 repeats the TP54 row. Appendix A page A-3 was read from the page image. |
| TP54, 55, 56, 59 inlet and flow | Test values printed on the Figure 26 to 29 maps | Table 2 leaves them blank. Volume II Table 14 agrees. |
| TP45 inlet | 160.8 F | Figure 16 map and energy balance. Table 2 prints 150.8 and Volume II Table 15 prints 161.1. Secondary point only. |
| Leg flows | Measured leg flows normalised to unit sum, multiplied by the printed total main flow | Leg flows in the report exceed the printed total by 3 to 14 percent. The 1973 correlation used total flow times leg fraction. |
| TP55 leg fractions | The 1973 model leg fractions | The test flow of the fourth leg is not printed. The model flow 292.5 printed for leg 6 and 8 is a misprint and 416.6 follows from the printed total. |
| TP27 | Table 2 values as printed | No correction is applied. The map inlet and total flow agree with the table. |
| Transcription typos | Values flagged uncertain in the two-read files are not used as inputs | See the README in the data directory. |

## Modelling choices fixed before the run

| Item | Choice |
| --- | --- |
| Geometry | Tube lengths 3 to 23 ft in steps of 2 ft, inside diameter 0.125 in, outside diameter 0.191 in, sheet 0.020 in, pitch 6.0 in. Each tube owns a fin strip one pitch wide, which tiles the panel area with no overlap. The strip is the tube crown plus two fins of half width pitch/2 - OD/2. |
| Flow split in a panel | Equal across the 11 main tubes. A split proportional to tube length is reported as a sensitivity only. |
| Leg flow | Imposed. Each leg has flow equal to registry total times leg fraction. |
| Fin and tube material | Aluminum 6063 as for the extruded tube in Volume VIII. The sheet alloy is not stated and is taken as the same. Conductivity 201 W per metre per kelvin, constant, from the NIST cryogenic database fit for 6063-T5 evaluated at 295 K. The fit is flat within 1.5 percent from 200 to 295 K and is held constant above its range. The temper of the test panels is T42 for the tube and unstated for the sheet. A fin conductivity change of 15 percent is a sensitivity. |
| Emissivity | 0.90 on every radiating surface. The coating emissivity quoted in Volume II is 0.865 to 0.89 corrected hemispherical and 0.90 as adopted by the test laboratory. |
| Sink | -280 F (116.5 K), a pure sink with no reflection. |
| Two-sided panels | The panel radiates from its exposed side with area factor 1 and from the cavity side with effective area factor 0.67, so the total effective area is 1.67 times the panel area. This reading of "0.67 times the panel area" follows the 1973 model and is based on analysis only in the report, so it verifies the model but not a flight configuration. Table 2 absorbed flux is taken as total absorbed flux per unit panel area. The factor is a sensitivity at 1.5 and 1.8. |
| Absorbed flux | Table 2 value for the panel, uniform over the panel, applied per unit panel area, with the tube crown included. |
| Tube wall | Radial conduction through the 0.033 in wall and axial conduction along the wall are included in the OpenFLUME network. The hand calculation treats the wall as isothermal and neglects axial conduction. The expected difference is below 0.1 F. |
| Fluid-side convection | Laminar Nusselt number 3.66 up to a Reynolds number of 2300, Gnielinski (1995, Petukhov friction factor) from 4000, and a linear blend in Reynolds number between 2300 and 4000. The Gnielinski form is Nu = (f/8)(Re - 1000)Pr / (1 + 12.7 sqrt(f/8)(Pr^(2/3) - 1)) with f = (0.79 ln Re - 1.64)^-2. Entrance effects are neglected. |
| Why 3.66 | The aluminum wall conducts well around its circumference, so the wall temperature is nearly uniform around the tube, which is the constant wall temperature condition. Heat flux varies along the tube because the fluid cools, so a constant flux value is not appropriate. The value 4.36 is a sensitivity. In the primary set the Reynolds number spans about 1500 to 11700 and drops into the transition range at the cold end of several legs, so this choice is not negligible and is reported. |
| Fluid properties | Density, specific heat and enthalpy from the CoolProp 8.0.0 R21 equation of state at 1.5 MPa. The loop pressure is not published and the liquid properties change by under 0.5 percent between 1 and 2 MPa. Viscosity and conductivity from the R21 transport model described below. |
| Enthalpy function | The CoolProp R21 enthalpy at 1.5 MPa is used for every heat and mixing calculation, for the model and for the test temperatures alike. |
| Segments per tube | 8 in the baseline, with 4 and 16 as convergence checks. |
| Fin nodes | Five across the half fin in the baseline, with three and eight as checks. |

## Fluid property source

CoolProp 8.0.0 gives R21 density, specific heat and enthalpy but no viscosity or conductivity. No published table of Freon-21 liquid transport properties could be retrieved from open sources, and the 1973 reports contain none. The most authoritative source reachable is the transport model in the REFPROP fluid file R21.FLD by Huber (2010), which is a viscosity and thermal conductivity model of the extended corresponding states form of Huber, Laesecke and Perkins (Industrial and Engineering Chemistry Research 42, 3163, 2003) with R134a as the reference fluid. The file states an estimated uncertainty of 5 percent for the saturated liquid viscosity and 5 percent for the saturated liquid thermal conductivity. The viscosity was fitted to Phillips and Murphy, Journal of Chemical and Engineering Data 15, 304 (1970). The conductivity was fitted to Tauscher, Kaltetechnik 19, 288 (1967) and Djalalian, Bulletin of the International Institute of Refrigeration, Annex 1964-2, 153. The parameters are in the data README and are evaluated with the CoolProp extended corresponding states code, which is already used for other refrigerants such as R22. The resulting table is committed as mrs_r21_transport_table.csv with the script that builds it.

Cross-checks. The viscosity at 20 C is 0.337 cP, which agrees with the 0.34 cP anchor used in the earlier hand calculation. The conductivity at 25 C is 0.1006 W per metre per kelvin (0.0582 Btu per hour foot F). A NASA Tech Brief (B72-10651, NTRS 19720000650) quotes 0.063 Btu per hour foot F at 77 F, which is 8 percent higher. That is outside the 5 percent model uncertainty, so the conductivity sensitivity is set at 15 percent and covers both. Viscosity is varied by 25 percent.

## Metrics

All statistics are over the primary set only, and each is reported with its sample size n.

1. Panel outlet temperature error, calculated minus test, in F. RMS, maximum absolute value and mean (bias) over all primary panel outlets that have a test value, n = 84.
2. The same statistics for the 1973 model, from its tabulated predictions, on the same 84 outlets.
3. System mixed main outlet error in F. The calculated flow-weighted enthalpy mixture of the leg end temperatures minus the printed test value of the main outlet temperature on the map, n = 11. The 1973 model is scored the same way. The mixture recomputed from the measured leg end temperatures is reported as a consistency check.
4. Bank heat error in percent per test point. The heat of the bank is the sum over legs of leg flow times the enthalpy drop between the main inlet and the leg end. The test value uses measured leg end temperatures and the same flows and enthalpy function. The error is 100 times (calculated divided by test minus 1). Reported as per-point values with RMS, maximum and mean, n = 11. The 1973 model is scored the same way from its leg end temperatures. The report tables of test heat are not used as the reference because they disagree with the enthalpy balance by up to 8 percent through the leg flow inconsistency.

## Comparators

1. The 1973 model, as tabulated on the correlation maps of Volume III.
2. The independent first-principles hand calculation in scripts/reference/mrs_hand_calc.py. It shares the choices above and does not use OpenFLUME. The hand calculation is not used to tune anything, and it is run before any OpenFLUME result for the primary set. An earlier version of the hand calculation used assumed viscosity and conductivity correlations and a fin conductivity of 167 W per metre per kelvin, and gave a different result. That earlier version is not the comparator.

## Sensitivities (reported, not scored)

Segments per tube 4, 8, 16. Fin nodes 3, 5, 8. Viscosity plus and minus 25 percent. Conductivity plus and minus 15 percent. Absorbed flux plus and minus 5 percent. Emissivity plus and minus 0.02. Fin conductivity plus and minus 15 percent. Tube split in proportion to tube length. Laminar Nusselt number 4.36. Two-sided area factor 1.5 and 1.8. TP51 as printed (one side).

## Limits of the case

The case does not validate pressure drop or flow split. The flows are imposed. The 1973 model fin effectiveness of 0.90 is replaced by a resolved fin, so the comparison with the 1973 model is a comparison of two modelling approaches and not of identical models. The tabulated 1973 predictions for TP1A, TP54, TP55, TP56 and TP59 were computed at model inlet temperatures and total flows that differ from the test values by up to 2 F and 6 percent, so they are not at exactly the same boundary conditions as the runs here. The test temperatures are read from printed maps to the printed precision, which is 1 F for many of them. The absorbed fluxes are derived by the test laboratory and carry an uncertainty that the report does not state. The two-sided configuration rests on a factor from analysis. The low-load frozen-tube regime is outside the scope.

## Primary traces for the report (2026-11-09)

This case is a high-level system test of the tool, not a research campaign, so the report scores two points and not the full set of eleven. They are chosen, on cost alone and not on any result, as the cheapest high-load in-registry non-excluded points that contain a series chain of at least two panels. Test points 1A and 54 both have eight panels and are the two cheapest of the primary set that qualify. TP1A is the alpha configuration with two series chains of four panels (1-3-4-2 and 5-7-8-6), one-sided and hot, so the trace shows the temperature falling over four panels from about 140 F to 98 F. TP54 is the gamma configuration with four series chains of two panels, two-sided and skewed, and gives a second chain with a much larger temperature drop (the 1973 model RMS error on its eight outlets is 5.0 F, against 1.8 F for TP1A). TP10 has a single chain of four panels but fewer test outlets and is not chosen. The remaining primary points are not run in the report. The modelling choices above are unchanged. The discretization check (4 and 16 segments) and the sensitivity block (viscosity, conductivity, absorbed flux, emissivity) are limited to these points and to the cheapest point respectively.

## Amendments

2026-11-09. Wording correction in the paragraph on the primary traces, made after the 4 and 8 segment OpenFLUME runs had been looked at, and based only on the tabulated 1973 model values in the registry. The first version said TP54 had the largest 1973 model error of the cheap points, which is not so (TP55 and TP59 are larger). No modelling choice or comparison set was changed.

2026-11-09. The hand calculation marches at 96 segments per tube instead of 24, because its explicit march converges from below and 24 segments leave 0.3 F on one tube. This is a numerical convergence correction of the comparator, made after earlier OpenFLUME runs existed, and no physical input changed. The committed hand calculation output is the 96 segment run.

2026-11-09. Correction to the paragraph on the primary traces. It said the two points were chosen before any OpenFLUME run. That is not so. The comparison set, exclusions, modelling choices and metrics were fixed before any OpenFLUME run, but an earlier campaign had run the model on the primary points, including TP1A and TP54, before the two points were selected, and part of that campaign was discarded and rerun after a correction to the model. The selection rests on cost (panel count and the presence of a series chain), which does not depend on those results. No modelling choice or comparison set was changed.
