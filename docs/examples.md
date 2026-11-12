---
title: Examples gallery
description: The 14 models that ship with OpenFLUME, grouped as in the Examples menu, each with what it shows and a link that opens it running in the browser.
---

# Examples gallery

OpenFLUME ships with fourteen example models, found in the toolbar's
**Examples ▾** menu in the four groups used below. The descriptions come from
each example's canvas notes and the model definitions in
[`src/ui/examples.ts`](../src/ui/examples.ts); user manual §7 has a longer
write-up of each.

Each **Open in browser** link loads a fresh copy of the example into the app at
`https://openflume.github.io/OpenFLUME/`. Loading an example **replaces the
model you have open**, so **Save** your work first. Nothing is uploaded; the
model runs in your browser when you click **Run**.

Every example is an ordinary model. To start your own, open the nearest
example and edit it.

## Verify-by-inspection

### Sanity: orifice hand-calc

_Steady · incompressible water_

Water flows from a 200 kPa boundary to a 100 kPa boundary through a single
orifice (area 1×10⁻⁴ m², Cd = 0.6). The canvas note gives the hand answer,
`Cd A sqrt(2 ρ ΔP) ≈ 0.849 kg/s`, and the solved flow should match it within
0.5 %. It is the smallest model that exercises the whole chain: loading,
validation, Newton solve, and reported result.

**Demonstrates:** a first run after installing or updating, and checking a
solver result against a closed form.

[Open in browser](https://openflume.github.io/OpenFLUME/#example=sanity-orifice-hand-calc)

## Applications

### Three-pipe junction

_Steady · incompressible water_

Water enters at 300 kPa through one pipe and splits into two pipes that
discharge to outlets at 200 kPa and 150 kPa, so the split is uneven. The
canvas note asks you to check that the two outlet flows sum to the inlet flow.
The two downstream pipes take their roughness from the first pipe through a
formula binding.

**Demonstrates:** Darcy–Weisbach pipes with the Swamee–Jain friction factor,
junction continuity, and how a diameter change moves the split. Used in
[Lab 1](./teach/lab-1-pipe-networks.md).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=three-pipe-junction)

### Tank blowdown

_Transient · ideal-gas air_

A 0.1 m³ tank of air starts at 500 kPa and 300 K and vents through an orifice
to 101 kPa outside air. Over the 5 s run (fixed 0.01 s step), tank pressure
falls and the gas cools well below 300 K, because the tank stores internal
energy while the outflow carries enthalpy.

**Demonstrates:** transient storage in a tank node, a choked gas orifice, and
adiabatic expansion cooling. See the
[tank blowdown tutorial](./guides/tank-blowdown.md) and
[Lab 2](./teach/lab-2-tank-blowdown.md).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=tank-blowdown)

### Water distribution network

_Steady · incompressible water_

A pump pushes water through a main header into three parallel legs, each with
a valve that can be part open (positions 0.5, 0.8, and 1.0). One leg rises 3 m
and one falls 3 m, and the two return lines discharge at different elevations
and pressures. Change the valve settings to move flow between paths. Several
pipes and valves are formula-bound to Leg 1, so editing it updates the others.

**Demonstrates:** a pump operating point on a piecewise-linear curve,
elevation sign conventions, valve throttling, and pressure along a flow path.
Used in [Lab 1](./teach/lab-1-pipe-networks.md).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=water-distribution-network)

### Heated pipe with radiating wall (conjugate HT)

_Steady · incompressible water · conjugate heat transfer_

Water flows through two pipe sections and an outlet orifice. Each section is
wrapped by a wall node heated at 5000 W. Heat moves into the water by
convection, along the wall by conduction, and out to 300 K surroundings by
radiation. The convection areas are formulas tied to the pipes' surface area.

**Demonstrates:** solid and ambient nodes with all three conductor kinds in
the smallest model that uses them together, and closing a solid–fluid energy
balance. Used in [Lab 3](./teach/lab-3-conduction.md).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=heated-pipe-with-radiating-wall-conjugate-ht)

### Spacecraft radiator panel (ammonia loop heat pipe)

_Steady · real-fluid ammonia · two-phase · conjugate heat transfer_

A wicked evaporator boils ammonia with 350 W of avionics heat. The vapor
travels 1.5 m to a flat radiator panel and condenses, and the liquid returns to
the compensation chamber. There is no mechanical pump: the wick is modeled as a
flow source that passes the liquid the heat can boil (0.32 g/s), and the loop
needs only about 68 Pa. The canvas note gives the expected results: vapor
quality 0.98 in the vapor line, a condenser that stays at about 306 K, and
about 6 K of subcooling in the last strip. The temperature drops occur in the
hardware, not the fluid.

**Demonstrates:** real-fluid two-phase flow, radiation to space, a
two-dimensional conduction network in a face sheet, and the 3-D view (the panel
lies in the x–y plane).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=spacecraft-radiator-panel-ammonia-loop-heat-pipe)

### LOX/RP-1 thruster (combustor)

_Steady · reacting junction · compressible nozzle · conjugate heat transfer_

LOX and RP-1 injectors discharge into a reacting junction whose hot-gas state
comes from a NASA CEA chemical-equilibrium lookup with an enthalpy efficiency
of 0.9409. The gas then expands through a choked converging–diverging nozzle
with **Momentum flux** and **Kinetic energy** on. The RP-1 cools the nozzle
through a regenerative jacket with a three-layer copper wall at every station.
The exhaust boundary is set to the matched-expansion pressure: a boundary node
imposes a static pressure, and any other value would back-propagate into the
last station.

**Demonstrates:** CEA-coupled combustion, quasi-1-D choked nozzle flow, mixed
equations of state in one model, and regenerative cooling. Details are in
[combustion.md](./combustion.md) and the
[combustion validation report](./validation/combustion-report.md).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-combustor)

### LOX/RP-1 thruster (transient startup)

_Transient · reacting junction · compressible nozzle_

The same thruster, run as a startup. Both propellant tanks ramp from 100 psi
to 1000 psi over the first second and then hold for a second. The chamber's
energy closure is quasi-steady, but its mass balance has a real storage term,
so chamber pressure follows the feed ramp with a lag of about 0.3 ms. The
exhaust boundary is fixed at 30 kPa instead of sea level, which keeps the
nozzle profile monotone across the whole ramp.

**Demonstrates:** a transient reacting junction, pressure schedules on
boundary nodes, and node volumes on a discretized nozzle.

[Open in browser](https://openflume.github.io/OpenFLUME/#example=lox-rp-1-thruster-transient-startup)

### Capillary circuit (stop + trigger valve)

_Transient · incompressible water · capillary channels_

A water sample wicks from the inlet into two microchannels with no pump. Short
path A ends in a stop valve at the junction and waits there. When the longer
delay path B arrives, its liquid meets A's meniscus and releases the valve (a
trigger valve). The stream then wicks into a capillary pump while air leaves
through the vent. Plot each channel's **Liquid fill** in **Results** to see
the sequence.

**Demonstrates:** capillary-driven filling, stop and trigger valves, and event
timing in microfluidic circuits. See the
[microfluidics validation report](./validation/microfluidics-report.md).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=capillary-circuit-stop-plus-trigger-valve)

## Benchmarks

### Water-water counterflow heat exchanger

_Steady · incompressible water · conjugate heat transfer_

Reproduces Example 5 of NASA's GFSSP manual. Hot water flows left to right and
cold water right to left, exchanging heat through a wall split into 12
segments. After **Run**, the outlet temperatures should be within 0.44 K (hot)
and 0.19 K (cold) of the published values.

**Demonstrates:** a code-to-code conjugate heat-transfer benchmark and the
effect of segment count on heat-exchanger accuracy. Case 5 of the
[thermal network validation report](./validation/thermal-network-report.md)
studies the segmentation error.

[Open in browser](https://openflume.github.io/OpenFLUME/#example=water-water-counterflow-heat-exchanger)

### Entrapped-air line

_Transient · incompressible water with a trapped-gas cushion_

Reproduces GFSSP Figure 10 (Lee and Martin). Water fills a long pipe with
trapped air at the far end. Each pipe segment has fluid inertia, so the flow
cannot change instantly. The valve opens at about 0.15 s, and the pressure at
node 12 then rises and falls as the air cushion compresses and rebounds.

**Demonstrates:** lumped fluid inertia and the polytropic gas cushion working
together. This is bulk surge; OpenFLUME does not model acoustic wave
propagation. See the
[fluid transient validation report](./validation/fluid-transient-report.md).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=entrapped-air-line)

### Cryogenic line cooldown

_Transient · real-fluid hydrogen · two-phase · conjugate heat transfer_

The SINDA/FLUINT validation case from NBS Report 9264, Figure 2. Saturated
liquid hydrogen enters a warm copper transfer line and chills the wall station
by station. Run it and watch the quench front move down the line.

**Demonstrates:** real-fluid two-phase (HEM) flow, film-boiling heat transfer,
temperature-dependent copper properties, and why axial discretization matters
for a moving front. See the [cryogenic chilldown guide](./guides/cryogenic-chilldown.md).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=cryogenic-line-cooldown)

## Extensibility

### Extension: Cryo tank vent control (transient)

_Transient · real-fluid nitrogen · logic and controllers_

A cold nitrogen tank receives 400 W of heat. The vent opens when tank pressure
gets too high and closes once it has dropped far enough; the band is 5 psi
wide around about 3.2 bar. Logic rules set a `ventOpen` register, a controller
drives the valve fully open or closed, and other registers count vent events
and track the peak pressure.

**Demonstrates:** registers, declarative logic rules, hysteresis, and a
register-following controller, with no component code. The contract is in
[usercode.md](./usercode.md).

[Open in browser](https://openflume.github.io/OpenFLUME/#example=extension-cryo-tank-vent-control-transient)

### LH2 tank no-vent fill

_Transient · real-fluid parahydrogen · conjugate heat transfer · logic and controllers_

Reproduces SINDA/FLUINT Sample Problem F (TVS): a no-vent fill of a half-full,
saturated liquid-hydrogen tank from a 60 psia source. FLUINT's twinned tanks
and moveable ties are **emulated** with registers, logic rules, and
controllers, using CoolProp properties read back from the solver. At 15
minutes the note reports fill 73.4 % (deck 73.9 %) and pressure 59.63 psia
(59.72). The vapor-cooled shield and internal heat exchanger are carried as
thermal mass only, not as flow paths. Read the note and the module header of
[`src/ui/lh2StorageTank.ts`](../src/ui/lh2StorageTank.ts) before using this
example as a template.

**Demonstrates:** how far registers, logic, and controllers can stretch to
emulate features the schema lacks, and how to document what is emulated
versus matched.

[Open in browser](https://openflume.github.io/OpenFLUME/#example=lh2-tank-no-vent-fill)

## Limits

The examples stay inside what OpenFLUME models. It has no shock capture, no
acoustic or water-hammer wave propagation (fluid inertia is lumped per branch),
cavitation only at venturi closure, turbomachinery as a pump curve only, no
general junction mixing outside CEA reacting junctions, and homogeneous
(HEM) two-phase flow only. Embedded user code is trusted, not sandboxed. A
steady closed ideal-gas loop needs a pressure anchor. OpenFLUME is alpha
software (0.4.1). The full list is in user manual §1.7.
