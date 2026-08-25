/**
 * ============================================================================
 * LOX/RP-1 THRUSTER (COMBUSTOR) — CEA-coupled reacting junction, monolithic
 * ============================================================================
 *
 * Three circuits: a LOX feed through an injector orifice, an RP-1 feed
 * through a station-by-station regenerative jacket (one coolant node per
 * wall section, counterflow) then its own injector orifice, and a hot gas
 * circuit through a choked converging-diverging nozzle.  The two feed
 * circuits couple to the gas at a REACTING JUNCTION (core/schema.ts
 * JunctionConfig) rather than a static injector formula
 * (mdot_gas = CdA_ox*sqrt(...) + CdA_fuel*sqrt(...)) with fixed chamber-gas
 * properties:
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
 * REGEN WALL STACK (buildRegenSystem below): every gas station carries a
 * thermal conductor chain into its OWN RP-1 jacket node — gas film
 * (Bartz-order h, scaled (Dt/D)^1.8) -> INNER LINER -> fin-root conduction ->
 * FINS -> fin-tip conduction -> OUTER SHELL (closeout), with coolant films on
 * the channel base (liner), the fin sides (fin efficiency folded into the
 * wetted area), and the channel top (shell).  The three copper layers are
 * separate solid nodes per station, so the radial gradient through the liner
 * and the fin temperature drop are resolved, station by station.  The chamber
 * station's film uses the junction node's gas temperature; the junction's
 * energy row is the CEA closure, so that heat is computed from the
 * adiabatic-flame state without back-cooling the chamber gas (the standard
 * one-way chamber heat-flux approximation).
 *
 * See docs/combustion.md for the model and its limitations (steady +
 * kineticEnergy only, frozen composition through the nozzle, fixed feed
 * injection temperatures).
 *
 * ── GRID ────────────────────────────────────────────────────────────────
 * The gas path is authored as a single GAS_STATIONS table (contour position
 * and diameter, plus the warm start); everything else — nozzle segments,
 * coolant nodes, the three copper layers, the six conductors per station and
 * the counterflow jacket — is generated from it, so re-gridding the nozzle is
 * a table edit rather than a rewrite.
 *
 * The nozzle carries TWO stations per contour segment of the original coarse
 * build.  That resolution is not cosmetic: the discrete choking condition is
 * set at the sonic cell, and on the coarse grid it put the choked mass flow
 * ~5.7 % above the ideal 1-D relation.  Refining the convergent AND the
 * divergent together roughly halves both that integral bias and the
 * downstream profile error.  Refining only near the throat is NOT a
 * shortcut — it does improve the choked flow, but the downstream Mach
 * profile is set by the divergent's own truncation and gets worse if the
 * divergent is left coarse.  See docs/validation/combustion-report.md.
 *
 * ── EXHAUST BOUNDARY ────────────────────────────────────────────────────
 * `exhaust` is a SUPERSONIC outlet.  Boundary nodes impose a static
 * pressure, which over-specifies such an outlet: the imposed value
 * back-propagates into the last interior station through that segment's
 * momentum row (on the coarse build it moved the final station's Mach by
 * ~10 points on its own, with the mass flow untouched).  EXHAUST_P is
 * therefore authored at the MATCHED-EXPANSION pressure — the value the
 * quasi-1-D ODE produces when continued across the final segment from the
 * converged interior — so the boundary agrees with the solution instead of
 * fighting it.  Re-author it (a short fixed-point loop) if the contour, the
 * friction factor, or the operating point changes.
 *
 * TRANSONIC DISCRETIZATION (settings.momentumFluxScheme in core/schema.ts):
 * the default limited-upwind momentum faces have no nonphysical "expansion
 * shock" roots by construction.  Under the legacy central scheme this grid
 * converges — but onto a certified-INADMISSIBLE root, with a discrete
 * expansion shock in the convergent (a station jumping to the supersonic
 * branch away from the area minimum) that the second-law audit flags; an
 * exact isentropic seed lands on the same pathology.  Under the upwind faces
 * the solve is seed-robust: the same physical root is reached from the
 * authored warm start, from an exact isentropic profile, and from the
 * historical artifact root.  The cost is first-order accuracy at the sonic
 * cell — the choked mass flow sits a few percent above the ideal relation
 * (GFSSP-class) — while integral quantities (Pc, O/F, thrust-relevant
 * states) are solid; see docs/combustion.md.
 *
 * The authored node/branch values below are only the Newton warm start; the
 * solver owns everything from the first iteration.  They ARE the converged
 * solution of this very formulation, so Run re-certifies in a few outer
 * iterations — but the monolithic formulation also converges from far cruder
 * guesses (see the robustness test in
 * src/core/__tests__/reactingJunction.test.ts).
 */
import type { Conductor, NetworkConfig, SolidNode } from "../core/schema";

export const metres = (x: number, y = 0, z = 0) => ({ x, y, z });

/* ────────────────────────────────────────────────────────────────────────
 * Gas path.
 *
 * `z`/`D` are the nozzle contour (diameter varies linearly between adjacent
 * stations, so each segment is a straight taper); `P`/`T` are the gas
 * warm start; `wall` is [liner, fin, shell] and `coolT`/`coolP` the RP-1
 * jacket node — all authored at the converged solution.
 * ──────────────────────────────────────────────────────────────────────── */
export interface GasStation {
  id: string;
  z: number; // axial position [m]
  D: number; // gas-side diameter [m]
  P: number; // static pressure [Pa]
  T: number; // static temperature [K]
  wall: [number, number, number]; // liner, fin, shell temperatures [K]
  coolT: number; // jacket node temperature [K]
  coolP: number; // jacket node pressure [Pa]
}

export const GAS_STATIONS: GasStation[] = [
  {
    id: "chamber",
    z: 0,
    D: 0.08,
    P: 993567,
    T: 3192.19,
    wall: [487.971, 474.151, 470.245],
    coolT: 450.589,
    coolP: 1302060,
  },
  {
    id: "barrel1",
    z: 0.05,
    D: 0.08,
    P: 993444,
    T: 3186.28,
    wall: [471.057, 457.181, 453.259],
    coolT: 433.523,
    coolP: 1301662,
  },
  {
    id: "barrel2",
    z: 0.1,
    D: 0.08,
    P: 993289,
    T: 3183.04,
    wall: [437.051, 423.018, 419.052],
    coolT: 399.092,
    coolP: 1301265,
  },
  {
    id: "conv1",
    z: 0.104059,
    D: 0.0753125,
    P: 989594,
    T: 3181.16,
    wall: [422.661, 406.977, 402.549],
    coolT: 380.267,
    coolP: 1301233,
  },
  {
    id: "conv2",
    z: 0.108119,
    D: 0.070625,
    P: 984331,
    T: 3178.74,
    wall: [424.656, 407.115, 402.171],
    coolT: 377.287,
    coolP: 1301201,
  },
  {
    id: "conv3",
    z: 0.111637,
    D: 0.0665625,
    P: 978049,
    T: 3175.96,
    wall: [426.808, 407.372, 401.9],
    coolT: 374.363,
    coolP: 1301173,
  },
  {
    id: "conv4",
    z: 0.115155,
    D: 0.0625,
    P: 969438,
    T: 3172.28,
    wall: [429.917, 408.255, 402.166],
    coolT: 371.521,
    coolP: 1301145,
  },
  {
    id: "conv5",
    z: 0.118132,
    D: 0.0590625,
    P: 959273,
    T: 3168.04,
    wall: [433.042, 409.179, 402.48],
    coolT: 368.77,
    coolP: 1301121,
  },
  {
    id: "conv6",
    z: 0.121109,
    D: 0.055625,
    P: 945434,
    T: 3162.3,
    wall: [437.217, 410.8, 403.396],
    coolT: 366.137,
    coolP: 1301098,
  },
  {
    id: "conv7",
    z: 0.123545,
    D: 0.0528125,
    P: 929535,
    T: 3155.8,
    wall: [441.118, 412.295, 404.229],
    coolT: 363.636,
    coolP: 1301078,
  },
  {
    id: "conv8",
    z: 0.125981,
    D: 0.05,
    P: 908225,
    T: 3146.88,
    wall: [446.053, 414.493, 405.675],
    coolT: 361.298,
    coolP: 1301059,
  },
  {
    id: "conv9",
    z: 0.127876,
    D: 0.0478125,
    P: 884594,
    T: 3137.09,
    wall: [450.238, 416.286, 406.813],
    coolT: 359.137,
    coolP: 1301044,
  },
  {
    id: "conv10",
    z: 0.12977,
    D: 0.045625,
    P: 853721,
    T: 3123.5,
    wall: [455.277, 418.687, 408.493],
    coolT: 357.189,
    coolP: 1301029,
  },
  {
    id: "conv11",
    z: 0.131123,
    D: 0.0440625,
    P: 820979,
    T: 3109.3,
    wall: [458.931, 420.308, 409.56],
    coolT: 355.467,
    coolP: 1301018,
  },
  {
    id: "conv12",
    z: 0.132476,
    D: 0.0425,
    P: 779777,
    T: 3089.5,
    wall: [463.104, 422.345, 411.016],
    coolT: 354.001,
    coolP: 1301007,
  },
  {
    id: "conv13",
    z: 0.133288,
    D: 0.0415625,
    P: 738487,
    T: 3070.24,
    wall: [465.25, 423.222, 411.55],
    coolT: 352.805,
    coolP: 1301001,
  },
  {
    id: "conv14",
    z: 0.1341,
    D: 0.040625,
    P: 689249,
    T: 3043.53,
    wall: [467.536, 424.293, 412.293],
    coolT: 351.899,
    coolP: 1300994,
  },
  {
    id: "conv15",
    z: 0.134371,
    D: 0.0403125,
    P: 644005,
    T: 3020.66,
    wall: [467.435, 423.995, 411.944],
    coolT: 351.291,
    coolP: 1300992,
  },
  {
    id: "throat",
    z: 0.134641,
    D: 0.04,
    P: 595147,
    T: 2990.74,
    wall: [467.319, 423.802, 411.732],
    coolT: 350.988,
    coolP: 1300990,
  },
  {
    id: "div1",
    z: 0.1349,
    D: 0.0401389,
    P: 552054,
    T: 2966.2,
    wall: [465.302, 422.432, 410.541],
    coolT: 350.693,
    coolP: 1300988,
  },
  {
    id: "div2",
    z: 0.135159,
    D: 0.0402778,
    P: 508674,
    T: 2936.16,
    wall: [463.073, 420.933, 409.243],
    coolT: 350.408,
    coolP: 1300986,
  },
  {
    id: "div3",
    z: 0.135937,
    D: 0.0406945,
    P: 469857,
    T: 2910.15,
    wall: [459.531, 418.516, 407.133],
    coolT: 349.845,
    coolP: 1300980,
  },
  {
    id: "div4",
    z: 0.136714,
    D: 0.0411111,
    P: 430204,
    T: 2877.39,
    wall: [455.534, 415.712, 404.656],
    coolT: 349.015,
    coolP: 1300974,
  },
  {
    id: "div5",
    z: 0.13801,
    D: 0.0418056,
    P: 394758,
    T: 2849.86,
    wall: [450.468, 412.148, 401.503],
    coolT: 347.931,
    coolP: 1300963,
  },
  {
    id: "div6",
    z: 0.139306,
    D: 0.0425,
    P: 358757,
    T: 2814.5,
    wall: [445.035, 408.263, 398.043],
    coolT: 346.605,
    coolP: 1300953,
  },
  {
    id: "div7",
    z: 0.14112,
    D: 0.0434722,
    P: 326978,
    T: 2785.78,
    wall: [438.828, 403.813, 394.073],
    coolT: 345.055,
    coolP: 1300939,
  },
  {
    id: "div8",
    z: 0.142934,
    D: 0.0444444,
    P: 295110,
    T: 2748.36,
    wall: [432.373, 399.127, 389.872],
    coolT: 343.296,
    coolP: 1300924,
  },
  {
    id: "div9",
    z: 0.145267,
    D: 0.0456944,
    P: 267391,
    T: 2718.99,
    wall: [425.441, 394.073, 385.333],
    coolT: 341.347,
    coolP: 1300906,
  },
  {
    id: "div10",
    z: 0.1476,
    D: 0.0469444,
    P: 239954,
    T: 2680.21,
    wall: [418.38, 388.869, 380.639],
    coolT: 339.223,
    coolP: 1300887,
  },
  {
    id: "div11",
    z: 0.15045,
    D: 0.0484722,
    P: 216410,
    T: 2650.79,
    wall: [411.107, 383.476, 375.763],
    coolT: 336.946,
    coolP: 1300864,
  },
  {
    id: "div12",
    z: 0.153301,
    D: 0.05,
    P: 193372,
    T: 2611.39,
    wall: [403.805, 378.009, 370.801],
    coolT: 334.528,
    coolP: 1300842,
  },
  {
    id: "div13",
    z: 0.15667,
    D: 0.0518056,
    P: 173824,
    T: 2582.43,
    wall: [396.501, 372.496, 365.782],
    coolT: 331.992,
    coolP: 1300815,
  },
  {
    id: "div14",
    z: 0.16004,
    D: 0.0536111,
    P: 154872,
    T: 2543.07,
    wall: [389.242, 366.968, 360.732],
    coolT: 329.348,
    coolP: 1300788,
  },
  {
    id: "div15",
    z: 0.163928,
    D: 0.0556945,
    P: 138932,
    T: 2514.98,
    wall: [382.129, 361.498, 355.717],
    coolT: 326.618,
    coolP: 1300757,
  },
  {
    id: "div16",
    z: 0.167815,
    D: 0.0577778,
    P: 123589,
    T: 2476.22,
    wall: [375.111, 356.056, 350.711],
    coolT: 323.808,
    coolP: 1300727,
  },
  {
    id: "div17",
    z: 0.172221,
    D: 0.0601389,
    P: 110768,
    T: 2449.3,
    wall: [368.33, 350.74, 345.801],
    coolT: 320.941,
    coolP: 1300692,
  },
  {
    id: "div18",
    z: 0.176627,
    D: 0.0625,
    P: 98489.9,
    T: 2411.57,
    wall: [361.67, 345.478, 340.926],
    coolT: 318.02,
    coolP: 1300657,
  },
  {
    id: "div19",
    z: 0.181551,
    D: 0.0651389,
    P: 88275.9,
    T: 2385.99,
    wall: [355.295, 340.381, 336.185],
    coolT: 315.065,
    coolP: 1300617,
  },
  {
    id: "div20",
    z: 0.186475,
    D: 0.0677778,
    P: 78528.3,
    T: 2349.59,
    wall: [349.052, 335.352, 331.494],
    coolT: 312.076,
    coolP: 1300578,
  },
  {
    id: "div21",
    z: 0.191918,
    D: 0.0706945,
    P: 70441.5,
    T: 2325.46,
    wall: [343.11, 330.506, 326.954],
    coolT: 309.073,
    coolP: 1300535,
  },
  {
    id: "div22",
    z: 0.19736,
    D: 0.0736111,
    P: 62713.8,
    T: 2290.17,
    wall: [337.291, 325.73, 322.468],
    coolT: 306.052,
    coolP: 1300492,
  },
  {
    id: "div23",
    z: 0.203321,
    D: 0.0768056,
    P: 56714.2,
    T: 2274.26,
    wall: [331.875, 321.207, 318.195],
    coolT: 303.034,
    coolP: 1300445,
  },
];

/** Nozzle exit plane (boundary node).  See the EXHAUST BOUNDARY note above:
 *  the pressure is the matched-expansion value, not an ambient pressure. */
export const EXHAUST = { z: 0.209282, D: 0.08, P: 50939.4, T: 2283.56 };

/** Warm-start mass flows [kg/s]. */
export const MDOT_GAS = 0.766519;
export const MDOT_OX = 0.553082;
export const MDOT_FUEL = 0.213437;

const FRICTION_F = 0.02; // authored constant Darcy factor on every gas segment

/* ────────────────────────────────────────────────────────────────────────
 * Canvas layout — schematic pixels.  x marches with station index (the
 * barrel is stretched so the chamber reads as a chamber); y traces the wall
 * contour, so the node chain draws the nozzle.
 * ──────────────────────────────────────────────────────────────────────── */
const NOZZLE_X0 = 829; // canvas x of the first convergent station
const NOZZLE_PITCH = 22;
export const xOfIndex = (i: number): number =>
  i === 0
    ? 469
    : i === 1
      ? 634
      : i === 2
        ? 784
        : NOZZLE_X0 + (i - 3) * NOZZLE_PITCH;
export const yOfDiameter = (D: number): number =>
  Math.round(454 + ((0.08 - D) / 0.04) * 315);

const regionOf = (id: string): string =>
  id.startsWith("conv")
    ? "Convergent"
    : id === "throat"
      ? "Throat"
      : id.startsWith("div")
        ? "Divergent"
        : "Chamber";

/** Contour point i, with the exhaust plane as the final entry. */
export const contourAt = (i: number): { z: number; D: number } =>
  i < GAS_STATIONS.length ? GAS_STATIONS[i] : EXHAUST;
/** Length of the segment leaving station i. */
export const segLength = (i: number): number =>
  contourAt(i + 1).z - contourAt(i).z;
/** Tributary length of station i: half of each adjacent segment — the same
 *  partition buildRegenSystem uses for wetted area, reused for node volumes
 *  (thrusterCombustorTransient.ts) so the discretized free volume tiles the
 *  nozzle length exactly once, with no gaps or double-counting. */
export const tributaryLength = (i: number): number =>
  ((i > 0 ? segLength(i - 1) : 0) + segLength(i)) / 2;

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
export const JACKET_D = 0.015; // jacket pass hydraulic diameter [m]

/* ────────────────────────────────────────────────────────────────────────
 * Network assembly.
 * ──────────────────────────────────────────────────────────────────────── */
export function buildGasPath(): {
  gasNodes: NetworkConfig["nodes"];
  gasBranches: NetworkConfig["branches"];
} {
  const gasNodes: NetworkConfig["nodes"] = GAS_STATIONS.map((st, i) => ({
    id: st.id,
    type: "internal" as const,
    x: xOfIndex(i),
    y: yOfDiameter(st.D),
    position: metres(st.D / 2, 0, st.z),
    pressure: st.P,
    temperature: st.T,
    fluid: "gas",
    label:
      st.id === "chamber" ? "Chamber (reacting junction)" : regionOf(st.id),
  }));
  gasNodes.push({
    id: "exhaust",
    type: "boundary",
    x: xOfIndex(GAS_STATIONS.length),
    y: yOfDiameter(EXHAUST.D),
    position: metres(EXHAUST.D / 2, 0, EXHAUST.z),
    pressure: EXHAUST.P,
    temperature: EXHAUST.T,
    fluid: "gas",
    label: "Exhaust (matched expansion)",
  });

  const gasBranches: NetworkConfig["branches"] = GAS_STATIONS.map((st, i) => {
    const next = contourAt(i + 1);
    return {
      id: `seg${i + 1}`,
      from: st.id,
      to: i + 1 < GAS_STATIONS.length ? GAS_STATIONS[i + 1].id : "exhaust",
      initialMdot: MDOT_GAS,
      component: {
        type: "pipe" as const,
        length: segLength(i),
        diameter: st.D,
        roughness: 0,
        frictionFactor: FRICTION_F,
        ...(next.D !== st.D ? { diameterOut: next.D } : {}),
      },
      label: regionOf(st.id),
    };
  });

  return { gasNodes, gasBranches };
}

export function buildRegenSystem(): {
  coolantNodes: NetworkConfig["nodes"];
  jacketBranches: NetworkConfig["branches"];
  solidNodes: SolidNode[];
  conductors: Conductor[];
} {
  const coolantNodes: NetworkConfig["nodes"] = [];
  const jacketBranches: NetworkConfig["branches"] = [];
  const solidNodes: SolidNode[] = [];
  const conductors: Conductor[] = [];

  GAS_STATIONS.forEach((st, i) => {
    const D = st.D;
    const L = tributaryLength(i);
    const gx = xOfIndex(i);
    const gy = yOfDiameter(D);

    // This station's own RP-1 jacket node, placed at the channel top
    // (r = D/2 + liner + channel + shell) and directly above the gas node.
    const cool = {
      id: `${st.id}Coolant`,
      type: "internal" as const,
      x: gx,
      y: gy - 210,
      position: metres(D / 2 + LINER_T + CHANNEL_H + SHELL_T, 0, st.z),
      pressure: st.coolP,
      temperature: st.coolT,
      fluid: "rp1",
      label: `RP-1 jacket @ ${st.id}`,
    };
    coolantNodes.push(cool);

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
        T: st.wall[0],
        f: 0.3,
      },
      {
        key: "Fin",
        label: `Channel fins @ ${st.id}`,
        r: (D1 + CHANNEL_H) / 2,
        mass:
          CU_RHO * FIN_SOLIDITY * Math.PI * (D1 + CHANNEL_H) * L * CHANNEL_H,
        T: st.wall[1],
        f: 0.5,
      },
      {
        key: "Shell",
        label: `Outer shell @ ${st.id}`,
        r: (D2 + SHELL_T) / 2,
        mass: CU_RHO * Math.PI * (D2 + SHELL_T) * L * SHELL_T,
        T: st.wall[2],
        f: 0.7,
      },
    ];
    for (const layer of layers) {
      solidNodes.push({
        id: `${st.id}${layer.key}`,
        type: "solid",
        x: gx,
        y: Math.round(gy - layer.f * 210),
        position: metres(layer.r, 0, st.z),
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
        to: cool.id,
        type: { kind: "convection", h: H_COOLANT, area: areaBase },
        label: `Coolant film, channel base @ ${st.id}`,
      },
      {
        id: `${st.id}FinFilm`,
        from: `${st.id}Fin`,
        to: cool.id,
        type: { kind: "convection", h: H_COOLANT, area: areaFinSides },
        label: `Coolant film, fin sides @ ${st.id}`,
      },
      {
        id: `${st.id}ShellFilm`,
        from: `${st.id}Shell`,
        to: cool.id,
        type: { kind: "convection", h: H_COOLANT, area: areaTop },
        label: `Coolant film, channel top @ ${st.id}`,
      },
    );
  });

  // Counterflow jacket: tank -> nozzle-exit coolant node, then one pass per
  // station back toward the chamber (the fuelInjector branch carries
  // chamberCoolant -> chamber).
  const exit = coolantNodes[coolantNodes.length - 1];
  jacketBranches.push({
    id: "jacketIn",
    from: "fuelTank",
    to: exit.id,
    initialMdot: MDOT_FUEL,
    component: {
      type: "pipe",
      length: 0.05,
      diameter: JACKET_D,
      roughness: 0,
      frictionFactor: 0,
    },
    label: "Tank -> jacket inlet",
  });
  for (let i = coolantNodes.length - 1; i > 0; i--) {
    const from = coolantNodes[i];
    const to = coolantNodes[i - 1];
    // Pass length = distance along the wall between adjacent stations
    // (axial + radial contour change).
    const dz = (from.position!.z as number) - (to.position!.z as number);
    const dr = (from.position!.x as number) - (to.position!.x as number);
    jacketBranches.push({
      id: `jacket${coolantNodes.length - i}`,
      from: from.id,
      to: to.id,
      initialMdot: MDOT_FUEL,
      component: {
        type: "pipe",
        length: Math.max(Math.hypot(dz, dr), 1e-4),
        diameter: JACKET_D,
        roughness: 0,
        frictionFactor: 0,
      },
      label: `Jacket pass ${from.id.replace("Coolant", "")} -> ${to.id.replace("Coolant", "")}`,
    });
  }

  return { coolantNodes, jacketBranches, solidNodes, conductors };
}

const gasPath = buildGasPath();
const regen = buildRegenSystem();

export const feedNodes: NetworkConfig["nodes"] = [
  {
    id: "loxTank",
    type: "boundary",
    x: 77,
    y: 152,
    position: metres(0.2, 0.1, -0.1),
    pressure: 1300000,
    temperature: 90,
    fluid: "lox",
    label: "LOX source",
  },
  {
    id: "fuelTank",
    type: "boundary",
    x: xOfIndex(GAS_STATIONS.length) + 90,
    y: 332,
    position: metres(0.046, 0, 0.259282),
    pressure: 1300000,
    temperature: 300,
    fluid: "rp1",
    label: "RP-1 source",
  },
];

export const injectorBranches: NetworkConfig["branches"] = [
  {
    id: "loxInjector",
    from: "loxTank",
    to: "chamber",
    initialMdot: MDOT_OX,
    component: { type: "orifice", area: 0.0000321774, cd: 0.65 },
    label: "LOX injector orifice (junction inlet)",
  },
  {
    id: "fuelInjector",
    from: "chamberCoolant",
    to: "chamber",
    initialMdot: MDOT_FUEL,
    component: { type: "orifice", area: 0.0000146885, cd: 0.65 },
    label: "RP-1 injector orifice (junction inlet)",
  },
];

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
    // first property swap a large mid-solve perturbation that costs extra
    // outer iterations.
    gas: {
      model: "idealGas",
      params: { R: 363.633, gamma: 1.126691, mu: 0.00010611, cp: 3235.32 },
    },
    lox: {
      model: "incompressible",
      params: { rho: 1141, mu: 0.000195, cp: 1700 },
    },
    rp1: {
      model: "incompressible",
      params: { rho: 810, mu: 0.0017, cp: 2000 },
    },
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
  nodes: [...gasPath.gasNodes, ...feedNodes, ...regen.coolantNodes],
  solidNodes: regen.solidNodes,
  branches: [
    ...gasPath.gasBranches,
    ...injectorBranches,
    ...regen.jacketBranches,
  ],
  conductors: regen.conductors,
  notes: [
    {
      id: "noteOverview",
      text: "Combustion is simulated with a reacting junction: both injectors discharge straight into it, and the hot-gas state comes from a NASA CEA chemical-equilibrium lookup with a hard-coded enthalpy efficiency of 0.9409 (equivalent to 97% c* efficiency).",
      x: 255,
      y: 510,
      width: 430,
    },
    {
      id: "noteNozzle",
      text:
        `CHOKED CD NOZZLE: momentumFlux + kineticEnergy on, ${GAS_STATIONS.length} stations, initialMdot warm start on every duct branch.\n` +
        "The gas properties here are not fixed: gamma, R, mu, cp all update from the CEA lookup as O/F and Pc converge, so the choking condition itself moves during the solve.\n" +
        "The exhaust node carries the MATCHED-EXPANSION pressure, not an ambient pressure: a boundary node imposes a static pressure, and at a supersonic outlet any other value back-propagates into the last interior station.",
      x: 1095,
      y: 900,
      width: 430,
    },
    {
      id: "noteRegen",
      text:
        "REGEN COOLING — every gas station has its own wall section: gas film (Bartz-order h, scaled (Dt/D)^1.8) -> INNER LINER -> fin conduction -> FINS -> OUTER SHELL, with coolant films on the channel base, fin sides (fin efficiency 0.8), and channel top.  All three copper layers are separate solid nodes, so the liner-to-shell radial gradient is resolved at every station.\n" +
        "The full fuel flow runs nozzle-exit -> injector counterflow through ONE RP-1 NODE PER STATION, so the coolant temperature profile is resolved station by station too. Watch the liner and RP-1 temperatures after Run.",
      x: 1485,
      y: 75,
      width: 430,
    },
  ],
};
