# Regenerative cooling channel: a LOX/RP-1 booster chamber

This example simulates a rectangular cooling channel in a regeneratively-cooled LOX/RP-1 thrust chamber. RP-1 runs in the channel. The hot side is the **adiabatic-wall temperature**
(fixed 3400 K reservoirs behind a Bartz-plus-soot film), so the delivered flux
follows the _solved_ wall temperature. The coolant momentum equation carries
the acceleration (momentum-flux) term (`settings.momentumFlux`).

- Model: [`src/ui/regenCoolingChannel.ts`](../src/ui/regenCoolingChannel.ts)
- Tests: [`src/ui/tests/regenCoolingChannel.test.ts`](../src/ui/tests/regenCoolingChannel.test.ts)
- UI: **Examples ▾ → Applications → Regenerative cooling channel (LOX/RP-1
  booster chamber)**

## 0. Design point, not a specific engine

The cycle numbers (1 023 kN vacuum thrust, vacuum Isp 305 s, LOX/RP-1, combustion tap-off) size a typical booster chamber. **Everything else on this page is an assumed, self-consistent design point** (chamber pressure, contour, channel count, wall thickness, coolant temperature) taken from standard booster-engine practice, not from any one published engine.

## 1. Cycle and contour

| Quantity                          | Value             | Source                              |
| --------------------------------- | ----------------- | ----------------------------------- |
| Vacuum thrust                     | 1 023 kN          | assumed                             |
| Vacuum Isp                        | 305 s             | assumed                             |
| Propellants / cycle               | LOX/RP-1, tap-off | assumed                             |
| Mixture ratio O/F                 | 2.6               | assumed                             |
| Chamber pressure                  | 10.0 MPa          | assumed                             |
| Vacuum thrust coefficient         | 1.85              | assumed (ε ≈ 25, ~97 % nozzle eff.) |
| Contraction ratio                 | 2.5               | assumed                             |
| Barrel length                     | 0.35 m            | assumed (L ≈ 1.1 m)                 |
| Convergent / divergent half-angle | 30° / 20°         | assumed, conical                    |
| Cooled skirt end                  | ε = 4.0           | assumed                             |

Everything else follows:

- Total flow ṁ = F/(Isp·g₀) = **342.0 kg/s**
- Fuel flow ṁ_f = ṁ/(1+O/F) = **95.0 kg/s**
- Throat area A_t = F/(C_F·P_c) → **D_t = 0.2653 m**
- Chamber diameter D_c = D_t·√2.5 = **0.4195 m**
- Throat station z = **0.4835 m** from the injector face, cooled skirt ends at
  z = **0.8481 m** where D = 0.5307 m.

The contour is conical for simplicity. The jacket heat balance only sees local area ratio and wetted area, and a conical approximation gets both right to a few percent.

## 2. The hot side: adiabatic-wall reservoirs

Nozzle heat transfer is driven by the **recovery (adiabatic-wall)
temperature**. T*aw stays within a few percent of the stagnation
temperature along the whole contour. The jacket removes ~0.3 % of the
chamber's thermal power, so the driving temperature barely droops from the
injector face to the skirt. The hot side is therefore \_not* a solved gas continuum. Each cell instead sees a fixed-temperature **ambient reservoir at T_aw = 3400 K** behind the
Bartz-plus-soot film:

```
h_g(z) = h_g,throat · (A_t/A)^0.9
h_eff(z) = φ(z) / (1/h_g(z) + R_soot(z))
q″(z) = h_eff(z) · (T_aw − T_wg(z))        [T_wg solved]
```

The flux is a conductance against a fixed reservoir. Where the coolant runs the wall hot the delivered flux self-limits, and where the wall is cold it rises. The reservoir-to-wall link is a pure linear conductance G = h*eff·A_gas, written as a conduction conductor with **k = h_eff** and L = 1 m. Convection conductors require a fluid endpoint; the hot gas is not a fluid node. Each `gasFilm` k is a `{ expr }` formula against shared registers \_and* the cell's
coolant-node position, so the assumptions and the local geometry are visible
in the property panel rather than silent numbers:

| Register                           | Value        | Role                                                                |
| ---------------------------------- | ------------ | ------------------------------------------------------------------- |
| `tAw`                              | 3400 K       | every `aw` node temperature is `reg('tAw')`                         |
| `hgThroat`                         | 12 kW/m²K    | Bartz at P_c = 10 MPa, D_t = 0.265 m                                |
| `bartzExp`                         | 0.9          | h_g ∝ (A_t/A)^0.9                                                   |
| `rSootThroat`                      | 8.5e-5 m²K/W | 0.085 mm of carbon at k = 1 W/mK                                    |
| `rSootBulk`                        | 1.7e-4 m²K/W | 0.17 mm, reached by ε = `rSootRampEps`                              |
| `rSootRampEps`                     | 3            | area ratio at which the deposit is full thickness                   |
| `filmFace`                         | 0.70         | injector film-cooling relief at z = 0                               |
| `filmLength`                       | 0.2 m        | φ reaches 1                                                         |
| `dThroat`                          | 0.2653 m     | throat diameter; ε = (2·position.x / dThroat)²                      |
| `zEnd`                             | 0.8481 m     | cooled-skirt station; z = zEnd − position.z                         |
| `nChannels`, `tw`, `Sw`, `h`       | jacket       | channel count, rib, liner, depth                                    |
| `L1`…`L12`                         | m            | cell wall length along the contour                                  |
| `kLiner`, `rhoLiner`, `hFin`       | jacket       | frozen fin-efficiency k (GRCop-84 at 550 K), density, nominal fin h |
| `pJacketIn`, `pInjector`, `tInlet` | Pa, K        | manifold boundaries                                                 |

Local area ratio and station z are the RP-1 node's physical position, not
inlined floats. Changing a register updates every station's film, liner, and
channel geometry together.

The soot term represents the largest single resistance in the
chain and the reason kerosene engines survive fluxes that would destroy an
equivalent clean wall. It is scheduled axially because the deposit is scoured
thinnest where the gas shear is highest: thin at the throat, thick in the
barrel and skirt.

The shipped mesh contains **twelve axial cells** (four barrel, two convergent, one
throat, five skirt, last cell short). This is enough to keep the throat and the
cold-slow skirt inlet as separate stations. At the throat the carbon deposit
and the gas-side film split most of the driving ΔT. The liner itself remains
a small share.

## 3. Channel geometry

Rectangular channels in a GRCop-84 liner are closed out by a structural jacket.
GRCop-84 liners are typically printed. The rectangular geometry does not
depend on how the liner is made. Standard symbols are channel width
`b`, depth `h`, rib (land) thickness `t_w`, inner-wall thickness `S_w`:

| Quantity                   | Value                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channels `N`               | 260                                                                                                                                                                         |
| Rib thickness `t_w`        | 1.5 mm                                                                                                                                                                      |
| Inner-wall thickness `S_w` | 0.8 mm                                                                                                                                                                      |
| Channel depth `h`          | 4.0 mm, constant                                                                                                                                                            |
| Channel width `b`          | 1.78 mm (throat) → 4.71 mm (skirt end)                                                                                                                                      |
| Hydraulic diameter         | 2.47 → 4.33 mm                                                                                                                                                              |
| Liner                      | GRCop-84 (`{ material: 'grcop-84' }`); k(T) and cp(T) from Ellis NASA/CR-2000-210055. Density 8620 kg/m³. `kLiner` is the frozen fin-efficiency k at 550 K, not conduction. |
| Surface finish             | 5 µm (assumed copper roughness)                                                                                                                                             |

Channel width grows with diameter according to `b = π(D + 2·S_w)/N − t_w`. Depth is the only shape freedom, and the shipped design uses a
constant 4.0 mm.

That constant depth is both the simplest schedule and close to the best.
At constant depth the flow area grows with the contour. Mass flux
G = ṁ_ch/A falls as the chamber widens, which is precisely where the
delivered flux falls too, both from the Bartz area scaling and from the
thickening carbon deposit. A constant depth puts the highest mass flux
where the heat is. Tapered schedules (shallow at the throat, pinched again over
the skirt) were swept and each cost ≥ 1 MPa of extra pump head for the same
peak wall temperature.

Rib heat transfer uses a straight-fin, adiabatic-tip efficiency evaluated once
at a nominal h = 30 kW/m²K and GRCop-84 k at 550 K, giving η = 0.618. The
coolant-wetted area per channel is therefore `(b + 2·η·h) · L`. This area covers the channel
floor plus one flank of each bounding rib, since every rib is shared with its
neighbour.

### Why `customResistance` and not `pipe`

The channels are rectangular. A `pipe` derives its flow area from its diameter
as πD²/4, so no single diameter reproduces both the true flow area (which sets
velocity) and the hydraulic diameter (which sets `f` and L/D). Feeding a pipe
the hydraulic diameter overstates velocity by ~50 % and pressure drop by ~2.3×.

Each channel segment is therefore a `customResistance` carrying the **true**  
**rectangular flow area** and a `kTable` built from this repo's own  
`darcyFrictionFactor` at ε/D_h. This yields `K(Re) = f(Re)·L_seg/D_h` exactly. The result reproduces the Darcy–Weisbach drop of the real duct.

## 4. Coolant: RP-1 as n-Dodecane

RP-1 is not in the CoolProp catalogue, so n-Dodecane (C₁₂H₂₆) is the standard single-component surrogate (RP-1's mean formula is close to C₁₂H₂₃). It is ~6 % light on density and ~8 % low on viscosity, which makes this model marginally optimistic on pressure drop, but trends should be indicative.

| Property at 300 K, 15 MPa | n-Dodecane | RP-1  |
| ------------------------- | ---------- | ----- |
| Density                   | 755 kg/m³  | ≈ 805 |
| Viscosity                 | 1.57 mPa·s | ≈ 1.7 |

## 5. Network topology

Flow is a single up-pass: RP-1 enters a manifold at the downstream end of the
cooled skirt (ε = 4) and runs toward the injector, counter to the gas. The
downstream boundary is the injector fuel manifold at 12.0 MPa (chamber pressure
plus injector ΔP).

Because every channel sees the same axial boundary condition, the network is
**one representative channel** carrying ṁ_f/N = 0.3654 kg/s, with every area, volume and heat load divided by N. Multiply a per-channel result by N to recover the full jacket.

Twelve axial cells span the cooled length. There are four in the barrel, two in the
convergent section, one 40 mm cell straddling the throat, and five down the skirt with
the last cell short so the inlet is not averaged into the faster channel
upstream. Each cell carries the coolant, the liner, and a hot-gas reservoir:

| Element              | Role                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| fluid node `f`k      | RP-1 bulk state (n-Dodecane)                                                                                  |
| ambient node `aw`k   | hot-gas reservoir, `reg('tAw')` = 3400 K                                                                      |
| solid node `wg`k     | hot-gas-side liner surface                                                                                    |
| solid node `wc`k     | coolant-side liner surface + rib roots                                                                        |
| conductor `gasFilm`k | conductance `aw` → `wg`: k is a Bartz-plus-soot **formula** (registers + node position), L = 1 m so k ≡ h_eff |
| conductor `liner`k   | conduction `wg` → `wc` through `S_w`: k, area, length are jacket formulas                                     |
| conductor `film`k    | convection `wc` → coolant, Dittus–Boelter; area, D_h, flow area are jacket formulas                           |
| branch `seg`k        | coolant `customResistance` with the K(Re) friction table                                                      |

So T_wg (liner life) and T_wc (RP-1 coking), the two numbers a regen designer
actually wants, are solved unknowns, not post-processed estimates. The heat
into each cell is `h_eff · (T_aw − T_wg,solved)`, not a prescribed
`heatInput`.

The coolant branches solve with `settings.momentumFlux: true`: the heated,
decompressing RP-1 accelerates along the jacket, and each branch carries the
acceleration term (ṁ/A)²·(1/ρ_dn − 1/ρ_up) in its momentum equation.

### The flat view is a half-section

The 2-D canvas does not draw the network as a ladder of cells. Canvas x is the
axial station and canvas y is the local radius. The four rows of nodes
trace the contour they model: injector face at the left, flat barrel, 30°
convergent, throat pinch, 20° skirt flare, engine axis below. Column spacing
follows cell length, so the columns crowd through the throat and open out down
the skirt. Each cell's stack is ordered outward from the axis exactly as the
hardware is: the hot-gas T_aw reservoir inside the contour, then the
gas-side wall, the coolant-side wall, then the coolant.

Reading the canvas left to right walks the chamber. The _coolant_ runs the
other way, right to left, which is the counter-flow the jacket really is.

Radius is exaggerated 2.5× against the axial scale. A true-scale section of
this chamber is 3:1 long and thin and the throat pinch barely shows. Since
no physics is ever read from canvas coordinates, the stretch costs nothing. The
four rows are a second, unavoidable distortion. Liner and channel occupy
millimetres of a 133 mm throat radius, so at any honest radial scale they
would collapse onto the contour line. They sit at a fixed 105 px pitch
instead.

## 6. Results

Converged steady solve, 260 channels, inlet manifold at 16.440 MPa.

| Result                               | Value                                     |
| ------------------------------------ | ----------------------------------------- |
| Jacket flow                          | 95.0 kg/s (design 95.01)                  |
| Required pump discharge              | 16.44 MPa                                 |
| Manifold-to-manifold ΔP              | 4.44 MPa (44 % of P_c)                    |
| Jacket heat removed                  | 10.0 MW (~0.3 % of chamber thermal power) |
| Coolant                              | n-Dodecane, 300 K in, 348 K out           |
| Peak T_wc                            | 552 K at the skirt inlet (throat: 502 K)  |
| Momentum-flux share of the jacket ΔP | 24 kPa (solved, not estimated)            |
| Channel Reynolds                     | fully turbulent (> 10⁴)                   |

The solved heat load lands within 0.1 % of the 10.02 MW nominal quoted at  
T_wg = 550 K. The solved walls straddle that reference (508–568 K), and the  
conductance formulation makes the small local deviations self-correcting.

### The channel-count trade

The user can increase the number of channels to view the effect on wall temperature and pressure drop. Compared fairly with the same 95 kg/s fuel flow and inlet pressure retuned each time, wall temperature is bought with pump head:

| N       | pump discharge | jacket ΔP    | peak T_wc |
| ------- | -------------- | ------------ | --------- |
| 200     | 14.83 MPa      | 2.83 MPa     | 594 K     |
| **260** | **16.44 MPa**  | **4.44 MPa** | **552 K** |
| 320     | 19.50 MPa      | 7.50 MPa     | 518 K     |

Note how little coking margin 200 channels leaves: 594 K against a ~600 K limit.

## 7. Verification

This is not a real engine and therefore has no test data to verify against. However, sanity checks are consistent:

**Conservation.** The coolant's enthalpy rise, evaluated from CoolProp at the
solved inlet (`manifoldIn`) and outlet (`f1`) states, equals the heat conducted
through the twelve liner conductors. Per cell, the gas-film heat is exactly
`h_eff·A·(T_aw − T_wg,solved)` and equals the liner conduction (the `wg` node balance).

**Design closure.** 260 channels of this geometry pass 95.0 kg/s at the stated  
16.440 MPa; the coolant-side wall stays below  
the RP-1 coking threshold; and the hot spot is at the skirt inlet.

### Reported convection `h` runs ~2.3 % high

The solver rebuilds its convection h-map after convergence without the
under-relaxation the solve applied, so `conductors['film'k].heatTransferCoeff`
and its `heatRate` read about 2.3 % above the values the solution was built on.
The wall temperatures, node states and flows are consistent with the _converged_ coupling, not the report. The true coefficient is `liner`k`.heatRate / (area · (T_wc − T_f))`. This is general core behavior, not
specific to this example; see
[Solver convergence §4](solver-convergence.md#4-limitations). The
`liner` conductors are pure conduction and carry no h, which is why the
conservation test above asserts on those.

### Convergence reporting

The example ships `tolerance: 1e-8` and `maxIterations: 800`.

## 8. Known omissions

All quantified, all deliberate:

| Omission                                           | Measured size                                                                               | Note                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Area-taper share of the momentum flux              | dominant share of a ~400 kPa total; the density-driven ~24 kPa **is** solved                | the solved term uses one flow area per branch, so velocity-head changes between segments of different area (26 → 69 m/s into the throat) are not carried |
| Hydrostatic head                                   | 6.1 kPa, 0.15 %                                                                             | `customResistance` carries no elevation term                                                                                                             |
| Axial conduction along the liner                   | mesh-independent conductance `k·(arc pitch)` ≈ 1.0 W/K at the throat, 1.6 W/K in the barrel | not wired; a few percent of the local cell load at most                                                                                                  |
| Heat into the structural close-out                 | —                                                                                           | folded into the adiabatic-tip fin efficiency                                                                                                             |
| Curvature enhancement of h at the throat           | —                                                                                           | omitted, conservative                                                                                                                                    |
| Wall-to-bulk property correction on Dittus–Boelter | —                                                                                           | omitted, conservative                                                                                                                                    |
| Axial variation of T_aw                            | a few %                                                                                     | the recovery temperature droops slightly toward the skirt; one 3400 K value serves every cell                                                            |
| Nozzle gas dynamics                                | —                                                                                           | the hot side is a set of fixed-T reservoirs; a network momentum equation cannot represent a choked, supersonic core, and does not try                    |

On the momentum flux: `settings.momentumFlux` carries the acceleration a
branch's own density change causes, and at this design point that is worth
24 kPa. The larger share of the old ~400 kPa estimate came from the channel's
area taper, meaning the velocity head rising into the narrow throat cells and falling
again down the skirt, which a single-area-per-branch term cannot see. Much of
that share also cancels over the round trip; what survives is the difference
in velocity head between the two manifolds. The two coolant-side h omissions
would each raise h and lower T_wc, so the reported wall temperatures are the
pessimistic end of the band.

Axial conduction's conductance is `k·A/L` with `A` the arc pitch times the
cell length. Because `L` cancels out, `kA/L = k·(arc pitch)`. This value is independent of how
finely the jacket is diced. What refinement changes is the neighbour
temperature step.

## 9. Things to try

- Switch the liner material (wall `cp` and `liner`k `k`) from GRCop-84 to
  Inconel 718 or stainless 316 and watch T_wg climb. `kLiner` only freezes the
  rib fin efficiency, not conduction.
- Switch `mode` to `transient`. The solid nodes already carry mass and cp, so
  the model runs a chill-in/startup transient without edits.
- Raise `coolantInletTemperature` toward 340 K to see how little coking margin
  survives a warm-fuel start.
- Sweep `linerThickness`. The liner is a small share of the gas-to-coolant
  chain (the carbon deposit and the gas-side film own most of it), so thinning
  it buys far less than intuition suggests.
- Replace the constant depth with a tapered `depthSchedule` and watch the pump
  head rather than the wall temperature. That is where taper actually shows up.
- Edit an `aw` node's temperature for a throttled, cooler flame and watch
  the conjugate flux `h_eff · (T_aw − T_wg)` move. Edit `hgThroat` / the
  soot registers to retune the film. The Bartz formula on every `gasFilm`
  conductor picks them up.
- Set `settings.momentumFlux: false` and re-run. The jacket passes ~0.3 %
  more flow at the same pressures: the solved size of the acceleration term.
