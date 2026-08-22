/**
 * ============================================================================
 * REGENERATIVE COOLING CHANNEL — LOX/RP-1 booster chamber
 * ============================================================================
 *
 * A steady conjugate heat-transfer model of one rectangular cooling channel
 * in the regeneratively-cooled thrust chamber of a kerosene booster: 1 023 kN vacuum
 * thrust, Isp_vac 305 s, LOX/RP-1, combustion tap-off cycle.  That cycle
 * point is an ASSUMED, SELF-CONSISTENT DESIGN POINT — not a specific engine.
 * docs/regen-cooling-example.md carries the derivation, the assumption
 * ledger, and the solved results.
 *
 * ── WHAT IS MODELLED ───────────────────────────────────────────────────────
 *
 * The chamber is regeneratively cooled by the full fuel flow in `nChannels`
 * identical rectangular axial channels in a GRCop-84 liner, closed out by a
 * structural jacket.  Channel width `b`, channel depth `h`, rib (land)
 * thickness `t_w`, and inner-wall thickness `S_w` between the hot gas and
 * the coolant.  GRCop-84 liners are typically printed; the rectangular
 * geometry does not depend on how the liner is made.
 *
 * Because every channel sees the same axial boundary condition, the network is
 * ONE REPRESENTATIVE CHANNEL carrying ṁ_fuel / nChannels, with every area,
 * volume and heat load divided by nChannels.  Multiply a per-channel result by
 * nChannels to recover the whole jacket.
 *
 * Flow is a single UP-PASS: RP-1 enters a manifold at the downstream end of
 * the cooled skirt (ε = 4) and runs toward the injector, counter to the gas.
 * The downstream boundary is the injector fuel manifold.
 *
 * Each of the 12 axial cells carries:
 *   - one coolant fluid node        (RP-1 bulk state)
 *   - one `aw` ambient node         (hot-gas reservoir at T_aw = 3400 K)
 *   - one `wg` solid node           (hot-gas-side liner surface)
 *   - one `wc` solid node           (coolant-side liner surface + rib roots)
 *   - conductance  aw → wg          Bartz-plus-soot h_eff(z)·A_gas
 *   - conduction   wg → wc          through S_w of GRCop-84
 *   - convection   wc → coolant     Dittus–Boelter on the channel Re, Pr
 *
 * So the two numbers a regen designer actually wants — T_wg (liner life) and
 * T_wc (RP-1 coking) — are solved unknowns, not post-processed estimates,
 * and the delivered flux q″ = h_eff·(T_aw − T_wg) responds to the solved
 * wall temperature rather than being frozen at a reference.
 *
 * The flat network view is laid out as a half-section of the chamber, so the
 * rows of nodes draw the contour they model rather than a straight ladder —
 * see section 8.
 *
 * ── THE HOT SIDE: ADIABATIC-WALL RESERVOIRS ────────────────────────────────
 *
 * Nozzle heat transfer is driven by the RECOVERY (adiabatic-wall)
 * temperature, which stays within a few percent of the stagnation
 * temperature along the whole contour — the jacket removes ~0.3 % of the
 * chamber's thermal power, so T_aw barely droops.  The core flow is
 * therefore not a solved continuum here (a network momentum equation cannot
 * represent a choked, supersonic nozzle, and a CoolProp state at 3400 K
 * does not exist): each cell sees a fixed-temperature AMBIENT reservoir at
 * T_aw = 3400 K behind the Bartz-plus-soot film:
 *
 *     h_g(z) = h_g,throat · (A_t / A(z))^0.9
 *     h_eff(z) = φ(z) / (1/h_g(z) + R_soot(z))
 *     q″(z) = h_eff(z) · (T_aw − T_wg(z))          [T_wg solved]
 *
 * with h_g,throat = 12 kW/m²K (Bartz at Pc = 10 MPa, D_t = 0.265 m) and φ(z)
 * the injector fuel-film-cooling relief that decays from 0.70 at the injector
 * face to 1.0 by z = 0.20 m.  The reservoir-to-wall link is a pure linear
 * conductance G = h_eff·A_gas.  Each gasFilm conductor stores that as a
 * `{ expr }` formula against the shared hot-side registers (hgThroat,
 * bartzExp, soot, film cooling) and the cell's own coolant-node position
 * (local diameter and station z), so the assumptions and the geometry are
 * visible in the property panel rather than baked into silent numbers.
 * Convection conductors require a fluid endpoint, and the hot gas is
 * deliberately not a fluid node.
 *
 * R_soot is the carbon deposit's thermal resistance, and at the throat it is
 * worth as much as the ENTIRE gas-side film — the reason kerosene engines
 * survive fluxes that would melt an equivalent clean wall.  It is scheduled
 * axially because the deposit is scoured thinnest where the gas shear is
 * highest: ~0.085 mm at the throat rising to ~0.17 mm in the barrel and skirt
 * (k_carbon = 1 W/mK).
 *
 * ── MOMENTUM FLUX ──────────────────────────────────────────────────────────
 *
 * The example ships with `settings.momentumFlux: true`: the coolant heats
 * and decompresses along the jacket, and the resulting acceleration term
 * (ṁ/A)²·(1/ρ_dn − 1/ρ_up) is carried in every channel branch instead of
 * being a quantified omission.  The area-taper share of the acceleration
 * (velocity-head change between segments of different flow area) remains
 * outside the per-branch single-area form — see the docs' omissions table.
 *
 * ── KNOWN OMISSIONS (all quantified in the docs) ───────────────────────────
 *
 *   - The AREA-TAPER share of the momentum flux: the solved acceleration
 *     term uses one flow area per branch, so the velocity-head change
 *     between segments of different area (26 → 69 m/s into the throat) is
 *     not carried — only the density-driven share within each branch is.
 *   - Hydrostatic head: the channel segments are `customResistance`
 *     components, which carry no elevation term.  Over 0.85 m of cooled
 *     length that is 6.1 kPa, 0.15 % of the channel ΔP.
 *   - Axial conduction along the liner: kA/L is k·(arc pitch) ≈ 1.0 W/K at
 *     the throat and 1.6 W/K in the barrel, mesh-independent because the
 *     conduction area grows with the cell.  Worst case is cell 1 at the
 *     injector face, where the film-cooling ramp leaves a 13 K step to its
 *     neighbour: 21 W against that cell's 1363 W, 1.6 %.  At the throat it is
 *     6 W against 1196 W, 0.5 %.  Deliberately not wired.
 *   - Heat into the structural close-out over the rib tips: folded into the
 *     adiabatic-tip fin efficiency.
 *   - Curvature enhancement of h through the throat and the wall-to-bulk
 *     property correction on Dittus–Boelter: both omitted, both conservative
 *     (each would raise h and lower T_wc).
 *
 * ── WHY `customResistance` AND NOT `pipe` ──────────────────────────────────
 *
 * The channels are rectangular.  A `pipe` derives its flow area from its
 * diameter as πD²/4, so no single diameter reproduces both the true flow area
 * (which sets the velocity) and the hydraulic diameter (which sets f and L/D)
 * — feeding it D_h overstates the velocity by ~50 % and the ΔP by ~2.3×.  Each
 * segment is therefore a `customResistance` carrying the TRUE rectangular flow
 * area and a K(Re) table built from this repo's own `darcyFrictionFactor` at
 * ε/D_h, so K(Re) = f(Re) · L_seg / D_h exactly.
 *
 * ── THE SOLVED DESIGN POINT ────────────────────────────────────────────────
 *
 *   260 channels pass 95.0 kg/s for 4.44 MPa of manifold-to-manifold ΔP
 *   (44 % of Pc, so the fuel pump must deliver 16.44 MPa), removing
 *   10.0 MW from the chamber.  Peak T_wc is at the skirt inlet — not the
 *   throat — because the channel is wide and slow there.  Coking is not
 *   set by the peak-flux station.
 */
import type { NetworkConfig } from "../core/schema";
import { darcyFrictionFactor } from "../core/components";
import { grcop84KFit } from "../core/solidProperties";
import {
  CANVAS_GRID_SIZE,
  FLUID_BOUNDARY_SIZE,
  FLUID_INTERNAL_SIZE,
  SOLID_NODE_SIZE,
} from "./canvasGeometry";

const metres = (x: number, y = 0, z = 0) => ({ x, y, z });

/* ==========================================================================
 * 1.  ENGINE CYCLE POINT
 * ======================================================================== */

/** Published: vacuum thrust [N]. */
const THRUST_VAC = 1_023_000;
/** Published: vacuum specific impulse [s]. */
const ISP_VAC = 305;
const G0 = 9.806_65;
/** ASSUMED: mixture ratio, typical LOX/RP-1 booster (fuel-rich of stoich). */
const MIXTURE_RATIO = 2.6;
/** ASSUMED: chamber pressure [Pa]. */
const CHAMBER_PRESSURE = 10.0e6;
/** ASSUMED: vacuum thrust coefficient at ε ≈ 25 with ~97 % nozzle efficiency. */
const CF_VAC = 1.85;

const MDOT_TOTAL = THRUST_VAC / (ISP_VAC * G0); // 342.0 kg/s
/** Full fuel flow goes through the jacket: a tap-off cycle bleeds chamber gas,
 *  not fuel, to drive the turbine. */
const MDOT_FUEL = MDOT_TOTAL / (1 + MIXTURE_RATIO); // 95.0 kg/s

/* ==========================================================================
 * 2.  CHAMBER CONTOUR
 * ======================================================================== */

const THROAT_AREA = THRUST_VAC / (CF_VAC * CHAMBER_PRESSURE);
const D_THROAT = Math.sqrt((4 * THROAT_AREA) / Math.PI); // 0.2653 m
/** ASSUMED: contraction ratio A_c/A_t. */
const CONTRACTION_RATIO = 2.5;
const D_CHAMBER = D_THROAT * Math.sqrt(CONTRACTION_RATIO); // 0.4195 m
/** ASSUMED: cylindrical barrel length [m] (gives L* ≈ 1.1 m). */
const L_BARREL = 0.35;
const CONVERGENT_HALF_ANGLE = (30 * Math.PI) / 180;
const DIVERGENT_HALF_ANGLE = (20 * Math.PI) / 180;
/**
 * Area ratio at the downstream end of the regeneratively-cooled skirt.  Past
 * ε = 4 the channels would have to be wider than they are deep; the real
 * engine's nozzle extension is cooled some other way (dump, film, or
 * radiation) and is outside this model.
 */
const EPS_REGEN_END = 4.0;

const Z_THROAT =
  L_BARREL + (D_CHAMBER - D_THROAT) / 2 / Math.tan(CONVERGENT_HALF_ANGLE);
const D_REGEN_END = D_THROAT * Math.sqrt(EPS_REGEN_END);
const Z_END =
  Z_THROAT + (D_REGEN_END - D_THROAT) / 2 / Math.tan(DIVERGENT_HALF_ANGLE);

/** Gas-side diameter at axial station z from the injector face [m].  Conical
 *  convergent and divergent sections: the real engine has a bell, but the
 *  jacket heat balance only sees local area ratio and wetted area. */
function contourDiameter(z: number): number {
  if (z <= L_BARREL) return D_CHAMBER;
  if (z <= Z_THROAT) {
    return D_CHAMBER - 2 * Math.tan(CONVERGENT_HALF_ANGLE) * (z - L_BARREL);
  }
  return D_THROAT + 2 * Math.tan(DIVERGENT_HALF_ANGLE) * (z - Z_THROAT);
}

/* ==========================================================================
 * 3.  HOT SIDE — ADIABATIC-WALL RESERVOIRS
 * ======================================================================== */

/**
 * ASSUMED: adiabatic-wall (recovery) temperature [K].  Kerolox at MR 2.6 and
 * Pc = 10 MPa burns near 3670 K; the recovery temperature at the wall is a
 * few percent lower and nearly constant along the contour, so one value
 * serves every cell.  Each cell's reservoir is an `ambient` node at T_AW.
 */
const T_AW = 3400;
/**
 * Seed-only gas-side wall temperature [K] used to guess initial wall and
 * coolant states and to quote the nominal heat load.  The solved T_wg is
 * free — the delivered flux is h_eff·(T_AW − T_wg,solved).
 */
const T_WG_REFERENCE = 550;
/** ASSUMED: Bartz gas-side coefficient at the throat [W/m²K]. */
const HG_THROAT = 12_000;
/** Bartz axial scaling exponent: h_g ∝ (A_t/A)^0.9. */
const BARTZ_AREA_EXPONENT = 0.9;
/** ASSUMED: carbon-deposit resistance at the throat [m²K/W] (0.085 mm at
 *  1 W/mK) — scoured thinnest by the peak gas shear. */
const R_SOOT_THROAT = 8.5e-5;
/** ASSUMED: carbon-deposit resistance away from the throat [m²K/W] (0.17 mm). */
const R_SOOT_BULK = 1.7e-4;
/** Area ratio at which the deposit reaches its full thickness. */
const R_SOOT_RAMP_AREA_RATIO = 3.0;
/** Injector film-cooling relief at the face, decaying to 1 by FILM_LENGTH. */
const FILM_FACTOR_AT_FACE = 0.7;
const FILM_LENGTH = 0.2;

function filmFactor(z: number): number {
  return Math.min(
    1,
    FILM_FACTOR_AT_FACE + (1 - FILM_FACTOR_AT_FACE) * (z / FILM_LENGTH),
  );
}

function sootResistance(areaRatio: number): number {
  const ramp = Math.min(1, (areaRatio - 1) / (R_SOOT_RAMP_AREA_RATIO - 1));
  return R_SOOT_THROAT + (R_SOOT_BULK - R_SOOT_THROAT) * ramp;
}

/** Effective gas-side film coefficient at station z, including soot [W/m²K]. */
function gasFilmH(z: number, diameter: number): number {
  const areaRatio = (diameter / D_THROAT) ** 2;
  const hg = HG_THROAT * areaRatio ** -BARTZ_AREA_EXPONENT;
  return filmFactor(z) / (1 / hg + sootResistance(areaRatio));
}

/**
 * Shared hot-side assumptions.  Each gas-film conductor's k is a formula
 * against these registers, and each `aw` node temperature is `reg('tAw')`,
 * so changing a register (Settings → registers, or the model text) updates
 * every station.
 */
const HOT_SIDE_REGISTERS = {
  tAw: T_AW,
  hgThroat: HG_THROAT,
  bartzExp: BARTZ_AREA_EXPONENT,
  rSootThroat: R_SOOT_THROAT,
  rSootBulk: R_SOOT_BULK,
  rSootRampEps: R_SOOT_RAMP_AREA_RATIO,
  filmFace: FILM_FACTOR_AT_FACE,
  filmLength: FILM_LENGTH,
};

const expr = (source: string) => ({ expr: source });
/** `{ expr }` on a field whose TypeScript type is still `number`. Decode and
 *  paramBindings already accept the formula; the solver sees the resolved
 *  literal. */
const numExpr = (source: string) => expr(source) as unknown as number;

/**
 * Per-cell geometry as formula fragments.  Diameter and axial station come
 * from the coolant node's physical position (radius, elevation from the
 * skirt datum); wall length is register `L{i}`.  Channel width, D_h, areas
 * and masses are written from those plus the shared jacket registers.
 */
function cellExprs(index: number, depth: string) {
  const d = `2 * node('f${index}').position.x`;
  const z = `(reg('zEnd') - node('f${index}').position.z)`;
  const L = `reg('L${index}')`;
  const n = `reg('nChannels')`;
  const Sw = `reg('Sw')`;
  const tw = `reg('tw')`;
  const b = `(pi * (${d} + 2 * ${Sw}) / ${n} - ${tw})`;
  const mFin = `sqrt(2 * reg('hFin') / (reg('kLiner') * ${tw}))`;
  const eta = `tanh(${mFin} * ${depth}) / (${mFin} * ${depth})`;
  const flowArea = `(${b}) * ${depth}`;
  return {
    d,
    z,
    L,
    b,
    flowArea,
    hydraulicDiameter: `2 * (${b}) * ${depth} / ((${b}) + ${depth})`,
    convectionArea: `((${b}) + 2 * (${eta}) * ${depth}) * ${L}`,
    conductionArea: `pi * (${d} + ${Sw}) / ${n} * ${L}`,
    gasArea: `pi * ${d} * ${L} / ${n}`,
    volume: `${flowArea} * ${L}`,
    wgMass: `reg('rhoLiner') * pi * (${d} + ${Sw}) / ${n} * ${Sw} * ${L} / 2`,
    wcMass: `reg('rhoLiner') * (pi * (${d} + ${Sw}) / ${n} * ${Sw} / 2 + ${tw} * ${depth}) * ${L}`,
    eps: `(${d} / reg('dThroat')) ^ 2`,
  };
}

/**
 * Bartz-plus-soot film written as a static k formula (L = 1 m, so k is
 * h_eff in W/m²K).  Local area ratio and station z are the coolant node's
 * physical position; the assumed coefficients live in HOT_SIDE_REGISTERS.
 *
 *   h_g = hgThroat / ε^bartzExp
 *   R_soot ramps from rSootThroat at ε=1 to rSootBulk by rSootRampEps
 *   φ ramps from filmFace at z=0 to 1 by filmLength
 *   h_eff = φ / (1/h_g + R_soot)
 */
function gasFilmKExpr(index: number): string {
  const g = cellExprs(index, "reg('h')");
  const phi = `min(1, reg('filmFace') + (1 - reg('filmFace')) * ${g.z} / reg('filmLength'))`;
  const hg = `reg('hgThroat') / ((${g.eps}) ^ reg('bartzExp'))`;
  const soot = `reg('rSootThroat') + (reg('rSootBulk') - reg('rSootThroat')) * min(1, ((${g.eps}) - 1) / (reg('rSootRampEps') - 1))`;
  return `${phi} / (1 / (${hg}) + (${soot}))`;
}

/* ==========================================================================
 * 4.  LINER MATERIAL AND FIXED CHANNEL GEOMETRY
 * ======================================================================== */

/** Assumed copper channel roughness [m]. */
const CHANNEL_ROUGHNESS = 5e-6;
/**
 * GRCop-84 (NASA Cu-8 at.% Cr-4 at.% Nb) — not C18150 CuCrZr and not OFHC.
 * Wall cp and liner conduction k are the named preset `{ material: 'grcop-84' }`
 * (Ellis NASA/CR-2000-210055).  `kLiner` is a frozen scalar used only for the
 * one-shot rib fin efficiency, evaluated at the seed wall temperature.
 */
const LINER_MATERIAL = { material: "grcop-84" } as const;
const K_LINER = grcop84KFit(T_WG_REFERENCE);
/** Handbook room-temperature density, 8.62 g/cm³
 *  (Aerospace Structural Materials Handbook Supplement GRCop-84, NTRS 20020070630).
 *  Mass is inert in a steady solve. */
const RHO_LINER = 8620;

/**
 * Nominal coolant-side h used ONCE, to evaluate the rib fin efficiency
 * [W/m²K].  The fin area factor is a fixed geometric input; it is not
 * re-evaluated from the solved h.  Straight fin, adiabatic tip (the structural
 * close-out over the rib tips is treated as taking no heat).
 */
const H_FIN_NOMINAL = 30_000;

/* ==========================================================================
 * 5.  COOLANT
 * ======================================================================== */

/**
 * RP-1 is not in the CoolProp catalogue.  n-Dodecane (C12H26) is the standard
 * single-component surrogate: RP-1's mean formula is close to C12H23, and at
 * 300 K / 15 MPa the surrogate gives ρ = 755 kg/m³ (RP-1 ≈ 805) and
 * μ = 1.57 mPa·s (RP-1 ≈ 1.7).  The HEOS equation of state is valid
 * 263.6–700 K with T_crit = 658 K, covering the whole jacket.  Read the
 * absolute temperature rise as indicative and the trends as sound.
 */
const COOLANT = "n-Dodecane";
/**
 * Injector fuel-manifold pressure [Pa] = chamber pressure + injector ΔP.
 * This is the jacket's fixed downstream boundary.
 */
const P_INJECTOR_MANIFOLD = 12.0e6;

/** ASSUMED: manifold → channel entrance loss coefficient. */
const K_ENTRANCE = 0.5;
/** ASSUMED: channel → injector-manifold exit loss coefficient. */
const K_EXIT = 1.0;

/* ==========================================================================
 * 6.  AXIAL DISCRETISATION
 * ======================================================================== */

/**
 * Twelve cells span the 0.85 m cooled length: four in the barrel, two in
 * the convergent, one straddling the throat, five down the skirt (last
 * cell short so the cold-slow inlet is its own station).  Enough that the
 * contour and the throat/skirt contrast stay readable, and that the
 * skirt-inlet hot spot is not averaged away.
 */
const THROAT_CELL_HALF_LENGTH = 0.02;
const BARREL_CELLS = 4;
const CONVERGENT_CELLS = 2;
/** Relative widths of the divergent cells.  They grow as the flux falls;
 *  the last cell is short so the skirt inlet is not averaged into the
 *  faster channel upstream. */
const DIVERGENT_CELL_WEIGHTS = [1, 1, 2, 2, 1];
/** Sub-intervals per cell for the surface-area / heat-load quadrature. */
const QUADRATURE_STEPS = 32;

/** Cell edges, injector face (z = 0) to the end of the cooled skirt. */
function cellEdges(): number[] {
  const edges = [0];
  for (let i = 1; i <= BARREL_CELLS; i++) {
    edges.push((L_BARREL * i) / BARREL_CELLS);
  }
  const convergentEnd = Z_THROAT - THROAT_CELL_HALF_LENGTH;
  for (let i = 1; i <= CONVERGENT_CELLS; i++) {
    edges.push(L_BARREL + ((convergentEnd - L_BARREL) * i) / CONVERGENT_CELLS);
  }
  edges.push(Z_THROAT + THROAT_CELL_HALF_LENGTH);
  const divergentStart = Z_THROAT + THROAT_CELL_HALF_LENGTH;
  const weightSum = DIVERGENT_CELL_WEIGHTS.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const w of DIVERGENT_CELL_WEIGHTS) {
    acc += w;
    edges.push(divergentStart + ((Z_END - divergentStart) * acc) / weightSum);
  }
  return edges;
}

/* ==========================================================================
 * 7.  DEFAULT DESIGN POINT
 * ======================================================================== */

/**
 * ASSUMED: number of parallel rectangular channels — the knee of the central regen
 * trade.  Compared fairly, i.e. at the SAME 95 kg/s fuel flow with the inlet
 * pressure retuned each time, wall temperature is simply bought with pump head:
 *
 *     N     jacket ΔP    peak T_wc
 *    200      2.83 MPa      594 K
 *    260      4.44 MPa      552 K     shipped
 *    320      7.50 MPa      518 K
 *
 * More channels run the wall cooler and cost pump head for it — and at 200
 * the coolant-side wall is within a few kelvin of the 600 K coking limit.
 */
const DEFAULT_N_CHANNELS = 260;
/** `t_w` — rib (land) thickness, constant [m]. */
const DEFAULT_RIB_THICKNESS = 1.5e-3;
/** `S_w` — inner-wall thickness between hot gas and coolant [m]. */
const DEFAULT_LINER_THICKNESS = 0.8e-3;
/** Jacket inlet temperature [K] — tank RP-1 plus a little pump work. */
const DEFAULT_COOLANT_INLET_T = 300;

/**
 * `h` — channel depth schedule, as (area ratio, depth [m]) knots.
 *
 * The shipped design point is a CONSTANT 4.0 mm depth, which is both the
 * simplest schedule and — less obviously — very close to the best.  Width
 * `b` is not a free variable: it is the arc pitch minus the
 * rib, so it grows with the local contour diameter, and at constant depth the
 * channel flow area grows with it.  The coolant mass flux G = ṁ_ch/A therefore
 * falls as the chamber widens, which is exactly where the delivered flux falls
 * too (both because Bartz h_g ∝ (A_t/A)^0.9 and because the carbon deposit
 * thickens away from the throat).  A constant depth already puts the highest
 * mass flux where the heat is.
 *
 * The trade study in the docs sweeps tapered schedules — shallow at the throat,
 * pinched again over the skirt — and none of them beat this: they each cost
 * 1 MPa or more of extra pump head for the same peak wall temperature.  The
 * schedule stays a lookup table so that sweep is still expressible.
 */
const DEFAULT_DEPTH_SCHEDULE: Array<[number, number]> = [
  [1.0, 4.0e-3],
  [3.6, 4.0e-3],
];

/**
 * Nozzle-end inlet-manifold pressure [Pa].  Chosen so the jacket passes the
 * design fuel flow — i.e. this IS the required fuel-pump discharge pressure,
 * and the value is an output of the sizing loop, not an independent input.
 */
const DEFAULT_JACKET_INLET_PRESSURE = 16.44e6;

/* ==========================================================================
 * 8.  CANVAS LAYOUT
 * ======================================================================== */

/**
 * The flat network view is drawn as a MERIDIONAL HALF-SECTION of the chamber
 * rather than as a straight ladder of cells: canvas x is the axial station
 * and canvas y is the local radius, so the rows of nodes trace the real
 * contour — flat barrel, 30° convergent, throat pinch, 20° skirt flare — with
 * the injector face at the left, the cooled skirt exit at the right, and the
 * engine axis below.  Cell width is honoured too, so the columns crowd where
 * the cells are short, through the throat, and spread out down the skirt.
 * Reading the canvas left to right walks the chamber; the coolant runs the
 * other way, right to left, which is the counter-flow the jacket really is.
 *
 * Radius is exaggerated `CANVAS_RADIAL_EXAGGERATION`× against the axial
 * scale.  A true-scale section of this chamber is 3:1 long and thin, and the
 * throat pinch that the whole example turns on barely shows; stretching the
 * radius makes the contour read at a glance and costs nothing, since no
 * physics is ever taken from canvas coordinates.
 *
 * The four rows are a second, unavoidable distortion: liner and channel
 * occupy millimetres of a 133 mm throat radius, so at any true radial
 * scale they would collapse onto the contour line.  They are stacked at a
 * fixed `CANVAS_LAYER_GAP` instead, ordered outward from the axis exactly
 * as the hardware is — the hot-gas T_aw reservoir inside the contour, then
 * the gas-side wall, the coolant-side wall, then the coolant.
 *
 * Both scales are pinned as tight as the labels allow: a glyph plus the name
 * hung under it needs ~86 px, so `CANVAS_LAYER_GAP` and the narrowest station
 * pitch (the throat, whose cells are the shortest) both sit just above that.
 * Any looser and the whole half-section no longer fits a screen at a zoom
 * where the glyphs are still legible.
 */
const CANVAS_AXIAL_SCALE = 2400;
const CANVAS_RADIAL_EXAGGERATION = 2.5;
const CANVAS_RADIAL_SCALE = CANVAS_AXIAL_SCALE * CANVAS_RADIAL_EXAGGERATION;
/** Canvas x of the injector face [px]. */
const CANVAS_X_INJECTOR = 180;
/** Canvas y of the engine axis [px]; radius is measured up from it. */
const CANVAS_Y_AXIS = 1995;
/** Radial spacing of the T_aw / gas-wall / coolant-wall / coolant rows [px]. */
const CANVAS_LAYER_GAP = 105;
const CANVAS_ROW_AW = 0;
const CANVAS_ROW_WG = 1;
const CANVAS_ROW_WC = 2;
const CANVAS_ROW_COOLANT = 3;
/** Axial standoff of a manifold boundary node from its end cell [px]. */
const CANVAS_MANIFOLD_OFFSET = 90;

/**
 * Top-left origin of a glyph of `size` centred at (cx, cy), with the centre
 * snapped to the canvas grid — the same placement `normalizeCanvasLayout`
 * applies on load, done here so the shipped coordinates are the rendered
 * ones and the contour cannot shift when the example is opened.
 */
function glyphOrigin(cx: number, cy: number, size: number) {
  const snap = (v: number) =>
    Math.round(v / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
  return { x: snap(cx) - size / 2, y: snap(cy) - size / 2 };
}

/* ==========================================================================
 * 9.  BUILDER
 * ======================================================================== */

export interface RegenChannelOptions {
  /** Number of parallel rectangular channels. */
  nChannels?: number;
  /** `t_w` — rib (land) thickness [m]. */
  ribThickness?: number;
  /** `S_w` — inner-wall thickness [m]. */
  linerThickness?: number;
  /** `h` — (area ratio, depth [m]) knots, piecewise-linear and end-clamped. */
  depthSchedule?: Array<[number, number]>;
  /** Nozzle-end inlet-manifold pressure [Pa]. */
  jacketInletPressure?: number;
  /** Jacket inlet coolant temperature [K]. */
  coolantInletTemperature?: number;
}

export interface JacketCell {
  /** 1 at the injector face, increasing toward the nozzle. */
  index: number;
  /** Cell edges, axial distance from the injector face [m]. */
  zStart: number;
  zEnd: number;
  /** Contour length of the cell along the wall [m]. */
  wallLength: number;
  /** Gas-side wetted area of the whole cell, all channels [m²]. */
  gasArea: number;
  /** Area-mean gas-side diameter [m]. */
  meanDiameter: number;
  /** Local area ratio A/A_t at the area-mean diameter. */
  areaRatio: number;
  /** Area-mean Bartz-plus-soot film coefficient [W/m²K]. */
  gasFilmH: number;
  /** Nominal heat flux at T_wg = T_WG_REFERENCE [W/m²] (IC seed only). */
  heatFlux: number;
  /** Nominal heat into the whole cell at that flux [W] (IC seed only). */
  cellHeat: number;
  /** Gas-side convection area of ONE channel over this cell [m²]. */
  gasConvectionArea: number;
  /** `b` — channel width [m]. */
  width: number;
  /** `h` — channel depth [m]. */
  depth: number;
  /** Channel flow area [m²]. */
  flowArea: number;
  /** Channel hydraulic diameter 2bh/(b+h) [m]. */
  hydraulicDiameter: number;
  /** Rib fin efficiency at H_FIN_NOMINAL. */
  finEfficiency: number;
  /** Coolant-wetted area of ONE channel over this cell, fin-derated [m²]. */
  convectionArea: number;
  /** Through-liner conduction area of ONE channel over this cell [m²]. */
  conductionArea: number;
  /** Heat into ONE channel's cell [W]. */
  channelHeat: number;
  /** Coolant volume of ONE channel over this cell [m³]. */
  channelVolume: number;
  /** Liner mass carried by ONE channel over this cell [kg]. */
  linerMass: number;
  /** Rib mass carried by ONE channel over this cell [kg]. */
  ribMass: number;
}

export interface RegenChannelModel {
  config: NetworkConfig;
  /** Per-cell design table, cell 1 at the injector face. */
  cells: JacketCell[];
  design: {
    thrustVac: number;
    ispVac: number;
    mixtureRatio: number;
    chamberPressure: number;
    mdotTotal: number;
    mdotFuel: number;
    throatDiameter: number;
    chamberDiameter: number;
    regenEndDiameter: number;
    zThroat: number;
    zEnd: number;
    nChannels: number;
    ribThickness: number;
    linerThickness: number;
    mdotChannel: number;
    coolant: string;
    /** T_aw — the fixed hot-gas reservoir temperature [K]. */
    adiabaticWallTemperature: number;
    coolantInletTemperature: number;
    jacketInletPressure: number;
    injectorManifoldPressure: number;
    /** Nominal jacket heat at T_wg = T_WG_REFERENCE [W]. */
    totalHeat: number;
    /** Total gas-side wetted area of the cooled jacket [m²]. */
    totalGasArea: number;
    /** Peak nominal cell-average flux [W/m²] (the throat cell). */
    peakHeatFlux: number;
  };
}

/** Piecewise-linear schedule lookup, clamped at both ends. */
function interpolate(knots: Array<[number, number]>, x: number): number {
  if (x <= knots[0][0]) return knots[0][1];
  const last = knots[knots.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < knots.length - 1; i++) {
    const [x0, y0] = knots[i];
    const [x1, y1] = knots[i + 1];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

/** Log-spaced Reynolds knots spanning laminar through fully-rough turbulent. */
const RE_KNOTS = [
  1e3, 2.3e3, 4e3, 1e4, 3e4, 6e4, 1e5, 2e5, 4e5, 7e5, 1.5e6, 5e6,
];

/**
 * K(Re) for a straight rectangular channel run: K = f(Re) · L / D_h, with f
 * from this repo's own `darcyFrictionFactor` (Swamee–Jain plus the laminar
 * branch and transition blend) at ε/D_h.  Paired with the TRUE rectangular
 * flow area in `customResistance`, this reproduces the Darcy–Weisbach drop of
 * the real duct exactly, which no round-`pipe` diameter can.
 */
function frictionKTable(
  length: number,
  hydraulicDiameter: number,
): Array<[number, number]> {
  const epsOverD = CHANNEL_ROUGHNESS / hydraulicDiameter;
  const lengthOverD = length / hydraulicDiameter;
  return RE_KNOTS.map((Re) => [
    Re,
    darcyFrictionFactor(Re, epsOverD) * lengthOverD,
  ]);
}

export function buildRegenCoolingChannel(
  options: RegenChannelOptions = {},
): RegenChannelModel {
  const nChannels = options.nChannels ?? DEFAULT_N_CHANNELS;
  const ribThickness = options.ribThickness ?? DEFAULT_RIB_THICKNESS;
  const linerThickness = options.linerThickness ?? DEFAULT_LINER_THICKNESS;
  const depthSchedule = options.depthSchedule ?? DEFAULT_DEPTH_SCHEDULE;
  const jacketInletPressure =
    options.jacketInletPressure ?? DEFAULT_JACKET_INLET_PRESSURE;
  const coolantInletT =
    options.coolantInletTemperature ?? DEFAULT_COOLANT_INLET_T;
  const mdotChannel = MDOT_FUEL / nChannels;

  const finM = Math.sqrt((2 * H_FIN_NOMINAL) / (K_LINER * ribThickness));
  const finEfficiency = (depth: number): number =>
    Math.tanh(finM * depth) / (finM * depth);

  /* ---- per-cell geometry, areas and heat loads ---- */
  const edges = cellEdges();
  const cells: JacketCell[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const zStart = edges[i];
    const zEnd = edges[i + 1];
    const dz = (zEnd - zStart) / QUADRATURE_STEPS;

    let wallLength = 0;
    let gasArea = 0;
    for (let s = 0; s < QUADRATURE_STEPS; s++) {
      const z0 = zStart + s * dz;
      const z1 = z0 + dz;
      const d0 = contourDiameter(z0);
      const d1 = contourDiameter(z1);
      const ds = Math.hypot(dz, (d1 - d0) / 2);
      const dMid = (d0 + d1) / 2;
      const dA = Math.PI * dMid * ds;
      wallLength += ds;
      gasArea += dA;
    }

    const meanDiameter = gasArea / (Math.PI * wallLength);
    const areaRatio = (meanDiameter / D_THROAT) ** 2;
    const zMid = (zStart + zEnd) / 2;
    const depth = interpolate(depthSchedule, areaRatio);
    // Arc pitch per channel at the channel floor (D + 2·S_w) and at the liner
    // mid-thickness (D + S_w).
    const rootPitch =
      (Math.PI * (meanDiameter + 2 * linerThickness)) / nChannels;
    const midPitch = (Math.PI * (meanDiameter + linerThickness)) / nChannels;
    const width = rootPitch - ribThickness;
    const eta = finEfficiency(depth);
    // Same closed form the conductor k formula evaluates (cell-mean station).
    const meanH = gasFilmH(zMid, meanDiameter);
    const cellHeat = meanH * (T_AW - T_WG_REFERENCE) * gasArea;

    cells.push({
      index: i + 1,
      zStart,
      zEnd,
      wallLength,
      gasArea,
      meanDiameter,
      areaRatio,
      gasFilmH: meanH,
      heatFlux: cellHeat / gasArea,
      cellHeat,
      gasConvectionArea: gasArea / nChannels,
      width,
      depth,
      flowArea: width * depth,
      hydraulicDiameter: (2 * width * depth) / (width + depth),
      finEfficiency: eta,
      // Channel floor plus one flank of each bounding rib (every rib is shared
      // with a neighbour, so one flank apiece), fin-derated.
      convectionArea: (width + 2 * eta * depth) * wallLength,
      conductionArea: midPitch * wallLength,
      channelHeat: cellHeat / nChannels,
      channelVolume: width * depth * wallLength,
      linerMass: RHO_LINER * midPitch * linerThickness * wallLength,
      ribMass: RHO_LINER * ribThickness * depth * wallLength,
    });
  }

  /* ---- network, in flow order: nozzle end → injector face ---- */
  const flowOrder = [...cells].reverse();
  const nodes: NetworkConfig["nodes"] = [];
  const solidNodes: NonNullable<NetworkConfig["solidNodes"]> = [];
  const conductors: NonNullable<NetworkConfig["conductors"]> = [];
  const branches: NetworkConfig["branches"] = [];

  // Physical coordinates: engine axis vertical and firing downward, so
  // elevation runs opposite to the axial station — the skirt exit is the datum
  // and the injector face is Z_END above it.  Coolant therefore enters at the
  // bottom and rises, which is also the true orientation on the pad.  x is the
  // local channel radius, which draws the contour in the 3D view.
  const position = (z: number, diameter: number) =>
    metres(diameter / 2, 0, Z_END - z);

  // Canvas coordinates: the half-section described in section 8.  `row` counts
  // outward from the axis — 0 hot-gas T_aw reservoir, 1 gas-side wall,
  // 2 coolant-side wall, 3 coolant.
  const canvasX = (z: number) => CANVAS_X_INJECTOR + CANVAS_AXIAL_SCALE * z;
  const canvasY = (diameter: number, row: number) =>
    CANVAS_Y_AXIS -
    (CANVAS_RADIAL_SCALE * diameter) / 2 -
    CANVAS_LAYER_GAP * row;

  // Marched enthalpy rise, used only to seed the initial guesses.
  const CP_SEED = 2350; // RP-1 surrogate cp near 350 K [J/kgK]
  let heatUpstream = 0;

  nodes.push({
    id: "manifoldIn",
    type: "boundary",
    ...glyphOrigin(
      canvasX(Z_END) + CANVAS_MANIFOLD_OFFSET,
      canvasY(D_REGEN_END, CANVAS_ROW_COOLANT),
      FLUID_BOUNDARY_SIZE,
    ),
    position: position(Z_END, D_REGEN_END),
    pressure: numExpr("reg('pJacketIn')"),
    temperature: numExpr("reg('tInlet')"),
    label: "Nozzle-end fuel manifold",
  });

  const uniformDepth = cells.every((c) => c.depth === cells[0]!.depth);
  const depthExpr = (cell: JacketCell) =>
    uniformDepth ? "reg('h')" : `reg('h${cell.index}')`;

  flowOrder.forEach((cell, flowPosition) => {
    const zMid = (cell.zStart + cell.zEnd) / 2;
    const g = cellExprs(cell.index, depthExpr(cell));
    // Node state is the cell average, so half of this cell's heat is upstream.
    const tSeed =
      coolantInletT +
      (heatUpstream + cell.channelHeat / 2) / (mdotChannel * CP_SEED);
    heatUpstream += cell.channelHeat;
    const pSeed =
      jacketInletPressure -
      ((jacketInletPressure - P_INJECTOR_MANIFOLD) * (flowPosition + 0.5)) /
        flowOrder.length;
    // Wall seeds from the 1-D series resistance at H_FIN_NOMINAL.
    const wcSeed =
      tSeed + cell.channelHeat / (H_FIN_NOMINAL * cell.convectionArea);
    const wgSeed =
      wcSeed +
      (cell.channelHeat * linerThickness) / (K_LINER * cell.conductionArea);

    nodes.push({
      id: `f${cell.index}`,
      type: "internal",
      ...glyphOrigin(
        canvasX(zMid),
        canvasY(cell.meanDiameter, CANVAS_ROW_COOLANT),
        FLUID_INTERNAL_SIZE,
      ),
      position: position(zMid, cell.meanDiameter),
      pressure: pSeed,
      temperature: tSeed,
      volume: expr(g.volume),
      label: `RP-1 ${cell.index}`,
    });

    solidNodes.push({
      id: `wc${cell.index}`,
      type: "solid",
      ...glyphOrigin(
        canvasX(zMid),
        canvasY(cell.meanDiameter, CANVAS_ROW_WC),
        SOLID_NODE_SIZE,
      ),
      position: position(zMid, cell.meanDiameter + 2 * linerThickness),
      temperature: wcSeed,
      mass: numExpr(g.wcMass),
      cp: LINER_MATERIAL,
      label: `Coolant-side wall ${cell.index}`,
    });

    solidNodes.push({
      id: `wg${cell.index}`,
      type: "solid",
      ...glyphOrigin(
        canvasX(zMid),
        canvasY(cell.meanDiameter, CANVAS_ROW_WG),
        SOLID_NODE_SIZE,
      ),
      position: position(zMid, cell.meanDiameter),
      temperature: wgSeed,
      mass: numExpr(g.wgMass),
      cp: LINER_MATERIAL,
      label: `Gas-side wall ${cell.index}`,
    });

    conductors.push({
      id: `liner${cell.index}`,
      from: `wg${cell.index}`,
      to: `wc${cell.index}`,
      type: {
        kind: "conduction",
        k: LINER_MATERIAL,
        area: expr(g.conductionArea),
        length: expr("reg('Sw')"),
      },
      label: `Liner ${cell.index} (S_w)`,
    });

    conductors.push({
      id: `film${cell.index}`,
      from: `wc${cell.index}`,
      to: `f${cell.index}`,
      type: {
        kind: "convection",
        area: expr(g.convectionArea),
        correlation: {
          model: "dittusBoelter",
          diameter: expr(g.hydraulicDiameter),
          flowArea: expr(g.flowArea),
        },
      },
      label: `Coolant film ${cell.index}`,
    });

    // Hot-gas reservoir: a fixed-temperature ambient node at T_aw.  The
    // Bartz-plus-soot film is a pure linear conductance G = h_eff·A_gas,
    // written as a conduction conductor with k = h_eff and L = 1 m because
    // convection conductors require a fluid endpoint and the hot gas is
    // deliberately not a fluid node (see the header).
    solidNodes.push({
      id: `aw${cell.index}`,
      type: "ambient",
      ...glyphOrigin(
        canvasX(zMid),
        canvasY(cell.meanDiameter, CANVAS_ROW_AW),
        SOLID_NODE_SIZE,
      ),
      position: position(zMid, cell.meanDiameter * 0.4),
      temperature: numExpr("reg('tAw')"),
      label: `Hot gas ${cell.index} (T_aw)`,
    });

    conductors.push({
      id: `gasFilm${cell.index}`,
      from: `aw${cell.index}`,
      to: `wg${cell.index}`,
      type: {
        kind: "conduction",
        k: { expr: gasFilmKExpr(cell.index) },
        area: expr(g.gasArea),
        length: 1,
      },
      label: `Gas film ${cell.index}`,
    });
  });

  const inletCell = flowOrder[0];
  const outletCell = flowOrder[flowOrder.length - 1];

  nodes.push({
    id: "manifoldOut",
    type: "boundary",
    ...glyphOrigin(
      canvasX(0) - CANVAS_MANIFOLD_OFFSET,
      canvasY(D_CHAMBER, CANVAS_ROW_COOLANT),
      FLUID_BOUNDARY_SIZE,
    ),
    position: position(0, D_CHAMBER),
    pressure: numExpr("reg('pInjector')"),
    temperature: numExpr("reg('tInlet')"),
    label: "Injector fuel manifold",
  });

  branches.push({
    id: "entrance",
    from: "manifoldIn",
    to: `f${inletCell.index}`,
    component: {
      type: "customResistance",
      k: K_ENTRANCE,
      area: expr(`conductor('film${inletCell.index}').correlation.flowArea`),
    },
    label: "Manifold -> channel entrance",
  });

  for (let i = 0; i < flowOrder.length - 1; i++) {
    const from = flowOrder[i];
    const to = flowOrder[i + 1];
    // Half of each cell's contour length, at the mean of the two geometries.
    const length = from.wallLength / 2 + to.wallLength / 2;
    const hydraulicDiameter =
      (from.hydraulicDiameter + to.hydraulicDiameter) / 2;
    branches.push({
      id: `seg${from.index}`,
      from: `f${from.index}`,
      to: `f${to.index}`,
      component: {
        type: "customResistance",
        k: { kTable: frictionKTable(length, hydraulicDiameter) },
        area: expr(
          `(conductor('film${from.index}').correlation.flowArea + conductor('film${to.index}').correlation.flowArea) / 2`,
        ),
        diameter: expr(
          `(conductor('film${from.index}').correlation.diameter + conductor('film${to.index}').correlation.diameter) / 2`,
        ),
      },
      label: `Channel ${from.index}->${to.index}`,
    });
  }

  branches.push({
    id: "exit",
    from: `f${outletCell.index}`,
    to: "manifoldOut",
    component: {
      type: "customResistance",
      k: K_EXIT,
      area: expr(`conductor('film${outletCell.index}').correlation.flowArea`),
    },
    label: "Channel -> injector manifold",
  });

  const snap = (v: number) =>
    Math.round(v / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
  const canvasNode = (id: string) => {
    const n =
      nodes.find((n) => n.id === id) ?? solidNodes.find((n) => n.id === id);
    if (!n) throw new Error(`regen note placement: missing ${id}`);
    return n;
  };
  const throatCell = cells.reduce((best, c) =>
    c.meanDiameter < best.meanDiameter ? c : best,
  );
  const skirtCell = cells[cells.length - 1]!;
  const injector = canvasNode("manifoldOut");
  const nozzleIn = canvasNode("manifoldIn");
  const awInjector = canvasNode("aw1");
  const awThroat = canvasNode(`aw${throatCell.index}`);
  const awSkirt = canvasNode(`aw${skirtCell.index}`);
  // Park each note next to the hardware it describes, clear of glyph labels.
  const notes: NonNullable<NetworkConfig["notes"]> = [
    {
      id: "noteOverview",
      text: "One rectangular cooling channel of a 1023 kN LOX/RP-1 booster chamber. This is an assumed design point, not a specific engine.\nGRCop-84 liner (named material, k(T) and cp(T); typically printed). The rectangular geometry does not depend on how the liner is made. Numbers are PER CHANNEL — multiply by 260 for the whole jacket. Press Run.",
      x: snap(injector.x),
      y: snap(injector.y - 280),
      width: 380,
    },
    {
      id: "noteCanvas",
      text: "The canvas is a half-section: left is the injector face, right is the cooled skirt, up is radius.\nEach column is one axial station. From the axis out: hot-gas T_aw reservoir, gas-side wall, coolant-side wall, then RP-1. Coolant runs right to left (counter-flow).",
      x: snap(awInjector.x),
      y: snap(awInjector.y + 140),
      width: 380,
    },
    {
      id: "noteHotSide",
      text: "Each Hot Gas node is a 3400 K adiabatic-wall reservoir (reg('tAw')) — not a solved nozzle flow.\nThe link to the wall is the Bartz-plus-soot film: k is a formula for h_eff (L = 1 m). Local ε and z come from the RP-1 node's position and dThroat/zEnd; hgThroat, bartzExp, soot and film-cooling live in registers.",
      x: snap(awThroat.x - 80),
      y: snap(awThroat.y + 100),
      width: 380,
    },
    {
      id: "noteCoolant",
      text: "RP-1 is n-Dodecane. It enters at the nozzle-end manifold and runs toward the injector.\nsettings.momentumFlux is on: heating and decompression accelerate the flow, and that ΔP is in the momentum equation.",
      x: snap(nozzleIn.x + 50),
      y: snap(nozzleIn.y),
      width: 340,
    },
    {
      id: "noteHotSpot",
      text: "Look at where the wall is hottest after Run: not the throat, but the skirt inlet, where the coolant is coldest and slowest.\nCoking margin is set by the cold, slow end. The throat takes the highest film coefficient and still runs cooler.",
      x: snap(awSkirt.x - 30),
      y: snap(awSkirt.y + 100),
      width: 360,
    },
  ];

  const config: NetworkConfig = {
    meta: {
      name: "RP-1 regenerative cooling channel",
      version: 2,
    },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 800,
      relaxation: 0.9,
      // Coolant heating and decompression accelerate the flow along the
      // jacket; carry the (ṁ/A)²·Δ(1/ρ) term instead of quoting it as an
      // omission.
      momentumFlux: true,
    },
    fluid: { model: "realFluid", params: { fluidName: COOLANT } },
    registers: {
      ...HOT_SIDE_REGISTERS,
      nChannels,
      tw: ribThickness,
      Sw: linerThickness,
      h: cells[0]!.depth,
      dThroat: D_THROAT,
      zEnd: Z_END,
      kLiner: K_LINER,
      rhoLiner: RHO_LINER,
      hFin: H_FIN_NOMINAL,
      pJacketIn: jacketInletPressure,
      pInjector: P_INJECTOR_MANIFOLD,
      tInlet: coolantInletT,
      ...Object.fromEntries(cells.map((c) => [`L${c.index}`, c.wallLength])),
      ...(uniformDepth
        ? {}
        : Object.fromEntries(cells.map((c) => [`h${c.index}`, c.depth]))),
    },
    nodes,
    solidNodes,
    conductors,
    branches,
    notes,
  };

  return {
    config,
    cells,
    design: {
      thrustVac: THRUST_VAC,
      ispVac: ISP_VAC,
      mixtureRatio: MIXTURE_RATIO,
      chamberPressure: CHAMBER_PRESSURE,
      mdotTotal: MDOT_TOTAL,
      mdotFuel: MDOT_FUEL,
      throatDiameter: D_THROAT,
      chamberDiameter: D_CHAMBER,
      regenEndDiameter: D_REGEN_END,
      zThroat: Z_THROAT,
      zEnd: Z_END,
      nChannels,
      ribThickness,
      linerThickness,
      mdotChannel,
      coolant: COOLANT,
      adiabaticWallTemperature: T_AW,
      coolantInletTemperature: coolantInletT,
      jacketInletPressure,
      injectorManifoldPressure: P_INJECTOR_MANIFOLD,
      totalHeat: cells.reduce((sum, c) => sum + c.cellHeat, 0),
      totalGasArea: cells.reduce((sum, c) => sum + c.gasArea, 0),
      peakHeatFlux: Math.max(...cells.map((c) => c.heatFlux)),
    },
  };
}

const DEFAULT_MODEL = buildRegenCoolingChannel();

/** The shipped example. */
export const mirandaRegenCoolingChannel: NetworkConfig = DEFAULT_MODEL.config;
/** Per-cell design table of the shipped example, cell 1 at the injector face. */
export const JACKET_CELLS: JacketCell[] = DEFAULT_MODEL.cells;
/** Engine- and jacket-level derived quantities of the shipped example. */
export const JACKET_DESIGN = DEFAULT_MODEL.design;
