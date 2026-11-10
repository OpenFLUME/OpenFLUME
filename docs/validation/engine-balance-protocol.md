# A-1 stage engine balance protocol (pre-registered)

This file fixes the data, the imposed inputs, the unknowns, the free parameter of the outer balance, the metrics and the expected tolerances for the NASA SP-125 A-1 stage engine balance case. It is committed before any OpenFLUME run. Nothing in it is changed after the first OpenFLUME result is seen. If a later change cannot be avoided it is recorded in a dated amendment at the end of this file and reported alongside the results.

## What before any run means

No OpenFLUME solver call of any kind has been made for this case at the time of this commit. That includes feasibility checks and smoke tests of the junction, the throat, the pump or the turbine restriction. The network builder and the report script do not exist yet. What has been done is the following. The SP-125 pages were read and the printed values below were checked against the page images. Arithmetic on the printed values was done by hand to test the internal consistency of the book (it is quoted below). A NASA CEA run made earlier outside this repository, for a survey and not for this model, gave a chamber c* about 2 percent different from the book's 5660 ft/s, and that informs the expected tolerance on c*. The code of the components was read but not run.

## Scope

The case is a code-to-code balance against a published design example, solved in nested form. It is not a measured validation, because SP-125 describes a hypothetical engine whose numbers are design values. It checks that OpenFLUME can carry a gas-generator-cycle pressure budget and pump-turbine power balance with the components that exist today. It does not check any turbomachinery physics, because OpenFLUME has no turbine component, no shaft speed unknown and no pump map.

Because the effective area of every restriction is sized from the book's own design-point flow and pressure drop, the network reproduces the book's flows and station pressures at the design point by construction. The quantities that are not set by construction are the following. The main chamber pressure and c* come from the CEA table of the reacting junction. The flow shifts that follow from a chamber pressure that differs from the book come from the pump curve shape through the design point. The turbine power comes from the solved flow and pressure ratio and the book's efficiency. The shaft speed that closes the power balance comes from the pump affinity scaling. The report says this plainly and gives the comparison table with the book numbers that are in effect reproduced by sizing marked as such.

## Source

| Item | Value |
| --- | --- |
| Book | Huzel, D. K. and Huang, D. H., Design of Liquid-Propellant Rocket Engines, NASA SP-125, second edition, 1971 |
| NTRS id | 19710019929 |
| Pages used | Table 3-2 and Figure 3-1 (printed pages 65 and 66), Table 6-4 and equation 6-18 (page 197), equations 6-19 and Sample Calculation 6-5 (pages 198 and 199), Sample Calculations 6-4 and 6-6 (pages 195, 196 and 201), the pump calibration text (pages 202 and 203) |
| Rights | NASA publication, public domain in the United States |

## Data

All values are read from the page images. The SI conversions are 0.45359237 kg per lb, 6894.757 Pa per psi, 0.3048 m per ft, 1 Btu = 1055.056 J and 1 hp = 550 ft lbf per s.

| Quantity | Value | Where |
| --- | --- | --- |
| Thrust chamber injector end pressure | 1095 psia | Table 3-2, p. 65 |
| Nozzle stagnation pressure Pc | 1000 psia | Table 3-2 |
| Thrust chamber oxidizer and fuel flow | 1941 and 827 lb/s, O/F 2.35 | Table 3-2 |
| c* and c* efficiency | 5660 ft/s and 97.5 percent | Table 3-2 |
| Throat area | 487 in2 | Table 3-2 |
| LOX density, RP-1 density | 71.38 and 50.45 lb/ft3 | Table 3-2, Figure 3-1 |
| Oxidizer side drops | injector 200, torus dome 150, line 25, main valve 35 psi | Table 3-2 |
| LOX pump | inlet 55 psia, discharge 1505 psia, head 2930 ft, flow 1971 lb/s, 14850 bhp, 70.7 percent, 7000 rpm | Table 3-2 |
| Heat exchanger | 3 lb/s, listed on the oxidizer side | Table 3-2 |
| Fuel side drops | injector 200, jacket and manifold 290, calibration orifice 110, main valve 15, line 10 psi | Table 3-2 |
| Fuel pump | inlet 45 psia, discharge 1720 psia, head 4790 ft, flow 892 lb/s, 11790 bhp, 65.8 percent, 7000 rpm | Table 3-2 |
| Turbine | inlet 640 psia, 1400 F, pressure ratio 23.7, flow 92 lb/s, 27140 bhp, 58.2 percent, 7000 rpm, torque 20380 | Table 3-2 |
| Turbine exhaust pressure | 27 psia | Figure 3-1 and Sample Calculation 6-5 |
| Auxiliary drive | 500 bhp | Table 3-2 |
| Gas generator oxidizer side | flow 26.7 lb/s, entrance loss 25, line 25, control orifice 615, valve 10, injector 120 psi | Table 3-2 |
| Gas generator fuel side | flow 65.3 lb/s, entrance loss 25, line 25, control orifice 800, valve 20, injector 140 psi | Table 3-2 |
| Gas generator | O/F 0.408, injector end pressure 710 psia, combustor pressure drop 70 psi | Table 3-2 |
| Turbine gas at 1400 F | cp 0.653 Btu/lb F, gamma 1.124, R 53.6 ft lbf/lb R, O/F 0.408 | Table 6-4, p. 197 |
| Turbine gas total temperature | 1860 R | Sample Calculation 6-5, p. 199 |
| Available energy | 359 Btu/lb by equation 6-18, efficiency by equation 6-19 | Sample Calculation 6-5 |

Observations on the book, made by hand before any run and used as comparison floors.

1. Both main-side pressure budgets and both gas-generator budgets close exactly in psi. LOX is 1505 - 25 - 35 - 150 - 200 = 1095. Fuel is 1720 - 10 - 15 - 110 - 290 - 200 = 1095. Gas generator LOX is 1505 - 25 - 25 - 615 - 10 - 120 = 710. Gas generator fuel is 1720 - 25 - 25 - 800 - 20 - 140 = 710. The turbine inlet is 710 - 70 = 640, and 640 / 27 = 23.7.
2. The flows close within rounding. The thrust chamber plus gas generator oxidizer is 1941 + 26.7 = 1967.7 lb/s and the heat exchanger flow of 3 lb/s gives 1970.7, against a LOX pump flow of 1971. Fuel is 827 + 65.3 = 892.3 against 892. The gas generator flow 26.7 + 65.3 = 92 equals the turbine flow, and its O/F is 0.409 against the printed 0.408.
3. Pump heads from the printed pressures are 1450 psi times 144 over 71.38 = 2925 ft for LOX (printed 2930, 0.2 percent) and 1675 psi times 144 over 50.45 = 4781 ft for fuel (printed 4790, 0.2 percent). Pump power from flow, rise and efficiency is 14826 bhp for LOX (printed 14850) and 11785 for fuel (printed 11790).
4. The turbine power in Sample Calculation 6-5 is computed from torque and speed as 27150 hp and the efficiency of 58.2 percent is back-calculated from it. Table 3-2 prints 27140. The pump powers plus the auxiliary drive give 14850 + 11790 + 500 = 27140. Equations 6-18 and 6-19 with 58.2 percent and the printed gas state give 27144 hp.
5. The gas properties of Table 6-4 are not mutually consistent. The printed R of 53.6 gives cp = gamma R / (gamma - 1) / 778.17 = 0.624 Btu/lb F, against the printed 0.653, and cp and gamma give R = 56.0. The difference is 4.5 percent. The case uses the printed R for the turbine mass flow and the printed cp and gamma for the energy, as the book does in the two places where they are used.
6. The torque unit in Table 3-2 is printed in-lb, and Sample Calculation 6-5 uses ft-lb. Only ft-lb reproduces 27150 hp at 7000 rpm, so ft-lb is taken.

## The model

The engine is one OpenFLUME steady network of about 40 nodes plus a script-level outer iteration.

### Fluids

LOX and RP-1 are incompressible with the book's densities. Viscosity and specific heat are not used by any component in the network and are set to nominal values. The thrust chamber gas is the product fluid of the reacting junction and its R, gamma and cp come from the junction. The turbine gas is a separate ideal gas with the Table 6-4 values at 1400 F, with a nominal viscosity. Temperature is imposed on the turbine inlet boundary node at 1860 R.

### Feed lines

Each liquid station of the budgets in the data table is a node. Each line, valve, torus dome, calibration orifice, cooling jacket, injector and gas-generator control orifice is an `orifice` branch with a square-law drop. The effective area of each is sized from the book flow and drop with the book density, area = flow / sqrt(2 rho dp). The jacket and manifold drop is also taken as square-law. The line drops are taken as printed and are lumped in one branch per printed item. The entrance losses of the gas generator are on the branch from the pump discharge node. The heat exchanger is an imposed 3 lb/s `flowSource` from the LOX pump discharge node, which is an interpretation of the single printed entry. Tanks are boundary nodes at the book's pump inlet pressures of 55 and 45 psia, with no suction line loss because none is published.

### Pumps

Each pump is a `pump` branch. Its pressure rise versus volumetric flow is a quadratic head-flow shape through the design point, written in the normalized flow q = Q / Q_d and the head ratio h = H / H_d.

h(q) = 1.2 - 0.2 q^2

The design point is the book flow (1971 and 892 lb/s) and the pressure rise from the printed inlet and discharge pressures. The shut-off ratio of 1.2 is a stated choice for a typical centrifugal pump read from the form of Figure 6-24 and is not a book number. A sensitivity at 1.1 and 1.3 is reported. At a shaft speed N the affinity laws give rise(Q, N) = (N / N_d)^2 rise_d(Q N_d / N), and the curve table is rebuilt for each N. The pump efficiency is the printed value and is constant, so the affinity scaling is exact in efficiency along the similarity parabola and approximate off it. This is stated as a limit.

### Main chamber

The LOX and RP-1 injector branches end on a reacting junction node with the `lox-rp1` CEA table, efficiency 0.975 squared (the repository convention that efficiency on enthalpy rise equals c* efficiency squared), O/F 2.35 and Pc of 6.9 MPa lie inside the table grid. The throat is a choked `orifice` from the junction node to an exhaust boundary at ambient pressure. The node pressure is the injector end pressure. The book's nozzle stagnation pressure is lower than the injector end pressure by the ratio 1000/1095, which is the stagnation pressure loss of heat addition in the chamber. The throat discharge coefficient is therefore set to 1000/1095 on the geometric throat area of 487 in2, so that the nozzle stagnation pressure is the node pressure divided by 1.095. This ratio is the one imposed choice that carries the chamber loss, and the junction table is read at the node pressure, not at the nozzle stagnation pressure. The difference in c* from that reading is expected to be below 0.2 percent and is stated as a limit. The model Pc is the node pressure over 1.095. The model c* is Pc times the throat area times the standard gravity divided by the total flow, which is the book's definition.

If the reacting junction or the choked orifice cannot be solved in this arrangement, the fallback is an imposed c* of 5660 ft/s with the book's efficiency, and that is reported as a gap and as a change from this protocol.

### Gas generator and turbine

OpenFLUME has no multi-fluid node without a reacting junction and the CEA tables do not cover the gas-generator mixture ratio of 0.408 (lox-rp1 starts at 1). The book's gas state is imposed instead. NASA CEA gives 1727 F for this mixture ratio against the book's 1400 F, so the book's value is a design value with a lowered temperature allowance, and no CEA is used for the gas generator. The gas-generator liquid branches end on two liquid boundary nodes at the injector end pressure P_gg, one per propellant. The turbine inlet is a gas boundary node at P_gg - 70 psi and 1860 R, with the combustor pressure drop held at the printed 70 psi. The turbine is a choked `orifice` from that node to a boundary at 27 psia. Its effective area is sized so that it passes 92 lb/s at 640 psia, 1860 R, gamma 1.124 and the printed R. The pressure ratio of 23.7 is far above the critical ratio, so the turbine passes the same flow for any exhaust pressure.

P_gg is closed by an inner root find so that the liquid flow into the gas generator equals the turbine flow. This is a scalar nested loop and is stated as such. A reacting junction with a user thermochemistry closure would make it part of the simultaneous solve.

### Post-processing

The turbine power is computed from the solved flow, the printed inlet temperature, the solved pressure ratio and the printed cp, gamma and efficiency using equations 6-18 and 6-19. This is a post-processed output. There is no shaft unknown, so no component couples turbine power to pump power inside the network. The pump powers are Q times the solved rise over the printed efficiency. The torque is the turbine power over the angular speed. The balance residual is the turbine power minus the two pump powers and the 500 hp auxiliary drive, and the auxiliary drive is held at 500 hp at all speeds.

## Imposed, solved and post-processed

Imposed from the book and not tuned. Densities, tank pressures, every printed pressure drop and flow used to size an effective area, the heat exchanger flow, the pump design points and efficiencies, the throat area and the ratio 1000/1095, the c* efficiency, the turbine gas state, the turbine exhaust pressure, the combustor pressure drop and the auxiliary power.

Imposed by a stated choice and not from the book. The pump head-flow shape (shut-off ratio 1.2), the affinity scaling and the constant efficiency, the square-law behavior of every restriction including the jacket, and the nominal viscosities and specific heats that no component reads.

Solved inside the network. All liquid flows and pressures, the chamber pressure and temperature through the junction, the pump operating points, the gas-generator flows and the turbine flow at the solved P_gg.

Solved in the script. P_gg by the inner root find, and the shaft speed N by the outer balance.

Post-processed. Pump heads and powers, turbine power, turbine pressure ratio, torque, balance residual, Pc, c* and the mixture ratios.

## The free parameter and the closure

The free parameter of the outer balance is the common shaft speed N of the two pumps. It is declared here before any run. The hardware (every effective area, the pump curve at the design speed, the turbine area) is fixed at the values sized from the book. The balance is closed by finding N such that the balance residual is zero, by a secant iteration to a residual below 1e-6 of the turbine power.

The reason is the following. The pumps and the turbine of the A-1 engine are on one shaft, and the book states that thrust level is adjusted by turbopump speed (page 203). The book calibrates the pumps by trimming the impellers so that both reach their heads at the rated speed and sets the gas generator flow experimentally (pages 202 and 203). In this network those calibrations are the sizing of the effective areas and of the pump curves from the design point, so the one quantity left free is the shaft speed. The solved N is then a result that can be compared with the 7000 rpm of the book. The turbine efficiency is held at the printed value, so the turbine power does not depend on N except through the flow, and the pump power rises as N cubed, which makes the balance well posed.

Two results are reported for the balance. The first is the residual at the book hardware and 7000 rpm before the outer iteration, which is an output and not an input. The second is the closed solution. A cross-check closure is also run at 7000 rpm, with the free parameter the common scale of the two gas-generator control orifice areas, which is the other way the book sets the turbine power. It is declared here and reported as a cross-check, not as the balance.

## Metrics

Every quantity below is printed in the book and is compared with the model. The percent difference is 100 times model over book minus 1, and for the residual it is stated in hp and as a fraction of the turbine power.

1. Flows, lb/s. Thrust chamber oxidizer and fuel and their O/F, gas generator oxidizer and fuel and their O/F, turbine flow, LOX pump flow and fuel pump flow.
2. Station pressures, psia. LOX side after the pump, after the line, after the main valve, after the torus dome and at the injector end. Fuel side after the pump, after the line, after the main valve, after the calibration orifice, after the jacket and at the injector end. Gas generator injector end, turbine inlet and the turbine pressure ratio.
3. Chamber, psia and ft/s. Nozzle stagnation pressure Pc and c*.
4. Pump heads, ft, and pump powers, bhp.
5. Turbine power, bhp, and torque, ft lbf.
6. Balance residual, bhp, before and after the closure, and the shaft speed N solved, rpm.

Rows that are reproduced by construction are marked so in the report. They are the sized flows and drops at the design point.

## Expected tolerances

These are set before the run from the arguments below and are not adjusted.

| Quantity | Expected tolerance | Reason |
| --- | --- | --- |
| Station pressures on both main sides and the gas generator | within 1.0 percent | The areas are sized from the printed drops, so the pressures close within the 0.3 lb/s mismatch of the book's flow sums and the shift of the pump operating point caused by the chamber pressure |
| Gas generator and turbine flow | within 2 percent | The gas generator drop is large (about 800 psi) and the sizing uses the same drops, so the flow follows the pump discharge pressure with half the relative change |
| Main flows | within 2 percent | A chamber pressure that differs by up to 2.5 percent moves the injector drop by about 20 psi of 200 and 500 to 700 psi of line, with the pump curve slope reducing it |
| Pc and c* | within 3 percent | The survey CEA run gave about 2 percent and the efficiency convention and the table pressure reading add under 0.5 percent |
| Pump heads and powers | within 3 percent | Follows from the pressures and flows, plus the 0.2 percent rounding of the printed heads |
| Turbine power | within 5 percent | It depends on the gas generator flow and on the pressure ratio, and the book's efficiency is back-calculated from the same equations |
| Residual before the closure | within 5 percent of the turbine power | The sum of the pump power shifts and the turbine shift |
| Residual after the closure | below 1e-6 of the turbine power | It is the solved equation |
| Solved shaft speed N | within 3 percent of 7000 rpm | Pump power scales as N cubed, so a 5 percent power shift moves N by under 2 percent |

A disagreement larger than these will be reported with its likely cause and not removed by any adjustment.

## Sensitivities (reported, not scored)

Pump shut-off ratio 1.1 and 1.3. Turbine gas constant taken as R = cp (gamma - 1) / gamma, which is 56.0 ft lbf/lb R against the printed 53.6. Combustor pressure drop scaled with the square of the gas-generator flow. The cross-check closure on the control orifice scale.

## Limits of the case

It is a design-point example of a hypothetical engine, so the comparison is with design values and not with test data. Flows and station pressures are reproduced by the sizing of effective areas, so they are a bookkeeping check of the network and not an independent prediction. The pump map is a stated shape, not a measured one. There is no turbine component, no shaft speed unknown, no turbine efficiency map, no dependence of pump efficiency on speed and flow, and no CEA call for the gas generator. The gas generator gas state is imposed, not computed from the propellant flows, and the CEA value for the same mixture ratio differs from it by 327 F. The chamber is a single node with the book's stagnation loss imposed as a ratio. The nozzle is a choked throat with no expansion, so thrust and specific impulse are not compared. The chamber gas is frozen downstream of the junction.

## Amendments

2026-11-09. Correction of two hand-arithmetic values in the observations on the book, made after the first model run but from the printed book data alone, so no model result is involved. Observation 4 gave 27144 hp for equations 6-18 and 6-19 with 58.2 percent and the printed gas state. The script recomputes it as 27123 hp (0.06 percent below the printed 27140). Observation 3 gave 11785 hp for the fuel pump and the script gives 11784. No modelling choice, tolerance or comparison set was changed.
