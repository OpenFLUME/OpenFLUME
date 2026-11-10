# MRS thermal-vacuum test data (1973 Shuttle Modular Radiator System)

Data for the OpenFLUME system validation case built on the 1973 Shuttle Modular Radiator System (MRS) thermal-vacuum tests. The comparison set, the exclusions, the modelling choices and the metrics are fixed in `docs/validation/mrs-protocol.md`, which was committed together with these files before any OpenFLUME run.

## Source documents

| Report | NASA number | NTRS id | Use |
| --- | --- | --- | --- |
| LTV Report T169-28 Volume III, Modular Radiator System Test Data Correlation with Thermal Model, M. A. Phillips, 18 December 1973 | NASA CR-140269 | 19740026229 | Main source. Tables 1 to 21, Figures 15 to 33 |
| LTV Report T169-28 Volume II, Modular Radiator System Tests, P. B. Scheps, H. R. Howell and F. E. Voss, 23 October 1973 | NASA CR-140268 | 19740026228 | Test description, Appendix A environment summary, Tables 13 to 15 |
| LTV Report T169-28 Volume VIII, Tube Anomaly Investigation | NASA CR-140275 | 19740026235 | Tube alloy (6063-T42) and tube drawing dimensions |
| NASA Tech Brief B72-10651, Freon 21 Bearing Lubrication and Coolant System | none | 19720000650 | One conductivity cross-check for R21 |

Rights. The NTRS records for 19740026228, 19740026229 and 19740026235 carry the copyright determination `GOV_PUBLIC_USE_PERMITTED`, distribution `PUBLIC`, no third-party content and export control `NO`. This was read from the NTRS API record of each report. The numbers in these files are facts transcribed from the reports and the files do not reproduce the report pages.

Page references below use the printed page numbers of Volume III. The PDF page is the printed page plus 7.

## Files

| File | Content |
| --- | --- |
| `mrs_test_point_registry.csv` | Machine-readable registry. One row per test point with configuration, leg order, set (primary, secondary or excluded) and the reason, sides, inlet, total flow, leg flows, leg fractions used, absorbed flux per panel and sources |
| `mrs_table1_panel_geometry.csv` | Volume III Table 1 (p. 17), tube lengths and areas |
| `mrs_table2_correlation_points.csv` | Volume III Table 2 (p. 18) as printed, with transcription notes |
| `mrs_panel_outlets_figs15_33.csv` | Panel main outlet temperature from the temperature maps of Figures 15 to 33 (pp. 52 to 70), test and 1973 model, with panel pressure drop |
| `mrs_system_outlets_figs15_33.csv` | Leg flows and system main, prime and mixed outlet temperatures from the same maps |
| `mrs_heat_rejection_tables3_20.csv` | Volume III Tables 3 to 20 (pp. 19 to 36), prime, main and total panel heat, test and 1973 model. Context only, see below |
| `mrs_heat_rejection_tables3_20_two_reads.csv` | Agreement of the two independent reads of Tables 3 to 20 for each number |
| `mrs_table21_dp_errors_context.csv` | Volume III Table 21 (p. 37), pressure drop errors. Context only, no pressure drop claim is made |
| `mrs_r21_transport_table.csv` | R21 density, specific heat, enthalpy, viscosity and conductivity from -95 to 220 F at 1.5 MPa. Computed, not measured |
| `mrs_hand_calc_results.csv` and `mrs_hand_calc_results_system.csv` | Output of `scripts/reference/mrs_hand_calc.py`. Computed output, not test data |

Temperatures are in degrees Fahrenheit, flows in pound mass per hour, absorbed flux in Btu per hour square foot, and heat in Btu per hour, as printed.

## Transcription method

The report is a scan of a typed report with poor print quality, and the text layer from NTRS is not usable for tables. Every number was read twice and independently.

1. Read A is a visual read of 200 dpi page images, done by an agent looking at each table and map.
2. Read B is Tesseract OCR of 300 dpi images of the same pages.

Tables 3 to 20 hold 876 numbers. The two reads agree on 784. In 57 cases the OCR row was not usable and in 35 cases the reads differ. Read A was kept after the differences were examined by eye against the page, and 29 numbers carry the flag `uncertain` in `mrs_heat_rejection_tables3_20_two_reads.csv`. Each table row was also checked for prime plus main equal to total, and the check column in `mrs_heat_rejection_tables3_20.csv` shows the residual. The panel outlet temperatures on the maps used in the scoring were read once visually on 220 dpi images. Each of the 208 numbers was then searched for in a second OCR pass on 300 dpi images of the map page. The OCR confirmed 190. The other 18 were checked again on the page image in this work and all agree with the transcription except where noted. The exception is the TP45 map, which prints poorly. Its five unconfirmed values (model panels 1, 2, 5, 6 and test panel 1) rest on a single read of a 400 dpi crop. TP45 is a secondary point and does not enter the primary statistics.

The maps print the boundary conditions of the 1973 model as the underlined number and the test value in parentheses. They differ at some points. The model inlet and total flow were 176.3 F and 1094 lb/hr against test 178.3 F and 1094 at TP1A, 163.0 F and 1856.4 against 163.7 and 1950 at TP54, 163.1 F and 1643.6 against 164.6 and 1727 at TP55, 163.0 F and 986.6 against 163.4 and 957 at TP56, and 163.0 F and 1867.5 against 162.6 and 1975 at TP59. Model and test leg flows also differ at every gamma point. The 1973 predictions are therefore not computed at exactly the test boundary conditions, and the OpenFLUME and hand calculation runs use the test values. These values are in `mrs_system_outlets_figs15_33.csv`.

The maps of the low-load points TP17, 17A, 36 and 47 were not transcribed. They are excluded from the case.

## Test point registry columns

`test_point`, `configuration`, `legs` (series chains separated by semicolons, panel numbers joined by hyphens), `set`, `set_reason`, `load`, `environment`, `sides_radiating`, `sides_source`, `Tin_main_F`, `Tin_source`, `total_main_flow_lbhr`, `total_flow_source`, `leg_flow_test_lbhr`, `leg_flow_1973model_lbhr`, `leg_fraction_used`, `leg_fraction_source`, `absorbed_panel1_Btuhr_ft2` to `absorbed_panel8_Btuhr_ft2`, `absorbed_source`, `Tmix_main_test_F`, `Tmix_main_1973model_F`, `n_panel_outlets_test`.

Panel order within a leg is the order of flow. The leg orders are alpha 1-3-4-2 and 5-7-8-6, gamma 1-3, 2-4, 5-7 and 6-8, epsilon eight single panels, half-alpha 1-3-4-7. Beta (TP17A, excluded) is two legs of two panels, then four panels, then two, and its map was not transcribed, so the legs column is empty.

## Data defects and how each is handled

| Defect | Handling |
| --- | --- |
| TP51 sides. Volume III Table 2 prints 1 and Volume II Table 14 lists TP51 under two-sided radiation | Two-sided, fixed in the protocol. The one-sided reading is run as a sensitivity |
| TP56 per-panel test heats in Volume III sum to more than the system total | Excluded from the primary set |
| TP59 environment in Table 2 repeats TP54 | Volume II Appendix A page A-3 values are used and were read from the page image |
| TP45 main inlet prints 150.8 in Table 2, 160.8 on the Figure 16 map and 161.1 in Volume II Table 15. Energy balance supports about 161 | 160.8, secondary point only |
| Leg flows in the maps exceed the printed total by 3 to 14 percent | Measured leg flows are normalised to unit sum and scaled to the printed total, as the 1973 correlation did |
| TP55 test flow of leg 6 and 8 is not printed and the model value 292.5 is a misprint | Model leg fractions are used, with 416.6 implied by the printed total |
| TP54, 55, 56, 59 inlet and flow blank in Table 2 | Taken from the Figure 26 to 29 test values. Volume II Table 14 agrees |
| TP4 panel 6 environment prints 139.5 in Table 2 and 139.4 in Appendix A | 139.5 as in Table 2. The difference is immaterial |
| TP32, TP36, TP45 and TP55 table typos found in the prime-plus-main-equals-total check of Tables 3 to 20 | Those tables are context only. Scoring uses the temperature maps and the enthalpy balance and not the printed heats |
| TP27 connector offset | A connector offset is mentioned in the hand-over notes for this case. It is not present in the transcription files and no correction was applied. The Table 2 values for TP27 agree with the map inlet and flow |
| Tables 3 to 20 test heats disagree with the enthalpy balance of the measured temperatures by up to 8 percent because of the leg flow inconsistency | The bank heat metric is computed from measured temperatures with the same enthalpy function |
| Panel pressure drop is dominated by unpublished per-tube orifices | No hydraulic claim. Table 21 is context only |

## R21 transport source

CoolProp 8.0.0 provides R21 density, specific heat and enthalpy from the equation of state of Platzer, Polt and Maurer (1990, Helmholtz form, validity 200 to 473 K). It does not provide viscosity or conductivity. The repository wasm build is the same. No published table of Freon-21 liquid viscosity and conductivity could be retrieved from open sources for this work. DuPont's Freon 21 bulletin, the ASHRAE refrigerant tables, Yaws and Perry's were not reachable, and the 1973 Shuttle reports (Volumes I to VIII) contain no property tables. The NIST/TRC Web Thermo Tables list evaluated R21 viscosity (46 data points) and conductivity (152 liquid data points) but the data themselves are behind a subscription.

The most authoritative reachable source is the transport block of the REFPROP fluid file `R21.FLD` (transport added by M. L. Huber, 2010). It holds an Extended Corresponding States model with R134a as the reference fluid, after Huber, Laesecke and Perkins, Industrial and Engineering Chemistry Research 42, 3163 (2003). The block was read from copies of the file in public GitHub repositories (two distinct file versions were found and the transport blocks are identical, REFPROP version number 8.0). The file states

- viscosity data from Phillips and Murphy, Journal of Chemical and Engineering Data 15(2), 304 (1970), estimated uncertainty for saturated liquid viscosity 5 percent
- thermal conductivity data from Tauscher, Kaltetechnik 19(9), 288 (1967) and Djalalian, Bulletin of the International Institute of Refrigeration, Annex 1964-2, 153, estimated uncertainty for saturated liquid thermal conductivity 5 percent
- Lennard-Jones parameters estimated by the method of Chung
- fit to limited data, range 200 to 473.19 K, 137.9 MPa

Verbatim parameters of the block.

```
FEQ R134a.fld        reference fluid
VS1                  model for reference fluid viscosity
TC1                  model for reference fluid thermal conductivity
1                    Lennard-Jones flag (0 or 1)
0.4697               Lennard-Jones sigma [nm]
358.60               Lennard-Jones epsilon/kappa [K]
1  0  0              number of terms in f_int term in Eucken correlation
 1.3200d-3  0.0 0.0 0.0     coeff, power of T
3  0  0              number of terms in psi (viscosity shape factor)
 1.99918    0.0 0.0 0.0     coeff, power of Tr, power of Dr
-0.688312   0.0 1.0 0.0
 0.113652   0.0 2.0 0.0
2  0  0              number of terms in phi (thermal conductivity shape factor)
 1.03377    0.0 0.0 0.0
-2.23145d-2 0.0 1.0 0.0
TK3                  critical enhancement (Olchowy and Sengers), not important in the liquid at these states
```

`scripts/reference/mrs_r21_transport_table.py` maps these parameters onto the CoolProp ECS schema (the same machinery CoolProp uses for R22), registers a copy of the CoolProp R21 fluid with that transport block and writes `mrs_r21_transport_table.csv`. This reproduces the REFPROP model only to the extent that CoolProp implements the same ECS equations. It was not compared with REFPROP output because no REFPROP licence was available. Treat the values as a documented estimate with an uncertainty of about 5 percent plus the unquantified implementation difference.

Selected values at 1.5 MPa.

| T (F) | density (kg/m3) | cp (J/kg-K) | viscosity (mPa s) | conductivity (W/m-K) |
| --- | --- | --- | --- | --- |
| -60 | 1537.6 | 929.7 | 0.733 | 0.1288 |
| -40 | 1514.6 | 919.2 | 0.627 | 0.1244 |
| 0 | 1467.6 | 964.9 | 0.480 | 0.1159 |
| 77 | 1371.1 | 1049 | 0.324 | 0.1006 |
| 100 | 1340.0 | 1069.5 | 0.294 | 0.0963 |
| 150 | 1266.8 | 1106.7 | 0.242 | 0.0869 |
| 200 | 1182.3 | 1163.1 | 0.200 | 0.0775 |

Cross-checks that were possible.

- The viscosity at 20 C is 0.337 mPa s. The earlier hand calculation anchored viscosity at 0.34 mPa s at 20 C, so the two agree to 1 percent.
- A NASA Tech Brief (B72-10651) gives the liquid conductivity at 77 F as 0.063 Btu per hour foot F (26.02e-5 cal per second centimetre C at 25 C), which is 0.109 W per metre per kelvin. The model value is 0.1006, so the Tech Brief is 8 percent higher. This is outside the stated 5 percent model uncertainty and is the reason the protocol uses a 15 percent conductivity sensitivity.
- The viscosity and conductivity are used only in the fluid-side Nusselt number through Re = 4 mdot / (pi D mu) and h = Nu k / D. The sensitivity of the result to viscosity plus and minus 25 percent and conductivity plus and minus 15 percent is reported with the results.

## OpenFLUME results

The OpenFLUME results are not stored here. They are computed by `scripts/mrs-validation-report.ts` (through `scripts/mrs-validation-run.ts`) from the model in `src/validation/mrsRadiator.ts` and written into `docs/validation/mrs-report.md`.

## Hand calculation

`scripts/reference/mrs_hand_calc.py` is the independent first-principles comparator. It reads the registry, the panel outlet file and the transport table, uses CoolProp for R21 density, specific heat and enthalpy, and does not use OpenFLUME. Install with `pip install -r scripts/reference/requirements-mrs.txt` and run `python scripts/reference/mrs_hand_calc.py --set all --out validation/data/digitized/mrs/mrs_hand_calc_results.csv`. The run takes about 30 seconds. `mrs_hand_calc_results.csv` and `mrs_hand_calc_results_system.csv` are computed output and are labelled by the `set` column.
