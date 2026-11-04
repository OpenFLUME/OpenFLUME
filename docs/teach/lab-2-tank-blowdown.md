---
title: "Lab 2: Tank blowdown"
description: Choked adiabatic blowdown of an air tank through an orifice — closed-form pressure history, time-step convergence, and isothermal vs adiabatic.
---

# Lab 2: Tank blowdown

A rigid tank of air vents to atmosphere through a small orifice. Students
derive the closed-form pressure and temperature history for choked adiabatic
blowdown, compare it with the shipped **Tank blowdown** example, measure how
the error depends on the time step, and then make the tank isothermal to see
how much of the answer depends on the energy equation.

The lab builds on case 1 of the
[tank transient validation report](../validation/tank-transient-report.md),
which uses the same orifice and tank volume at a higher starting pressure.
The [tank blowdown tutorial](../guides/tank-blowdown.md) is a gentler
walk-through of the same example.

## Learning objectives

By the end of the lab, students should be able to:

1. Decide whether an orifice is choked, and compute the choked mass flow of
   an ideal gas.
2. Derive the closed-form choked adiabatic blowdown solution and the cooling
   law `T/T₀ = (m/m₀)^(γ−1)` from the open-system mass and energy balances.
3. Explain why the gas cools, using the difference between the enthalpy that
   leaves and the internal energy that is stored.
4. Show that a backward-Euler integrator converges at first order in the time
   step, and choose a time step for a required accuracy.
5. Compare adiabatic and isothermal blowdown and explain which assumption a
   real tank is closer to.

## Prerequisites

- Thermodynamics: first law for open systems, ideal-gas relations, isentropic
  flow, choking.
- Basic ODEs: separable first-order equations.
- Lab 1 or the [Getting started](../guides/getting-started.md) page.

## Time

About 45 minutes of pre-lab work and 1.5 hours in the lab.

## Theory

**Model.** The example has three elements (user manual §7.3):

| Element | Type                      | Values                                               |
| ------- | ------------------------- | ---------------------------------------------------- |
| Tank    | internal node with volume | `V = 0.1 m³`, initially `P₀ = 500 kPa`, `T₀ = 300 K` |
| Ambient | boundary node             | `P_b = 101 325 Pa`, 300 K                            |
| Orifice | `orifice` branch          | `A = 1×10⁻⁴ m²`, `Cd = 0.6`                          |

The fluid is the ideal-gas `air` preset: `R = 287 J/(kg·K)`, `γ = 1.4`,
`cp = 1005 J/(kg·K)` (`src/core/fluids/index.ts`). The solver uses
`cv = cp − R = 718 J/(kg·K)` in the energy equation, so `cp/cv = 1.3997`
rather than exactly 1.4. The resulting difference is about 0.01 %, which
matters only in the time-step study.

**Balances.** The tank stores mass and internal energy, and the outflow carries
enthalpy (user manual §4.1.3; report "Tank ODEs"):

```
dm/dt = −ṁ
d(m cv T)/dt = −ṁ cp T
P = m R T / V
```

Eliminating time gives `T/T₀ = (m/m₀)^(γ−1)` and `P/P₀ = (m/m₀)^γ` for any
adiabatic blowdown, whatever the orifice law.

**Choked orifice.** The gas `orifice` chokes when `P_b/P` falls below the
critical ratio `r* = (2/(γ+1))^(γ/(γ−1)) = 0.5283` (manual §4.3.2). Below that
ratio the mass flow no longer depends on the back pressure:

```
ṁ = Cd A P sqrt(γ/(R T)) (2/(γ+1))^((γ+1)/(2(γ−1)))
```

**Closed form.** Substituting the choked law and the cooling law into the mass
balance gives a separable ODE whose solution is (report, "Adiabatic Blowdown"):

```
m/m₀ = [1 + ((γ−1)/2) (t/τ)]^(−2/(γ−1))
P/P₀ = [1 + ((γ−1)/2) (t/τ)]^(−2γ/(γ−1))
τ = V / ( Cd A sqrt(γ R T₀) (2/(γ+1))^((γ+1)/(2(γ−1))) )
```

The solution holds only while the orifice stays choked.

**Isothermal limit.** If heat exchange holds the gas at `T₀`, the choked mass
balance becomes linear in `P`, and `P/P₀ = exp(−t/τ)` with the same `τ`.

**Time integration.** OpenFLUME integrates transients with backward (implicit)
Euler (manual §4.6.2). Its error is first order: halving `dt` should halve the
deviation from the exact solution.

## Pre-lab hand calculation

1. Compute the initial gas mass `m₀` and the initial choked mass flow `ṁ₀`.
2. Find the tank pressure below which the orifice unchokes, `P_b / r*`.
   Confirm that the orifice is choked at `t = 0`.
3. Compute `τ`.
4. Tabulate `P`, `T`, and `m` from the closed form at `t = 1, 2, 3, 4, 5 s`.
5. Find the time at which the tank pressure reaches the unchoking pressure.
   Is the closed form valid for the whole 5 s run?
6. Repeat steps 4 and 5 for an isothermal tank.
7. Backward Euler evaluates the outflow at the _end_ of each step, where the
   tank pressure is lower. Predict whether the computed pressure will lie
   above or below the exact curve, and whether the gap grows or shrinks during
   the run.

## Procedure in OpenFLUME

Set **Units ▾** to **SI**.

### Part A: Baseline run

1. Open the example:
   **[Tank blowdown](https://openflume.github.io/OpenFLUME/#example=tank-blowdown)**.
   (Or **Examples ▾** → _Applications_ → **Tank blowdown**.)
2. Click the **Tank** node and check **Pressure**, **Temperature**, and
   **Volume**. Click the **Orifice** and check its area and discharge
   coefficient. Open the **Setup** tab: under **Solver**, **Mode** is
   Transient, with **Fixed dt**, **Time Step** 0.01 s, and **End Time** 5 s.
3. Return to the **Model** tab and click **Run**. While it runs, the toolbar
   shows `t = … s / 5 s`. The status pill should end at **Converged**.
4. Open the **Results** tab. In the empty plot, use **or plot a whole set…** to
   choose **Node pressure**. Read the tank pressure at `t = 1, 2, 3, 4, 5 s`.
   Click the chart and use the arrow keys to step the cursor, or use
   **Export CSV** and read the values from the file.
5. Click **+ Plot** and choose the **Node & solid temperature** set. Read the
   tank temperature at the same times.
6. Add a third plot with the orifice mass flow. Note the value at the first
   time step.

### Part B: Time-step convergence

1. In **Setup** → **Solver**, change **Time Step** to 1 s and click **Run**.
   Record the tank pressure at `t = 5 s`.
2. Repeat with **Time Step** = 0.5, 0.25, 0.1, and 0.05 s. Every run is kept in
   the run history. On the pressure plot, **+ Compare run…** overlays up to
   four earlier runs on the same axes.
3. For each time step, compute the relative error in `P(5 s)` against your
   closed-form value. Plot error against `dt` on log-log axes and measure the
   slope.
4. Set **Time Step** back to 0.01 s before Part C.

### Part C: Isothermal tank

The user manual (§3.6) describes how to make a gas tank close to isothermal:
tie it to a fixed-temperature reservoir with a convection conductor whose
`hA` is much larger than 10⁴ W/K.

1. On the **Model** tab, place an **Ambient node** from the left rail
   (_Thermal nodes_). Set its **Temperature** to 300 K.
2. Drag from the **Tank** node's handle to the ambient node. In
   **Connect with**, under **Thermal ties**, choose **Convection**.
3. In the conductor's property panel, leave **Heat-transfer model** on
   **Specified h (constant or equation)**, and set **h** to 10000 W/(m²·K) and **Area** to 10 m², so
   that `hA = 10⁵ W/K`.
4. Click **Run**. Compare tank pressure and temperature with the adiabatic run,
   using **+ Compare run…**.

## Questions

1. How close is the `dt = 0.01 s` run to your closed-form pressure at 5 s?
   Is the solver above or below the exact curve? Does that match your
   prediction in pre-lab step 7?
2. What convergence order did you measure? The validation report measured
   0.99–1.00 on its own blowdown case. If your slope differs noticeably, what
   else limits the comparison at very small `dt`?
3. Which time step would you choose to keep the 5 s pressure within 0.5 % of
   the exact value? Within 0.1 %?
4. The tank temperature falls by about 60 K in 5 s even though no heat leaves
   the tank. Where does the internal energy go?
5. Why does the isothermal tank hold its pressure longer, even though its
   mass flow at `t = 0` is the same?
6. A real tank has metal walls. Is a real blowdown closer to the adiabatic or
   the isothermal result? What would you need to add to the model to answer
   this properly?
7. What value does the orifice mass flow show at `t = 0`, and why does it not
   match `ṁ₀`?

## Extensions

- **Past unchoking.** Set **End Time** to 15 s and rerun the adiabatic case.
  Find the time at which the flow unchokes and compare it with your pre-lab
  estimate. Once the flow stops, the tank has expanded isentropically to
  ambient pressure. Predict the final temperature from
  `T = T₀ (P_b/P₀)^((γ−1)/γ)`.
- **Validation case.** Rebuild case 1 of the validation report (10 bar tank,
  1 bar boundary, 8 s, `dt = 0.05 s`) and compare your final pressure and
  temperature with the report's 2.91 bar and 210.8 K.
- **Orifice size.** Use the **Sweep** tab to vary the orifice area. How does
  `τ` scale with area, and does the solver agree? The
  [tutorial](../guides/tank-blowdown.md) covers this sweep.
- **Fill heating.** Reverse the problem: a tank at 1 bar filled from a 5 bar,
  300 K supply heats above 300 K. Case 4 of the validation report gives the
  closed form, `T_f = γ T₀ P_f / (P_f + (γ−1) P₀) = 388.9 K`.

::: details Answer key

Closed-form values were computed independently in Python from the formulas
above, with `γ = 1.4` and `R = 287 J/(kg·K)`. A Runge–Kutta (RK4) integration of
the tank ODEs that uses the preset's actual `cp = 1005` and `cv = 718` gives
`P(5 s) = 225.425 kPa` and `T(5 s) = 238.96 K`, within 0.013 % of the closed
form. Solver values are OpenFLUME 0.3.1, run locally with the shipped example.

**Pre-lab**

- `m₀ = P₀V/(RT₀) = 0.5807 kg`. `ṁ₀ = 0.07001 kg/s`.
- `r* = 0.5283`, so the unchoking pressure is `101 325/0.5283 = 191.8 kPa`.
  At `t = 0`, `P_b/P₀ = 0.203`, so the orifice is choked.
- `τ = 8.295 s` (the same `V`, `Cd A`, and `T₀` as the validation report's case
  1, which also gives 8.295 s).
- Adiabatic unchoking time: 6.08 s. The 5 s run stays choked throughout, so the
  closed form holds for the whole run. Isothermal unchoking time:
  `τ ln(P₀/191.8 kPa) = 7.95 s`.

| t [s] | P adiabatic [kPa] | T adiabatic [K] | m [kg] | P isothermal [kPa] |
| ----- | ----------------- | --------------- | ------ | ------------------ |
| 0     | 500.00            | 300.00          | 0.5807 | 500.00             |
| 1     | 423.20            | 286.04          | 0.5155 | 443.22             |
| 2     | 359.58            | 273.03          | 0.4589 | 392.88             |
| 3     | 306.67            | 260.89          | 0.4096 | 348.26             |
| 4     | 262.47            | 249.55          | 0.3665 | 308.71             |
| 5     | 225.40            | 238.92          | 0.3287 | 273.65             |

At 5 s the tank has vented 0.252 kg, which is 43.4 % of its charge.

- Step 7: the implicit step discharges slightly too little mass in each step,
  so the computed pressure lies _above_ the exact curve. Within a fixed-step
  run, the gap accumulates and grows with time. The validation report
  describes the same one-sided lag.

**Part A** (solver, `dt = 0.01 s`)

| t [s] | P [kPa] | error vs closed form | T [K]  |
| ----- | ------- | -------------------- | ------ |
| 1     | 423.27  | +0.018 %             | 286.07 |
| 2     | 359.71  | +0.034 %             | 273.09 |
| 3     | 306.82  | +0.048 %             | 260.97 |
| 4     | 262.63  | +0.061 %             | 249.64 |
| 5     | 225.56  | +0.073 %             | 239.03 |

The run takes 500 steps. The orifice mass flow at the first step is
0.0699 kg/s, against 0.0700 kg/s exact at `t = 0`.

**Part B: time-step study** (solver, `P` at 5 s; closed form 225.396 kPa)

| dt [s] | P(5 s) [kPa] | error    | T(5 s) [K] |
| ------ | ------------ | -------- | ---------- |
| 1      | 239.22       | +6.13 %  | 245.70     |
| 0.5    | 232.59       | +3.19 %  | 242.53     |
| 0.25   | 229.07       | +1.63 %  | 240.80     |
| 0.1    | 226.90       | +0.67 %  | 239.71     |
| 0.05   | 226.11       | +0.32 %  | 239.34     |
| 0.01   | 225.56       | +0.073 % | 239.03     |

Successive slopes on a log-log plot are 0.94, 0.97, 0.98, 1.08, and 0.91. The
order is about 1. The last slope is pulled down by the 0.013 % offset
between the closed form and the preset's `cp/cv` (see above). Measured
against the RK4 reference, the slopes are 0.95, 0.97, 0.99, 1.11, and 1.00.
For 0.5 % accuracy at 5 s, `dt ≈ 0.075 s` is enough; for 0.1 %, about
`dt ≈ 0.015 s`. The example's 0.01 s meets both.

**Part C: isothermal** (solver, `hA = 10⁵ W/K`, `dt = 0.01 s`)

`P(5 s) = 273.71 kPa` (+0.02 % against `500 exp(−5/8.295) = 273.65 kPa`), and
the tank temperature stays between 299.95 and 300 K. With `hA = 10⁴ W/K` the
tank runs 0.3 to 0.5 K cold and `P(5 s) = 273.34 kPa`.

**Questions**

- Q4: Each kilogram that leaves carries enthalpy `cp T`, but each kilogram
  stored only holds `cv T`. The difference, `R T` per kilogram, is the flow
  work the remaining gas does pushing the outflow out. It comes from the
  remaining gas's internal energy, so the gas cools.
- Q5: The choked mass flow is proportional to `P/sqrt(T)`. In the adiabatic
  tank, `T` falls, which on its own would raise `ṁ`, but `P` falls much faster
  (`P ∝ m^1.4`, compared with `P ∝ m` isothermally). For the same mass vented,
  the adiabatic tank loses more pressure.
- Q6: For a short, fast blowdown the wall cannot exchange much heat, so the
  answer is closer to adiabatic. For slow venting, it moves toward isothermal.
  Answering properly needs a solid wall node with mass and `cp`, tied to the
  gas by a convection conductor with a realistic `h` and to the ambient (see
  Lab 3).
- Q7: In OpenFLUME 0.3.1 the `t = 0` sample of a branch mass flow is the
  solver's starting value, not a solved flow. Here it is the default initial
  flow guess, 0.1 kg/s. Read the flow from the first step onward.

**Extensions**

- Past unchoking (solver, `dt = 0.01 s`): `P(6 s) = 194.4 kPa`, so the flow
  unchokes just after 6 s. The pressure reaches 101.3 kPa by about 15 s with
  `T = 190.2 K`, against the isentropic value
  `300 × (101 325/500 000)^(0.4/1.4) = 190.1 K`.

:::
