/**
 * ============================================================================
 * ROCKET COMBUSTION CHAMBER — hot gas through a choked CD nozzle
 * ============================================================================
 *
 * A small rocket chamber expanding representative combustion products through
 * a conical converging–diverging nozzle.  The canvas is a meridional
 * half-section: injector on the left, exhaust on the right, radius up from
 * the axis.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────
 *
 * The companion to the regenerative-cooling example, which treats the hot
 * side as fixed T_aw reservoirs.  This model solves the CORE FLOW as
 * quasi-1-D compressible duct flow: `momentumFlux` + `kineticEnergy` on,
 * tapered `pipe`s carrying the area schedule through `diameterOut`.
 *
 * The nozzle is CHOKED and the bell is SUPERSONIC, which is what makes it a
 * rocket rather than a venturi: static pressure falls monotonically from the
 * chamber all the way to the exit plane, and the Mach number rises
 * monotonically through the sonic point to M_e ≈ 2.6 at an area ratio of 4.
 * Mass flow comes out within ~1 % of the analytic choked value
 *
 *     ṁ* = A* · P₀ · √(γ/(R·T₀)) · (2/(γ+1))^((γ+1)/(2(γ-1)))
 *
 * ── WHY IT IS BUILT THIS WAY ───────────────────────────────────────────────
 *
 * Two choices below are load-bearing; both were established by sweeping the
 * alternatives, and changing either one breaks the case.
 *
 *  1. `initialMdot` on every duct branch.  The transonic solution is a saddle:
 *     from the solver's default 0.1 kg/s guess a (mesh × relaxation) sweep
 *     converged to the right answer in only 5 of 30 combinations, and in 5
 *     more it reported converged = true on a physically absurd state
 *     (negative mass flow, non-monotone pressure).  With the mass-flow warm
 *     start seeded at ṁ*, all 30 of 30 converge.  This mirrors GFSSP, which
 *     requires the same warm start for near-choked ducts.
 *
 *  2. Throat-clustered stations.  The sonic point is crossed INSIDE one cell,
 *     so the cells adjacent to the throat must be small.  Uniform spacing
 *     smears the crossing over a coarse cell and costs accuracy.
 *
 * Both endpoints are pressure boundaries — the chamber at its stagnation
 * state, the exit at the perfectly-expanded supersonic pressure — so the
 * solver FINDS the choked mass flow rather than being told it.  (The earlier
 * subsonic build of this example prescribed ṁ with a `flowSource`; that is
 * unnecessary once the pressure ratio is large, because the zero-flow root is
 * no longer a neighbour of the physical one.)
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 *
 * The nozzle is PERFECTLY EXPANDED by construction: the exit boundary carries
 * the isentropic supersonic exit pressure for this area ratio.  The solver has
 * no shock capture, so raising the back pressure to push a normal shock into
 * the bell — over-expanded/separated operation — is NOT modeled and will not
 * produce a meaningful answer.  See user-manual section 1.7.
 *
 * ── GAS ────────────────────────────────────────────────────────────────────
 *
 * Representative LOX/RP-1 products as a constant-γ ideal gas.  CoolProp has
 * no 3200 K kerolox mixture, and the core-flow question here is the
 * area–Mach relation, not real-gas chemistry.
 *
 *   γ  = 1.20          frozen γ, fuel-rich booster
 *   MW = 23 g/mol      typical kerolox products
 *   T₀ = 3200 K        chamber stagnation temperature
 *   P₀ = 1.0 MPa       chamber stagnation pressure (10 bar)
 *
 * ── GEOMETRY ───────────────────────────────────────────────────────────────
 *
 * Cylindrical chamber, 30° conical convergent, 15° conical divergent,
 * expansion ratio 4 (exit diameter = chamber diameter) so the half-section
 * reads as a de Laval contour: wide, pinch, wide.
 */
import type { NetworkConfig } from "../core/schema";
import {
  CANVAS_GRID_SIZE,
  FLUID_BOUNDARY_SIZE,
  FLUID_INTERNAL_SIZE,
} from "./canvasGeometry";

const metres = (x: number, y = 0, z = 0) => ({ x, y, z });

/* ==========================================================================
 * 1.  GAS AND OPERATING POINT
 * ======================================================================== */

const GAMMA = 1.2;
const MOLAR_MASS = 0.023; // kg/mol
const R_UNIV = 8.314_462_618; // J/(mol·K)
const R_GAS = R_UNIV / MOLAR_MASS; // 361.498 J/(kg·K)
const CP = (GAMMA * R_GAS) / (GAMMA - 1);
/** Order-of-magnitude high-T viscosity; unused because f is imposed. */
const MU = 8.0e-5;

/** Chamber stagnation pressure [Pa]. */
const P_CHAMBER = 1.0e6;
/** Chamber stagnation temperature [K]. */
const T_CHAMBER = 3200;
/** Darcy friction factor imposed on every duct segment. */
const FRICTION_FACTOR = 0.02;

/* ==========================================================================
 * 2.  CONTOUR
 * ======================================================================== */

const D_CHAMBER = 0.08;
const D_THROAT = 0.04;
const D_EXIT = 0.08;
const L_BARREL = 0.1;
const CONVERGENT_HALF_ANGLE = (30 * Math.PI) / 180;
const DIVERGENT_HALF_ANGLE = (15 * Math.PI) / 180;

const Z_THROAT =
  L_BARREL + (D_CHAMBER - D_THROAT) / 2 / Math.tan(CONVERGENT_HALF_ANGLE);
const Z_END =
  Z_THROAT + (D_EXIT - D_THROAT) / 2 / Math.tan(DIVERGENT_HALF_ANGLE);

function contourDiameter(z: number): number {
  if (z <= L_BARREL) return D_CHAMBER;
  if (z <= Z_THROAT) {
    return D_CHAMBER - 2 * Math.tan(CONVERGENT_HALF_ANGLE) * (z - L_BARREL);
  }
  return D_THROAT + 2 * Math.tan(DIVERGENT_HALF_ANGLE) * (z - Z_THROAT);
}

function areaOf(d: number): number {
  return (Math.PI / 4) * d * d;
}

/** Sonic throat area — the nozzle is choked, so A* is the geometric throat. */
const A_STAR = areaOf(D_THROAT);

/* ==========================================================================
 * 3.  ISENTROPIC RELATIONS
 *
 * These relations set the BOUNDARY states (the injector and exit static
 * P/T), the analytic choked mass flow for the branch warm start, and the
 * per-station Mach numbers the tests compare against.
 *
 * The INTERNAL stations are deliberately NOT seeded with the isentropic
 * solution.  They start from a plain linear ramp — in STATION INDEX — between
 * the two boundary states, and with the mass-flow warm start the Newton lands
 * on the choked root from that ramp at every relaxation from 0.1 to 0.8.
 * The index part is load-bearing: because the mesh is throat-clustered, an
 * index-linear ramp concentrates the pressure drop through the transonic
 * cells, roughly where the physics puts it.  A ramp linear in physical z, a
 * flat guess, or a two-level chamber/exhaust guess all converge to spurious
 * roots with an expansion shock parked near the throat (mdot 1–20 % high,
 * non-monotone pressure) or fail outright.
 * ======================================================================== */

/** A/A* for a given Mach number (γ = GAMMA). */
function areaRatioFromMach(M: number): number {
  const t = 1 + ((GAMMA - 1) / 2) * M * M;
  const exp = (GAMMA + 1) / (2 * (GAMMA - 1));
  return (1 / M) * (t / ((GAMMA + 1) / 2)) ** exp;
}

/** Invert A/A* on the requested branch by bisection. */
function machFromAreaRatio(areaRatio: number, supersonic: boolean): number {
  if (areaRatio <= 1) return 1;
  let lo = supersonic ? 1 : 1e-6;
  let hi = supersonic ? 60 : 1;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    const f = areaRatioFromMach(mid);
    if (supersonic) {
      if (f > areaRatio) hi = mid;
      else lo = mid;
    } else {
      if (f > areaRatio) lo = mid;
      else hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

function isentropicPOverP0(M: number): number {
  return (1 + ((GAMMA - 1) / 2) * M * M) ** (-GAMMA / (GAMMA - 1));
}

function isentropicTOverT0(M: number): number {
  return 1 / (1 + ((GAMMA - 1) / 2) * M * M);
}

/** Isentropic Mach at an axial station, on the branch that station belongs to. */
function seedMachAt(z: number): number {
  return machFromAreaRatio(
    areaOf(contourDiameter(z)) / A_STAR,
    z > Z_THROAT + 1e-12,
  );
}

/** Analytic choked mass flow [kg/s]. */
const MDOT_CHOKED =
  A_STAR *
  P_CHAMBER *
  Math.sqrt(GAMMA / (R_GAS * T_CHAMBER)) *
  (2 / (GAMMA + 1)) ** ((GAMMA + 1) / (2 * (GAMMA - 1)));

/** Design exit Mach number for the shipped area ratio. */
const M_EXIT = machFromAreaRatio(areaOf(D_EXIT) / A_STAR, true);
/** Perfectly-expanded exit static pressure [Pa]. */
const P_EXIT = P_CHAMBER * isentropicPOverP0(M_EXIT);

/* ==========================================================================
 * 4.  MESH
 *
 * Stations are clustered toward the throat from both sides: the transonic
 * crossing happens inside the cell that straddles the sonic point, so those
 * cells have to be the small ones.  CLUSTER is the spacing exponent
 * (1 = uniform); 2 puts the nearest station ~1.5 mm from the throat.
 * ======================================================================== */

const N_BARREL = 2;
const N_CONV = 8;
const N_DIV = 12;
const CLUSTER = 2;

function makeStationZ(): number[] {
  const xs: number[] = [];
  for (let i = 0; i <= N_BARREL; i++) xs.push((L_BARREL * i) / N_BARREL);
  for (let i = 1; i <= N_CONV; i++) {
    const s = i / N_CONV;
    xs.push(L_BARREL + (Z_THROAT - L_BARREL) * (1 - (1 - s) ** CLUSTER));
  }
  for (let i = 1; i <= N_DIV; i++) {
    const s = i / N_DIV;
    xs.push(Z_THROAT + (Z_END - Z_THROAT) * s ** CLUSTER);
  }
  return xs;
}

const STATION_Z = makeStationZ();
const THROAT_INDEX = N_BARREL + N_CONV;

function stationId(i: number): string {
  if (i === 0) return "injector";
  if (i === STATION_Z.length - 1) return "exhaust";
  if (i === THROAT_INDEX) return "throat";
  if (i <= N_BARREL) return `barrel${i}`;
  if (i < THROAT_INDEX) return `conv${i - N_BARREL}`;
  return `div${i - THROAT_INDEX}`;
}

function stationLabel(id: string): string {
  if (id === "injector") return "Injector";
  if (id === "exhaust") return "Exhaust";
  if (id === "throat") return "Throat";
  if (id.startsWith("barrel")) return "Chamber";
  if (id.startsWith("conv")) return "Convergent";
  return "Divergent";
}

function branchId(i: number): string {
  return `seg${i + 1}`;
}

function branchLabel(toIndex: number): string {
  if (toIndex <= N_BARREL) return "Chamber";
  if (toIndex <= THROAT_INDEX) return "Convergent";
  return "Divergent";
}

/* ==========================================================================
 * 5.  CANVAS — meridional half-section
 * ======================================================================== */

const CANVAS_AXIAL_SCALE = 3200;
const CANVAS_RADIAL_EXAGGERATION = 5;
const CANVAS_RADIAL_SCALE = CANVAS_AXIAL_SCALE * CANVAS_RADIAL_EXAGGERATION;
const CANVAS_X_INJECTOR = 120;
const CANVAS_Y_AXIS = 720;
/** Minimum axial gap between station glyphs, in grid cells. */
const MIN_PITCH_CELLS = 3;

const snapToGrid = (v: number) =>
  Math.round(v / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;

/**
 * Canvas x centres for the stations, grid-snapped.
 *
 * Spacing follows physical z where there is room, but never closes below
 * MIN_PITCH_CELLS.  The throat-clustered stations sit ~0.5 mm apart, which at
 * a true axial scale would land several of them on the same pixel; the canvas
 * is schematic, and exact physical z is preserved in each node's `position`.
 */
function canvasXCentres(zs: number[]): number[] {
  const out: number[] = [];
  let prevCell = -Infinity;
  for (const z of zs) {
    const want =
      (CANVAS_X_INJECTOR + z * CANVAS_AXIAL_SCALE) / CANVAS_GRID_SIZE;
    const cell = Math.max(Math.round(want), prevCell + MIN_PITCH_CELLS);
    out.push(cell * CANVAS_GRID_SIZE);
    prevCell = cell;
  }
  return out;
}

/** Radius up from the axis; +y is down on the canvas. */
function canvasY(diameter: number): number {
  return snapToGrid(CANVAS_Y_AXIS - (diameter / 2) * CANVAS_RADIAL_SCALE);
}

/* ==========================================================================
 * 6.  BUILDER
 * ======================================================================== */

export interface ChamberStation {
  id: string;
  label: string;
  z: number;
  diameter: number;
  /** Isentropic Mach seed on this station's branch. */
  mach: number;
}

export interface RocketChamberOptions {
  chamberPressure?: number;
  chamberTemperature?: number;
  /** Override the perfectly-expanded exit pressure (shock-free cases only). */
  exitPressure?: number;
  frictionFactor?: number;
  relaxation?: number;
  jacobian?: "hybrid" | "fd";
}

export function buildRocketCombustionChamber(
  opts: RocketChamberOptions = {},
): NetworkConfig {
  const pChamber = opts.chamberPressure ?? P_CHAMBER;
  const tChamber = opts.chamberTemperature ?? T_CHAMBER;
  const pScale = pChamber / P_CHAMBER;
  const tScale = tChamber / T_CHAMBER;
  const pExit = opts.exitPressure ?? P_EXIT * pScale;
  const f = opts.frictionFactor ?? FRICTION_FACTOR;
  const mdotSeed = MDOT_CHOKED * pScale * Math.sqrt(1 / tScale);

  const stations: ChamberStation[] = STATION_Z.map((z, i) => ({
    id: stationId(i),
    label: stationLabel(stationId(i)),
    z,
    diameter: contourDiameter(z),
    mach: seedMachAt(z),
  }));

  // Boundary states: the isentropic STATIC state of the end stations.  The
  // injector face runs at M ~ 0.15 (so ~1.3 % below chamber stagnation), the
  // exit plane at the perfectly-expanded supersonic pressure.
  const pInjector = pChamber * isentropicPOverP0(stations[0].mach);
  const tInjector = tChamber * isentropicTOverT0(stations[0].mach);
  const tExhaust =
    tChamber * isentropicTOverT0(stations[stations.length - 1].mach);
  const iLast = stations.length - 1;

  const xCentres = canvasXCentres(stations.map((s) => s.z));
  const nodes: NetworkConfig["nodes"] = stations.map((s, i) => {
    const isEnd = i === 0 || i === stations.length - 1;
    const size = isEnd ? FLUID_BOUNDARY_SIZE : FLUID_INTERNAL_SIZE;
    const isExhaust = i === stations.length - 1;
    // Internal stations get a deliberately uninformed initial guess: a linear
    // ramp in station index between the boundary states.  Linear in INDEX,
    // not z — the throat-clustered mesh makes that ramp steep through the
    // transonic cells, which is what keeps the Newton off the spurious
    // expansion-shock roots (see the section-3 header).
    const frac = i / iLast;
    return {
      id: s.id,
      type: isEnd ? ("boundary" as const) : ("internal" as const),
      x: xCentres[i] - size / 2,
      y: canvasY(s.diameter) - size / 2,
      position: metres(s.diameter / 2, 0, s.z),
      pressure: isEnd
        ? isExhaust
          ? pExit
          : pInjector
        : pInjector + (pExit - pInjector) * frac,
      temperature: isEnd
        ? isExhaust
          ? tExhaust
          : tInjector
        : tInjector + (tExhaust - tInjector) * frac,
      label: s.label,
    };
  });

  const branches: NetworkConfig["branches"] = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const tapered = Math.abs(b.diameter - a.diameter) > 1e-12;
    branches.push({
      id: branchId(i),
      from: a.id,
      to: b.id,
      // Load-bearing: without this warm start the transonic saddle sends the
      // Newton to a wrong root (see the module header).
      initialMdot: mdotSeed,
      component: {
        type: "pipe",
        length: b.z - a.z,
        diameter: a.diameter,
        roughness: 0,
        frictionFactor: f,
        ...(tapered ? { diameterOut: b.diameter } : {}),
      },
      label: branchLabel(i + 1),
    });
  }

  const snap = snapToGrid;
  const injector = nodes[0];
  const throat = nodes[THROAT_INDEX];
  const exhaust = nodes[nodes.length - 1];

  const notes: NonNullable<NetworkConfig["notes"]> = [
    {
      id: "noteOverview",
      text: "A small rocket chamber: hot gas (LOX/RP-1 products as a γ = 1.20 ideal gas at 3200 K, 1 MPa) expanding through a choked converging-diverging nozzle.\nThe canvas is a half-section: left is the injector, right is the exhaust, up is radius. Press Run.",
      x: snap(injector.x - 30),
      y: snap(injector.y - 200),
      width: 420,
    },
    {
      id: "noteThroat",
      text: "settings.momentumFlux and kineticEnergy are on, so this is quasi-1-D compressible duct flow.\nThe throat is choked: the flow crosses M = 1 here and keeps accelerating. Mass flow settles within ~1% of the analytic choked value, and the solver finds it from the pressure ratio alone.",
      x: snap(throat.x - 80),
      y: snap(throat.y + 80),
      width: 400,
    },
    {
      id: "noteExhaust",
      text: "The bell is supersonic: static pressure falls all the way from 1 MPa to 43.5 kPa at the exit, and Mach climbs to ~2.6 at an area ratio of 4.\nThe nozzle is perfectly expanded — there is no shock capture, so raising the exit pressure to force a shock into the bell is out of scope. Color by pressure after Run.",
      x: snap(exhaust.x - 200),
      y: snap(exhaust.y - 220),
      width: 340,
    },
  ];

  return {
    meta: { name: "Rocket combustion chamber", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 500,
      relaxation: opts.relaxation ?? 0.6,
      momentumFlux: true,
      kineticEnergy: true,
      ...(opts.jacobian ? { jacobian: opts.jacobian } : {}),
    },
    fluid: {
      model: "idealGas",
      params: { R: R_GAS, gamma: GAMMA, mu: MU, cp: CP },
    },
    nodes,
    branches,
    notes,
  };
}

/** The shipped example. */
export const rocketCombustionChamber: NetworkConfig =
  buildRocketCombustionChamber();

/** Axial stations of the shipped example, injector to exhaust. */
export const CHAMBER_STATIONS: ChamberStation[] = STATION_Z.map((z, i) => ({
  id: stationId(i),
  label: stationLabel(stationId(i)),
  z,
  diameter: contourDiameter(z),
  mach: seedMachAt(z),
}));

export const CHAMBER_DESIGN = {
  gamma: GAMMA,
  molarMass: MOLAR_MASS,
  gasConstant: R_GAS,
  cp: CP,
  chamberPressure: P_CHAMBER,
  chamberTemperature: T_CHAMBER,
  exitPressure: P_EXIT,
  frictionFactor: FRICTION_FACTOR,
  chamberDiameter: D_CHAMBER,
  throatDiameter: D_THROAT,
  exitDiameter: D_EXIT,
  barrelLength: L_BARREL,
  zThroat: Z_THROAT,
  zEnd: Z_END,
  contractionRatio: (D_CHAMBER / D_THROAT) ** 2,
  expansionRatio: (D_EXIT / D_THROAT) ** 2,
  throatIndex: THROAT_INDEX,
  /** Analytic choked mass flow [kg/s]. */
  chokedMdot: MDOT_CHOKED,
  /** Design (perfectly-expanded) exit Mach number. */
  exitMach: M_EXIT,
};
