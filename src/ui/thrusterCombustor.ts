/**
 * ============================================================================
 * LOX/RP-1 THRUSTER (COMBUSTOR) — CEA-coupled reacting junction, monolithic
 * ============================================================================
 *
 * Same plumbing as the "Basic LOX/RP-1 thruster" reference (basic-lox-rp1-
 * thruster.fn): a LOX feed through an injector orifice, an RP-1 feed through
 * a five-cell regenerative jacket then its own injector orifice, and a hot
 * gas circuit through a choked converging-diverging nozzle.  What is
 * DIFFERENT is how the two feed circuits couple to the gas: instead of a
 * static formula (mdot_gas = CdA_ox*sqrt(...) + CdA_fuel*sqrt(...)) and
 * fixed chamber-gas properties, this example declares the chamber node as a
 * REACTING JUNCTION (core/schema.ts JunctionConfig):
 *
 *   - both injector orifices run feed circuit -> chamber DIRECTLY (unlike
 *     fluids meet at the junction node — no manifold boundary nodes, no
 *     flowSource gas branch),
 *   - the chamber's energy equation is the thermochemical closure
 *     h = efficiency * h(T0(Pc, O/F)) with T0 from a real NASA CEA
 *     chemical-equilibrium lookup (core/combustion/combustionGas.ts),
 *     solved INSIDE the Newton system (core/solver/kernel.ts) together
 *     with mass and momentum — chamber pressure back-pressures the
 *     injectors through the shared pressure unknown, and
 *   - the gas's R/gamma/mu/cp refresh from the CEA lookup between outer
 *     Picard iterations (core/solver/step.ts property lag).
 *
 * REGEN WALL STACK (buildWallStack below): every gas station carries a
 * thermal conductor chain into its jacket cell — gas film (Bartz-order h,
 * scaled (Dt/D)^1.8) -> INNER LINER -> fin-root conduction -> FINS ->
 * fin-tip conduction -> OUTER SHELL (closeout), with coolant films on the
 * channel base (liner), the fin sides (fin efficiency folded into the
 * wetted area), and the channel top (shell).  The three copper layers are
 * separate solid nodes per station, so the radial gradient through the
 * liner and the fin temperature drop are resolved, station by station.
 * The chamber station's film uses the junction node's gas temperature; the
 * junction's energy row is the CEA closure, so that heat is computed from
 * the adiabatic-flame state without back-cooling the chamber gas (the
 * standard one-way chamber heat-flux approximation).
 *
 * See docs/combustion.md for the model and its limitations (steady +
 * kineticEnergy only, frozen composition through the nozzle, fixed feed
 * injection temperatures).
 *
 * The authored node/branch values below (pressures, temperatures,
 * initialMdot, fluids.gas params, wall-layer temperatures) are only the
 * Newton warm start; the solver owns everything from the first iteration.
 * They ARE the converged solution of this very formulation, so Run
 * re-certifies in a few outer iterations — but the monolithic formulation
 * also converges from far cruder guesses (see the robustness test in
 * src/core/__tests__/reactingJunction.test.ts).
 *
 * KNOWN DISCRETIZATION ARTIFACT (predates the junction work): with the
 * throat-clustered stations and CEA gas (gamma ~ 1.127), the exact discrete
 * roots of the quasi-1D transonic nozzle place the sonic transition inside
 * one of the tiny near-throat segments, and the local P/T at 1-2 stations
 * around it (conv6..div1) sit off the smooth curve.  The smooth textbook
 * profile is NOT an exact root of the discrete equations here — Newton
 * stalls ~500 Pa from it — while integral quantities (Pc, mdots, O/F,
 * thrust-relevant states) are solid; see docs/combustion.md.
 */
import type { Conductor, NetworkConfig, SolidNode } from "../core/schema";

const metres = (x: number, y = 0, z = 0) => ({ x, y, z });

/* ────────────────────────────────────────────────────────────────────────
 * Gas-path, coolant, and feed nodes (authored at the converged solution).
 * ──────────────────────────────────────────────────────────────────────── */
const nodes: NetworkConfig["nodes"] = [
  {
    id: "chamber",
    type: "internal",
    x: 469,
    y: 454,
    position: metres(0.04, 0, 0),
    pressure: 980579,
    temperature: 3190.69,
    fluid: "gas",
    label: "Chamber (reacting junction)",
  },
  {
    id: "barrel1",
    type: "internal",
    x: 634,
    y: 454,
    position: metres(0.04, 0, 0.05),
    pressure: 980447,
    temperature: 3184.93,
    fluid: "gas",
    label: "Chamber",
  },
  {
    id: "barrel2",
    type: "internal",
    x: 784,
    y: 454,
    position: metres(0.04, 0, 0.1),
    pressure: 980294,
    temperature: 3181.59,
    fluid: "gas",
    label: "Chamber",
  },
  {
    id: "conv1",
    type: "internal",
    x: 829,
    y: 529,
    position: metres(0.0353125, 0, 0.108119),
    pressure: 970812,
    temperature: 3177.09,
    fluid: "gas",
    label: "Convergent",
  },
  {
    id: "conv2",
    type: "internal",
    x: 874,
    y: 589,
    position: metres(0.03125, 0, 0.115155),
    pressure: 955031,
    temperature: 3170.25,
    fluid: "gas",
    label: "Convergent",
  },
  {
    id: "conv3",
    type: "internal",
    x: 919,
    y: 649,
    position: metres(0.0278125, 0, 0.121109),
    pressure: 929250,
    temperature: 3159.57,
    fluid: "gas",
    label: "Convergent",
  },
  {
    id: "conv4",
    type: "internal",
    x: 964,
    y: 694,
    position: metres(0.025, 0, 0.125981),
    pressure: 888297,
    temperature: 3142.73,
    fluid: "gas",
    label: "Convergent",
  },
  {
    id: "conv5",
    type: "internal",
    x: 1009,
    y: 724,
    position: metres(0.0228125, 0, 0.12977),
    pressure: 825303,
    temperature: 3116.06,
    fluid: "gas",
    label: "Convergent",
  },
  {
    id: "conv6",
    type: "internal",
    x: 1054,
    y: 754,
    position: metres(0.02125, 0, 0.132476),
    pressure: 358915,
    temperature: 2803.32,
    fluid: "gas",
    label: "Convergent",
  },
  {
    id: "conv7",
    type: "internal",
    x: 1099,
    y: 769,
    position: metres(0.0203125, 0, 0.1341),
    pressure: 737663,
    temperature: 3054.56,
    fluid: "gas",
    label: "Convergent",
  },
  {
    id: "throat",
    type: "internal",
    x: 1144,
    y: 769,
    position: metres(0.02, 0, 0.134641),
    pressure: 662848,
    temperature: 3017.92,
    fluid: "gas",
    label: "Throat",
  },
  {
    id: "div1",
    type: "internal",
    x: 1189,
    y: 769,
    position: metres(0.0201389, 0, 0.135159),
    pressure: 705130,
    temperature: 3038.82,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div2",
    type: "internal",
    x: 1234,
    y: 754,
    position: metres(0.0205556, 0, 0.136714),
    pressure: 439244,
    temperature: 2877.04,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div3",
    type: "internal",
    x: 1279,
    y: 754,
    position: metres(0.02125, 0, 0.139306),
    pressure: 372701,
    temperature: 2824.19,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div4",
    type: "internal",
    x: 1324,
    y: 739,
    position: metres(0.0222222, 0, 0.142934),
    pressure: 309658,
    temperature: 2765.83,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div5",
    type: "internal",
    x: 1369,
    y: 709,
    position: metres(0.0234722, 0, 0.1476),
    pressure: 253385,
    temperature: 2704.14,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div6",
    type: "internal",
    x: 1414,
    y: 694,
    position: metres(0.025, 0, 0.153301),
    pressure: 205040,
    temperature: 2640.69,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div7",
    type: "internal",
    x: 1459,
    y: 664,
    position: metres(0.0268056, 0, 0.16004),
    pressure: 164644,
    temperature: 2576.69,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div8",
    type: "internal",
    x: 1504,
    y: 634,
    position: metres(0.0288889, 0, 0.167815),
    pressure: 131576,
    temperature: 2513.13,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div9",
    type: "internal",
    x: 1549,
    y: 589,
    position: metres(0.03125, 0, 0.176627),
    pressure: 104912,
    temperature: 2450.76,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div10",
    type: "internal",
    x: 1594,
    y: 544,
    position: metres(0.0338889, 0, 0.186475),
    pressure: 83633.9,
    temperature: 2390.15,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "div11",
    type: "internal",
    x: 1639,
    y: 499,
    position: metres(0.0368056, 0, 0.19736),
    pressure: 66768.2,
    temperature: 2331.67,
    fluid: "gas",
    label: "Divergent",
  },
  {
    id: "exhaust",
    type: "boundary",
    x: 1682,
    y: 452,
    position: metres(0.04, 0, 0.209282),
    pressure: 43513.4,
    temperature: 1897.81,
    fluid: "gas",
    label: "Exhaust",
  },
  {
    id: "loxTank",
    type: "boundary",
    x: 77,
    y: 152,
    position: metres(0.2, 0.1, -0.1),
    pressure: 1300000,
    temperature: 90,
    fluid: "lox",
    label: "LOX tank",
  },
  {
    id: "coolant1",
    type: "internal",
    x: 634,
    y: 244,
    position: metres(0.046, 0, 0.05),
    pressure: 1301662,
    temperature: 445.88,
    fluid: "rp1",
    label: "RP-1 jacket 1",
  },
  {
    id: "coolant2",
    type: "internal",
    x: 964,
    y: 484,
    position: metres(0.031, 0, 0.125981),
    pressure: 1301059,
    temperature: 376.06,
    fluid: "rp1",
    label: "RP-1 jacket 2",
  },
  {
    id: "coolant3",
    type: "internal",
    x: 1144,
    y: 559,
    position: metres(0.026, 0, 0.134641),
    pressure: 1300990,
    temperature: 352.52,
    fluid: "rp1",
    label: "RP-1 jacket 3",
  },
  {
    id: "coolant4",
    type: "internal",
    x: 1414,
    y: 484,
    position: metres(0.031, 0, 0.153301),
    pressure: 1300842,
    temperature: 345.36,
    fluid: "rp1",
    label: "RP-1 jacket 4",
  },
  {
    id: "coolant5",
    type: "internal",
    x: 1594,
    y: 334,
    position: metres(0.0398889, 0, 0.186475),
    pressure: 1300578,
    temperature: 323.56,
    fluid: "rp1",
    label: "RP-1 jacket 5",
  },
  {
    id: "fuelTank",
    type: "boundary",
    x: 1772,
    y: 332,
    position: metres(0.046, 0, 0.259282),
    pressure: 1300000,
    temperature: 300,
    fluid: "rp1",
    label: "RP-1 tank",
  },
];

const branches: NetworkConfig["branches"] = [
  {
    id: "seg1",
    from: "chamber",
    to: "barrel1",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.05,
      diameter: 0.08,
      roughness: 0,
      frictionFactor: 0.02,
    },
    label: "Chamber",
  },
  {
    id: "seg2",
    from: "barrel1",
    to: "barrel2",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.05,
      diameter: 0.08,
      roughness: 0,
      frictionFactor: 0.02,
    },
    label: "Chamber",
  },
  {
    id: "seg3",
    from: "barrel2",
    to: "conv1",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00811899,
      diameter: 0.08,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.070625,
    },
    label: "Convergent",
  },
  {
    id: "seg4",
    from: "conv1",
    to: "conv2",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00703646,
      diameter: 0.070625,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0625,
    },
    label: "Convergent",
  },
  {
    id: "seg5",
    from: "conv2",
    to: "conv3",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00595392,
      diameter: 0.0625,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.055625,
    },
    label: "Convergent",
  },
  {
    id: "seg6",
    from: "conv3",
    to: "conv4",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00487139,
      diameter: 0.055625,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.05,
    },
    label: "Convergent",
  },
  {
    id: "seg7",
    from: "conv4",
    to: "conv5",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00378886,
      diameter: 0.05,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.045625,
    },
    label: "Convergent",
  },
  {
    id: "seg8",
    from: "conv5",
    to: "conv6",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00270633,
      diameter: 0.045625,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0425,
    },
    label: "Convergent",
  },
  {
    id: "seg9",
    from: "conv6",
    to: "conv7",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.0016238,
      diameter: 0.0425,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.040625,
    },
    label: "Convergent",
  },
  {
    id: "seg10",
    from: "conv7",
    to: "throat",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.000541266,
      diameter: 0.040625,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.04,
    },
    label: "Convergent",
  },
  {
    id: "seg11",
    from: "throat",
    to: "div1",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00051834,
      diameter: 0.04,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0402778,
    },
    label: "Divergent",
  },
  {
    id: "seg12",
    from: "div1",
    to: "div2",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00155502,
      diameter: 0.0402778,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0411111,
    },
    label: "Divergent",
  },
  {
    id: "seg13",
    from: "div2",
    to: "div3",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.0025917,
      diameter: 0.0411111,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0425,
    },
    label: "Divergent",
  },
  {
    id: "seg14",
    from: "div3",
    to: "div4",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00362838,
      diameter: 0.0425,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0444444,
    },
    label: "Divergent",
  },
  {
    id: "seg15",
    from: "div4",
    to: "div5",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00466506,
      diameter: 0.0444444,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0469444,
    },
    label: "Divergent",
  },
  {
    id: "seg16",
    from: "div5",
    to: "div6",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00570174,
      diameter: 0.0469444,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.05,
    },
    label: "Divergent",
  },
  {
    id: "seg17",
    from: "div6",
    to: "div7",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00673843,
      diameter: 0.05,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0536111,
    },
    label: "Divergent",
  },
  {
    id: "seg18",
    from: "div7",
    to: "div8",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00777511,
      diameter: 0.0536111,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0577778,
    },
    label: "Divergent",
  },
  {
    id: "seg19",
    from: "div8",
    to: "div9",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00881179,
      diameter: 0.0577778,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0625,
    },
    label: "Divergent",
  },
  {
    id: "seg20",
    from: "div9",
    to: "div10",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.00984847,
      diameter: 0.0625,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0677778,
    },
    label: "Divergent",
  },
  {
    id: "seg21",
    from: "div10",
    to: "div11",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.0108851,
      diameter: 0.0677778,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.0736111,
    },
    label: "Divergent",
  },
  {
    id: "seg22",
    from: "div11",
    to: "exhaust",
    initialMdot: 0.782432,
    component: {
      type: "pipe",
      length: 0.0119218,
      diameter: 0.0736111,
      roughness: 0,
      frictionFactor: 0.02,
      diameterOut: 0.08,
    },
    label: "Divergent",
  },
  {
    id: "loxInjector",
    from: "loxTank",
    to: "chamber",
    initialMdot: 0.564682,
    component: { type: "orifice", area: 0.0000321774, cd: 0.65 },
    label: "LOX injector orifice (junction inlet)",
  },
  {
    id: "jacketIn",
    from: "fuelTank",
    to: "coolant5",
    initialMdot: 0.21775,
    component: {
      type: "pipe",
      length: 0.05,
      diameter: 0.015,
      roughness: 0,
      frictionFactor: 0,
    },
    label: "Tank -> jacket inlet",
  },
  {
    id: "jacket5to4",
    from: "coolant5",
    to: "coolant4",
    initialMdot: 0.21775,
    component: {
      type: "pipe",
      length: 0.033174,
      diameter: 0.015,
      roughness: 0,
      frictionFactor: 0,
    },
    label: "Jacket pass 5 -> 4",
  },
  {
    id: "jacket4to3",
    from: "coolant4",
    to: "coolant3",
    initialMdot: 0.21775,
    component: {
      type: "pipe",
      length: 0.01866,
      diameter: 0.015,
      roughness: 0,
      frictionFactor: 0,
    },
    label: "Jacket pass 4 -> 3",
  },
  {
    id: "jacket3to2",
    from: "coolant3",
    to: "coolant2",
    initialMdot: 0.21775,
    component: {
      type: "pipe",
      length: 0.0086603,
      diameter: 0.015,
      roughness: 0,
      frictionFactor: 0,
    },
    label: "Jacket pass 3 -> 2",
  },
  {
    id: "jacket2to1",
    from: "coolant2",
    to: "coolant1",
    initialMdot: 0.21775,
    component: {
      type: "pipe",
      length: 0.075981,
      diameter: 0.015,
      roughness: 0,
      frictionFactor: 0,
    },
    label: "Jacket pass 2 -> 1",
  },
  {
    id: "fuelInjector",
    from: "coolant1",
    to: "chamber",
    initialMdot: 0.21775,
    component: { type: "orifice", area: 0.0000146885, cd: 0.65 },
    label: "RP-1 injector orifice (junction inlet)",
  },
];

/* ────────────────────────────────────────────────────────────────────────
 * Regenerative-cooling wall stack — one three-layer copper section and a
 * six-conductor chain PER GAS STATION.
 *
 * Radial build (per station, D = local gas-side diameter):
 *
 *     gas  ── film ──▶  INNER LINER (t = LINER_T)
 *                          │  fin-root conduction (solidity × root annulus)
 *                          ▼
 *                        FINS (ribs, height CHANNEL_H, thickness FIN_T)
 *                          │  fin-tip conduction
 *                          ▼
 *                        OUTER SHELL (closeout, t = SHELL_T)
 *
 *     coolant films: channel base (liner, 1−solidity of the annulus),
 *     fin sides (2·H/FIN_T per unit root width, derated by FIN_EFF),
 *     channel top (shell, 1−solidity).
 *
 * Gas film h is the Bartz-order throat value scaled (Dt/D)^1.8; each
 * station's wetted area is π·D·L with L the tributary half-lengths of its
 * adjacent nozzle segments.  All lumped masses are geometric (OFHC copper)
 * so the same network is transient-ready.
 * ──────────────────────────────────────────────────────────────────────── */
const LINER_T = 0.0015; // inner liner radial thickness [m]
const CHANNEL_H = 0.003; // coolant channel / fin height [m]
const SHELL_T = 0.0015; // closeout shell thickness [m]
const FIN_SOLIDITY = 0.3; // circumference fraction occupied by fin roots
const FIN_T = 0.001; // individual fin (rib) thickness [m]
const FIN_EFF = 0.8; // fin efficiency folded into the fin wetted area
const H_COOLANT = 15000; // coolant film coefficient [W/m^2 K]
const H_GAS_THROAT = 1500; // Bartz-order gas film at the throat [W/m^2 K]
const THROAT_D = 0.04; // throat diameter [m]
const CU_RHO = 8940; // OFHC copper density [kg/m^3]
const COPPER = { material: "ofhc-copper" } as const;

/** Gas stations in flow order.  `cell` is the jacket cell the station's
 *  coolant films connect to; `T` = [liner, fin, shell] authored warm-start
 *  temperatures [K] (re-authored from the converged solve). */
const GAS_STATIONS: Array<{
  id: string;
  cell: 1 | 2 | 3 | 4 | 5;
  T: [number, number, number];
}> = [
  { id: "chamber", cell: 1, T: [483.3, 469.47, 465.56] },
  { id: "barrel1", cell: 1, T: [483.22, 469.42, 465.52] },
  { id: "barrel2", cell: 1, T: [483.18, 469.39, 465.49] },
  { id: "conv1", cell: 2, T: [423.42, 405.88, 400.94] },
  { id: "conv2", cell: 2, T: [434.32, 412.71, 406.63] },
  { id: "conv3", cell: 2, T: [446.82, 420.52, 413.15] },
  { id: "conv4", cell: 2, T: [460.24, 428.89, 420.14] },
  { id: "conv5", cell: 2, T: [473.22, 436.97, 426.88] },
  { id: "conv6", cell: 3, T: [450.26, 413.75, 403.6] },
  { id: "conv7", cell: 3, T: [468.6, 425.19, 413.14] },
  { id: "throat", cell: 3, T: [469.98, 426.04, 413.85] },
  { id: "div1", cell: 3, T: [469.56, 425.78, 413.64] },
  { id: "div2", cell: 3, T: [458.87, 419.11, 408.07] },
  { id: "div3", cell: 4, T: [444.23, 407.3, 397.03] },
  { id: "div4", cell: 4, T: [435.01, 401.55, 392.24] },
  { id: "div5", cell: 4, T: [425.12, 395.39, 387.1] },
  { id: "div6", cell: 4, T: [415.2, 389.2, 381.93] },
  { id: "div7", cell: 4, T: [405.74, 383.28, 377.0] },
  { id: "div8", cell: 5, T: [375.75, 356.37, 350.93] },
  { id: "div9", cell: 5, T: [367.91, 351.46, 346.84] },
  { id: "div10", cell: 5, T: [361.07, 347.17, 343.26] },
  { id: "div11", cell: 5, T: [355.18, 343.48, 340.18] },
];

function buildWallStack(): {
  solidNodes: SolidNode[];
  conductors: Conductor[];
} {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const branchById = new Map(branches.map((b) => [b.id, b]));
  const pipeOf = (segId: string) => {
    const c = branchById.get(segId)!.component;
    if (c.type !== "pipe") throw new Error(`${segId} is not a pipe`);
    return c;
  };

  const solidNodes: SolidNode[] = [];
  const conductors: Conductor[] = [];

  GAS_STATIONS.forEach((st, i) => {
    const gas = nodeById.get(st.id)!;
    const cool = nodeById.get(`coolant${st.cell}`)!;
    // Local diameter = inlet diameter of the outgoing segment; tributary
    // length = half of each adjacent segment.
    const out = pipeOf(`seg${i + 1}`);
    const D = out.diameter as number;
    const L =
      ((i > 0 ? (pipeOf(`seg${i}`).length as number) : 0) +
        (out.length as number)) /
      2;
    const z = (gas.position?.z as number) ?? 0;

    const D1 = D + 2 * LINER_T; // fin-root (channel base) circle
    const D2 = D1 + 2 * CHANNEL_H; // fin-tip (channel top) circle
    const areaGas = Math.PI * D * L;
    const areaBase = (1 - FIN_SOLIDITY) * Math.PI * D1 * L;
    const areaTop = (1 - FIN_SOLIDITY) * Math.PI * D2 * L;
    const areaFinRoot = FIN_SOLIDITY * Math.PI * D1 * L;
    const areaFinTip = FIN_SOLIDITY * Math.PI * D2 * L;
    // N fins of thickness FIN_T: sides expose 2·H per fin per unit length.
    const areaFinSides =
      FIN_EFF * 2 * CHANNEL_H * ((FIN_SOLIDITY * Math.PI * D1) / FIN_T) * L;
    const hGas = H_GAS_THROAT * Math.pow(THROAT_D / D, 1.8);

    // Canvas: stack the three layers along the gas-node -> coolant-node line.
    const at = (f: number) => ({
      x: Math.round(gas.x + f * (cool.x - gas.x)),
      y: Math.round(gas.y + f * (cool.y - gas.y)),
    });

    const layers: Array<{
      key: "Liner" | "Fin" | "Shell";
      label: string;
      r: number;
      mass: number;
      T: number;
      f: number;
    }> = [
      {
        key: "Liner",
        label: `Inner liner @ ${st.id}`,
        r: (D + LINER_T) / 2,
        mass: CU_RHO * Math.PI * (D + LINER_T) * L * LINER_T,
        T: st.T[0],
        f: 0.3,
      },
      {
        key: "Fin",
        label: `Channel fins @ ${st.id}`,
        r: (D1 + CHANNEL_H) / 2,
        mass: CU_RHO * FIN_SOLIDITY * Math.PI * (D1 + CHANNEL_H) * L * CHANNEL_H,
        T: st.T[1],
        f: 0.5,
      },
      {
        key: "Shell",
        label: `Outer shell @ ${st.id}`,
        r: (D2 + SHELL_T) / 2,
        mass: CU_RHO * Math.PI * (D2 + SHELL_T) * L * SHELL_T,
        T: st.T[2],
        f: 0.7,
      },
    ];
    for (const layer of layers) {
      const { x, y } = at(layer.f);
      solidNodes.push({
        id: `${st.id}${layer.key}`,
        type: "solid",
        x,
        y,
        position: metres(layer.r, 0, z),
        temperature: layer.T,
        mass: layer.mass,
        cp: COPPER,
        label: layer.label,
      });
    }

    conductors.push(
      {
        id: `${st.id}GasFilm`,
        from: st.id,
        to: `${st.id}Liner`,
        type: { kind: "convection", h: hGas, area: areaGas },
        label: `Gas film @ ${st.id} (Bartz-order h)`,
      },
      {
        id: `${st.id}FinRoot`,
        from: `${st.id}Liner`,
        to: `${st.id}Fin`,
        type: {
          kind: "conduction",
          k: COPPER,
          area: areaFinRoot,
          length: (LINER_T + CHANNEL_H) / 2,
        },
        label: `Fin-root conduction @ ${st.id}`,
      },
      {
        id: `${st.id}FinTip`,
        from: `${st.id}Fin`,
        to: `${st.id}Shell`,
        type: {
          kind: "conduction",
          k: COPPER,
          area: areaFinTip,
          length: (CHANNEL_H + SHELL_T) / 2,
        },
        label: `Fin-tip conduction @ ${st.id}`,
      },
      {
        id: `${st.id}BaseFilm`,
        from: `${st.id}Liner`,
        to: `coolant${st.cell}`,
        type: { kind: "convection", h: H_COOLANT, area: areaBase },
        label: `Coolant film, channel base @ ${st.id}`,
      },
      {
        id: `${st.id}FinFilm`,
        from: `${st.id}Fin`,
        to: `coolant${st.cell}`,
        type: { kind: "convection", h: H_COOLANT, area: areaFinSides },
        label: `Coolant film, fin sides @ ${st.id}`,
      },
      {
        id: `${st.id}ShellFilm`,
        from: `${st.id}Shell`,
        to: `coolant${st.cell}`,
        type: { kind: "convection", h: H_COOLANT, area: areaTop },
        label: `Coolant film, channel top @ ${st.id}`,
      },
    );
  });

  return { solidNodes, conductors };
}

const wallStack = buildWallStack();

export const thrusterCombustor: NetworkConfig = {
  meta: { name: "LOX/RP-1 thruster (combustor)", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-8,
    maxIterations: 800,
    relaxation: 0.6,
    momentumFlux: true,
    kineticEnergy: true,
  },
  // Network default (no node references it — every node names a fluid).
  fluid: {
    model: "idealGas",
    params: { R: 361.49837, gamma: 1.2, mu: 0.00008, cp: 2168.9902 },
  },
  fluids: {
    // Combustion-product gas: these params are only the first iterate's
    // guess — the junction's property lag refreshes R/gamma/mu/cp from the
    // CEA lookup at the solved (Pc, O/F) every outer iteration.  Authored
    // at the CEA values for the converged (Pc, O/F) so the first refresh is
    // a no-op: a far-off guess (e.g. frozen-flow gamma = 1.2) makes the
    // first property swap a large mid-solve perturbation that can push
    // Newton into a different root basin of the transonic nozzle.
    gas: {
      model: "idealGas",
      params: { R: 363.5917, gamma: 1.126585, mu: 0.000106118, cp: 3235.902 },
    },
    lox: { model: "incompressible", params: { rho: 1141, mu: 0.000195, cp: 1700 } },
    rp1: { model: "incompressible", params: { rho: 810, mu: 0.0017, cp: 2000 } },
  },
  junctions: [
    {
      id: "mainCombustor",
      label: "LOX/RP-1 combustor",
      node: "chamber",
      inlets: [
        { branch: "loxInjector", role: "oxidizer" },
        { branch: "fuelInjector", role: "fuel" },
      ],
      model: {
        type: "ceaTable",
        propellants: "lox-rp1",
        // Enthalpy-rise efficiency = etaCstar^2 with etaCstar = 0.97.
        efficiency: 0.9409,
      },
      productFluid: "gas",
    },
  ],
  nodes,
  solidNodes: wallStack.solidNodes,
  branches,
  conductors: wallStack.conductors,
  notes: [
    {
      id: "noteOverview",
      text:
        "LOX/RP-1 THRUSTER (COMBUSTOR) — same three circuits as the basic thruster example, but the chamber is a REACTING JUNCTION: both injectors discharge straight into it, and the hot-gas state comes from a real NASA CEA chemical-equilibrium lookup solved inside the core Newton system.\n" +
        "1) LOX: tank -> injector orifice -> chamber.\n" +
        "2) RP-1: tank -> regen cooling jacket (counter-flow) -> injector orifice -> chamber.\n" +
        "3) Hot gas: chamber -> choked converging-diverging nozzle -> exhaust.\n" +
        "Press Run.",
      x: 60,
      y: 435,
      width: 430,
    },
    {
      id: "noteCombustor",
      text:
        'THE junctions ENTRY CLOSES THE LOOP (see model text / .fn for "mainCombustor"): the chamber node\'s energy equation is h = efficiency * h(T0(Pc, O/F)) with T0 from NASA CEA equilibrium tables, solved SIMULTANEOUSLY with mass and momentum — chamber pressure back-pressures both injectors through the shared pressure unknown, so there is no outer fixed-point loop to diverge.\n' +
        "The gas R/gamma/mu/cp refresh from the same lookup between outer property iterations. efficiency = 0.9409 (= 0.97^2) applies a combustion-efficiency loss to the CEA enthalpy rise.",
      x: 60,
      y: 720,
      width: 430,
    },
    {
      id: "noteNozzle",
      text:
        "CHOKED CD NOZZLE (see the 'Rocket combustion chamber' example): momentumFlux + kineticEnergy on, throat-clustered stations, initialMdot warm start on every duct branch.\n" +
        "The gas properties here are not fixed: gamma, R, mu, cp all update from the CEA lookup as O/F and Pc converge, so the choking condition itself moves during the solve.",
      x: 1095,
      y: 870,
      width: 430,
    },
    {
      id: "noteRegen",
      text:
        "REGEN COOLING — every gas station has its own wall section: gas film (Bartz-order h, scaled (Dt/D)^1.8) -> INNER LINER -> fin conduction -> FINS -> OUTER SHELL, with coolant films on the channel base, fin sides (fin efficiency 0.8), and channel top.  All three copper layers are separate solid nodes, so the liner-to-shell radial gradient is resolved at all 22 stations.\n" +
        "The full fuel flow runs nozzle-exit -> injector through 5 jacket cells before its orifice; each station's coolant films connect to the cell spanning it. Watch the liner and RP-1 temperatures after Run.",
      x: 1485,
      y: 75,
      width: 430,
    },
  ],
};
