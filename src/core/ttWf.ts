/**
 * TT-WF — proposed two-temperature / wetted-fraction (TT-WF) cryogenic
 * chilldown closure.  Integrated at Phase 2: correlations.ts wires it into
 * the conductor heat-transfer path with the accepted-step state lifecycle
 * (fWet/latch frozen mid-step, committed once per accepted transient step).
 *
 * This is a PROPOSED physics closure under evaluation — not a validated
 * model.
 *
 * ============================================================================
 * MODEL (DESIGN §§1–3), as implemented
 * ============================================================================
 * Conserved network state is unchanged (one P, h per fluid node).  Per axial
 * wall segment the closure carries ONE bounded accepted-step state
 *
 *     TtWfState = { fWet ∈ [0,1], rewetLatched ∈ {false,true} }
 *
 * fWet is the fraction of the segment behind the rewet front (subcell front
 * coordinate z_q = z_left + fWet·Δz), NOT a new phase fraction and NOT an
 * HTC multiplier.
 *
 * Two-temperature piece (DESIGN §1.A): the Darr–Hartwig algebraic
 * actual-quality / bulk-vapor-temperature reconstruction (P1 Eqs. 7, 9;
 * K = 5.26e−5·Re_l,in + 0.11), with the repository's corrected
 * single-phase-vapor convention T_v := max(T_v[Eq. 9], T_bulk)
 * (without the floor, Eq. 9 under-reads T_v by 40–80 K at NBS pressures
 * and over-injects wall heat ~9×).  All D-H sub-correlations are REUSED
 * from darrHartwig.ts, not reimplemented.
 *
 * Regime flux map (DESIGN §3): flux is the primary object.
 *   dry side  q_F(T_w) = D-H film boiling Nu_FB·k_g,sat·(T_w−T_v)/D
 *             (IAF/DFFB p-norm, x_a closure — P1 Eqs. 10–12),
 *   wet side  q_W(T_w) = the D-H C1-blended DB→NB→TB map anchored at the
 *             RAW T_wet (S1 Eq. 17 bridge q_NB(T_DNB)→q_FB(T_wet)); above
 *             T_wet the wet side is the film flux (the wall cannot stay
 *             wetted there), so q_W ≥ T_wet continuously equals q_F.
 *   mixture   q_bar = (1−fWet)·q_F + fWet·q_W     (axial area average)
 * At fWet = 0 / 1 this recovers the dry / wet maps exactly.
 *
 * Front evolution (DESIGN §2) — energy- AND liquid-supply-limited advance:
 *   χ_l = clamp((h_g(P) − h)/h_fg(P), 0, 1)   liquid availability gate
 *   j_l = G·χ_l/ρ_l,sat                        liquid superficial velocity [m/s]
 *   E'_q = m'_wall·[H_s(T_w) − H_s(T_DNB)]⁺ + ε_E   wall energy to remove [J/m]
 *   r_E = C_q·P_w·max(q_W − q_F, 0)/E'_q       energy-limited advance RATE [1/s]
 *   r_L = j_l/Δz                                supply-limited advance rate [1/s]
 *   r_q = smoothMin(r_E, r_L; ε_u)
 *   f_trial = fWet + dt·(1−fWet)·r_q ;  fWet' = clamp(f_trial, 0, 1)
 * The (1−f) factor gives a bounded, monotone smeared front.  H_s is the
 * solid enthalpy integral (∫cp dT — exact for tabulated cp, see
 * solidProperties.ts).  q_bar is the SAME heat the wall loses and the
 * mixture gains; E'_q only limits the GEOMETRIC front advance, it is not an
 * additional energy sink (DESIGN §"Conservation and mesh integrity").
 *
 * Hysteresis (DESIGN §"Drying and hysteresis"): the accepted-step latch
 *   set    if T_w ≤ T_wet(G, P)
 *   clear  if T_w ≥ T_wet(G, P) + ΔT_h  AND  χ_l < χ_dry (= 0.02, fixed guard)
 *   retain otherwise.
 * While the latch is false the proposed fWet is held at 0 (a full reversed
 * dry-front speed is deliberately deferred by the DESIGN).  The latch and
 * fWet are READ-ONLY through all Newton/Picard iterations and rejected
 * trials; they advance once per accepted step.  This evaluator is PURE: it
 * reads the accepted state and returns a PROPOSED next state — the
 * integrator (Phase 2) commits it only after step acceptance.
 *
 * ============================================================================
 * DESIGN-DOC AMBIGUITIES RESOLVED HERE (hypotheses to test — the design
 * document is not shipped; no fitted constants)
 * ============================================================================
 * H1 (wet map above T_wet): the DESIGN specifies the wet side only as
 *    "DB-to-NB-to-TB".  We take the D-H blended map anchored at raw T_wet
 *    verbatim — which above T_wet IS the film branch — so q_W is C1 at
 *    T_wet, q_W(T_wet) = q_F(T_wet), and the energy limiter
 *    max(q_W − q_F, 0) shuts itself off exactly where rewet becomes
 *    impossible.  This is the most conservative reading (no extension of
 *    the reverse-slope transition bridge past its anchor).
 * H2 (front-speed units): as printed, DESIGN's u_E = C_q·P_w·(q_W−q_F)/E'_q
 *    has units 1/s while u_L = j_l has units m/s, and the printed update
 *    f + dt(1−f)u_q/Δz requires u_q in m/s.  The dimensionally consistent
 *    reading — adopted here — treats the printed u_E as the advance RATE
 *    r_E [1/s] and puts the 1/Δz with the liquid ceiling: r_L = j_l/Δz.
 *    The f-evolution is then exactly the printed arithmetic,
 *    f' = f + dt(1−f)·smoothMin(r_E, j_l/Δz), and is mesh-consistent:
 *    the energy limit is a local cooling rate (Δz-independent f-rate),
 *    the supply limit is a true speed (front cannot outrun the liquid).
 *    Equivalently one may report segment-traversal SPEEDS u = r·Δz.
 * H3 (E'_q cold-wall guard): DESIGN's E'_q bracket is negative when
 *    T_w < T_DNB (wall already colder than the rewet target).  We floor
 *    the bracket at 0 before adding ε_E, so a pre-cooled wall is purely
 *    liquid-supply-limited (r_E → huge, smoothMin picks r_L) instead of
 *    producing a nonsensical negative rate.
 *
 * ============================================================================
 * NUMERICS (solver devices, NOT physics — none are exposed as parameters)
 * ============================================================================
 *   C1 blend half-widths (0.5 K at T_wet/T_DNB, 0.25 K at T_sat), the IAF
 *   x_e ramp, the p-norm ε, the Re_l,in validity window, the L floor, and
 *   the |T_w − T_node| h_eff secant guard are inherited UNCHANGED from
 *   darrHartwig.ts (SPEC §7.2).  TT-WF adds exactly three fixed numerical
 *   tolerances: χ_dry (0.02 — DESIGN: "not fitted"), ε_E (1e−6 J/m), and
 *   ε_u (1e−12 1/s).  The only PHYSICAL parameters are C_q and ΔT_h.
 *
 * Everything in this module is PURE ALGEBRA over an explicit property
 * bundle (no solver state, no globals): every intermediate quantity is in
 * the result so tests can re-derive it independently.
 */

import {
  DH_BLEND_HALF_WIDTH,
  DH_DB_BLEND_HALF_WIDTH,
  DH_DT_NODE_GUARD,
  DH_L_FRONT_MIN,
  DH_RE_LIN_MIN,
  DH_RE_LIN_MAX,
  darrHartwigK,
  darrHartwigActualQuality,
  darrHartwigVaporTemperature,
  darrHartwigWetTemperature,
  darrHartwigDnbTemperature,
  darrHartwigBlendWeight,
  darrHartwigLiquidDBH,
  darrHartwigNucleateBoilingFlux,
  darrHartwigFilmBoilingFlux,
  type DHClampKind,
  type DHSatState,
  type DHVaporProps,
} from "./darrHartwig";

// ---------------------------------------------------------------------------
// Physical closure parameters (the ONLY ones — DESIGN §"Candidate Parameters")
// ---------------------------------------------------------------------------

/** TT-WF physical parameters.  Both are GLOBALLY-fixed quantities with
 *  pre-registered hard bounds; neither is a solver control. */
export interface TtWfParams {
  /**
   * C_q — ratio of actual to energy-limited rewet-front speed,
   * dimensionless.  Prior median 1; hard bounds [0.25, 4] (DESIGN).
   * Identifiable from inter-station delay / warm-plateau duration.
   */
  frontEnergyFactor: number;
  /**
   * ΔT_h — rewet-to-dry hysteresis temperature separation [K].  Prior
   * scale ~1 K; hard bounds [0, 5] K (DESIGN); default 2 K matches the
   * existing D-H latch offset (DH_HYSTERESIS, SPEC §7.4).
   */
  rewetHysteresisOffsetK: number;
}

/** Defaults per the DESIGN recommendation: C_q = 1, ΔT_h = 2 K ("start with
 *  no fitted parameters"). */
export const TTWF_DEFAULT_PARAMS: TtWfParams = {
  frontEnergyFactor: 1,
  rewetHysteresisOffsetK: 2,
};

/** Pre-registered hard bounds (DESIGN §"Candidate Parameters"). */
const TTWF_FRONT_ENERGY_FACTOR_MIN = 0.25;
const TTWF_FRONT_ENERGY_FACTOR_MAX = 4;
const TTWF_HYSTERESIS_MAX_K = 5;

/**
 * Merge user partials over the defaults.  Only the two known PHYSICAL keys
 * are copied — unknown keys are DROPPED, so solver numerics (blend widths,
 * smooth-min ε, thresholds, iteration counts) cannot be smuggled in
 * (same structural-exclusion contract as closureParams.ts).  Range
 * enforcement is validate.ts's job; the evaluator re-checks bounds and
 * rejects out-of-range values as invalid input (never silently clamps a
 * physical parameter).
 */
export function resolveTtWfParams(p?: Partial<TtWfParams>): TtWfParams {
  return {
    frontEnergyFactor:
      p?.frontEnergyFactor ?? TTWF_DEFAULT_PARAMS.frontEnergyFactor,
    rewetHysteresisOffsetK:
      p?.rewetHysteresisOffsetK ?? TTWF_DEFAULT_PARAMS.rewetHysteresisOffsetK,
  };
}

/** Bounds check used by the evaluator (defense in depth behind validate.ts). */
function ttWfParamsInBounds(p: TtWfParams): boolean {
  return (
    Number.isFinite(p.frontEnergyFactor) &&
    p.frontEnergyFactor >= TTWF_FRONT_ENERGY_FACTOR_MIN &&
    p.frontEnergyFactor <= TTWF_FRONT_ENERGY_FACTOR_MAX &&
    Number.isFinite(p.rewetHysteresisOffsetK) &&
    p.rewetHysteresisOffsetK >= 0 &&
    p.rewetHysteresisOffsetK <= TTWF_HYSTERESIS_MAX_K
  );
}

// ---------------------------------------------------------------------------
// Fixed numerical tolerances (solver numerics — NOT fit parameters, DESIGN)
// ---------------------------------------------------------------------------

/** χ_dry: liquid-availability floor for the drying rule (DESIGN: "a fixed
 *  numerical/physical guard to avoid drying on roundoff-quality vapor;
 *  it is not fitted"). */
export const TTWF_CHI_DRY = 0.02;

/** ε_E: floor on E'_q [J/m] — keeps r_E finite for a pre-cooled wall;
 *  9+ orders below physical values (m'·c_p·ΔT ≳ 10³ J/m). */
export const TTWF_FRONT_ENERGY_EPS = 1e-6;

/** ε_u: smoothMin tolerance on advance RATES [1/s] (DESIGN: "a fixed
 *  numerical tolerance, not a fitted parameter"). */
export const TTWF_SMOOTH_MIN_EPS = 1e-12;

// ---------------------------------------------------------------------------
// Accepted-step state
// ---------------------------------------------------------------------------

/**
 * Bounded accepted-step TT-WF state of ONE axial wall segment.  Read-only
 * inside all Newton/Picard iterations and rejected trials; advanced once
 * per accepted step by committing a proposed state from evaluateTtWf.
 */
export interface TtWfState {
  /** Wetted fraction f_w ∈ [0,1]: subcell front coordinate z_q = z_left + f_w·Δz. */
  readonly fWet: number;
  /** Rewet-hysteresis latch (DESIGN §"Drying and hysteresis"). */
  readonly rewetLatched: boolean;
}

/** Hot/dry initial state (un-rewetted wall). */
export const TTWF_INITIAL_STATE: TtWfState = { fWet: 0, rewetLatched: false };

/** Memoryless initialization from a wall temperature (mirrors the D-H
 *  latch initialization at t = 0): a wall already at/below T_wet starts
 *  wetted (f = 1, latched); a hotter wall starts dry (f = 0, unlatched). */
export function initTtWfState(Tw: number, Twet: number): TtWfState {
  return Tw <= Twet
    ? { fWet: 1, rewetLatched: true }
    : { fWet: 0, rewetLatched: false };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Wall energy context of the segment (DESIGN §2): wall mass per axial
 * length m'_wall [kg/m] and the solid enthalpy integral H_s(T) [J/kg]
 * (∫cp dT — exact for tabulated cp via PiecewiseLinearProperty.integral;
 * for constant cp, H_s(T) = cp·T).  Only DIFFERENCES of H_s are used.
 */
export interface TtWfWallContext {
  massPerLength: number; // kg/m
  enthalpy: (T: number) => number; // J/kg
}

export interface TtWfEvaluateArgs {
  /** Saturation-state properties at local P (same bundle as darrHartwig). */
  sat: DHSatState;
  /** Vapor PT lookup at local P (implementation clamps T into validity). */
  vaporProps: (T: number) => DHVaporProps;
  Tw: number; // K, local wall temperature (evaluation state)
  /** K, fluid-node bulk temperature statePH(P,h).T — the T_v floor
   *  (corrected SP convention, see header) and the h_eff secant reference. */
  Tnode: number;
  /** J/kg, fluid-node mixture specific enthalpy (drives x_e AND χ_l — the
   *  two-temperature closure and the liquid-availability gate both read the
   *  same conserved enthalpy, DESIGN §§1–2). */
  hNode: number;
  G: number; // kg/m²·s, local mass flux (≥ 0)
  D: number; // m, tube inner diameter
  L: number; // m, axial distance from the quench front (D-H IAF term)
  ReLin: number; // inlet liquid Reynolds (one global value per pipe)
  segmentLength: number; // m, axial length Δz of the segment
  /** s, ACCEPTED-step size for the fWet/latch proposal.  The flux/h_eff
   *  part of the result is independent of dt (dt only scales the proposal);
   *  dt = 0 proposes the accepted state unchanged. */
  dt: number;
  /** ACCEPTED state — read-only, never mutated. */
  state: TtWfState;
  wall: TtWfWallContext;
  params?: Partial<TtWfParams>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Which ceiling bound the front advance this evaluation.  'none' ⇔ no
 *  advance possible (q_W ≤ q_F: the wall is too hot for the wet side to
 *  out-extract the dry side, DESIGN §2). */
export type TtWfLimiter = "energy" | "supply" | "none";

export type TtWfLatchTransition = "set" | "cleared" | "unchanged";

export interface TtWfResult {
  // --- two-temperature closure (D-H algebra, reused) ---
  xe: number; // equilibrium quality (h − h_f)/h_fg
  xa: number; // actual quality (P1 Eq. 7)
  Tv: number; // K, bulk vapor temperature (Eq. 9 floored at T_bulk)
  Twet: number; // K, rewet temperature (P1 Eq. 18, T_cr-capped)
  TDnb: number; // K, NB/TB boundary (P1 Eq. 19, collapse-shifted if needed)
  // --- regime flux map (DESIGN §3) ---
  qDry: number; // W/m², q_F(T_w) — D-H film boiling on (T_w − T_v)
  qWet: number; // W/m², q_W(T_w) — D-H DB/NB/TB map anchored at T_wet
  /** Area-average wall→fluid flux (1−f)·q_F + f·q_W at the ACCEPTED f. */
  qBar: number; // W/m²
  /** Guarded secant h_eff = q_bar/(T_w − T_node) [W/m²K] — see below. */
  hEff: number;
  /** true if |T_w − T_node| < 0.1 K and the guarded secant was used. */
  hEffGuarded: boolean;
  /** Blend weights of the area average (accepted state, read-only). */
  wetWeight: number; // = fWet
  dryWeight: number; // = 1 − fWet
  /** Un-blended regime labels of each side at T_w (blends only smooth seams). */
  dryRegime: "FB" | "SP";
  wetRegime: "DB" | "NB" | "TB" | "FB";
  // --- front evolution (DESIGN §2) ---
  chiL: number; // liquid availability ∈ [0,1]
  jL: number; // m/s, liquid superficial velocity G·χ_l/ρ_l
  frontEnergyPerLength: number; // J/m, E'_q actually used (floored)
  rEnergy: number; // 1/s, r_E = C_q·P_w·max(q_W−q_F,0)/E'_q
  rLiquid: number; // 1/s, r_L = j_l/Δz
  rFront: number; // 1/s, r_q = smoothMin(r_E, r_L; ε_u)
  /** Equivalent segment-traversal speed r_q·Δz [m/s] (interpretive; the
   *  f-evolution above is the conservative mesh-consistent form, H2). */
  frontSpeed: number; // m/s
  limiter: TtWfLimiter;
  // --- proposed next state (commit ONLY after step acceptance) ---
  proposedState: TtWfState;
  latchTransition: TtWfLatchTransition;
  /** true if the bounded update pulled f_trial back into [0,1]. */
  fWetClamped: boolean;
  /** D-H validity guards that fired (pass-through; count via diagnostics). */
  clamps: DHClampKind[];
  /** Resolved physical parameters used. */
  params: TtWfParams;
}

export type TtWfOutcome =
  { ok: true; result: TtWfResult } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Pure pieces (exported so tests can re-derive every intermediate)
// ---------------------------------------------------------------------------

/** smoothMin(a,b;ε) = ½(a+b − √((a−b)² + ε²)) — differentiable (DESIGN §2). */
export function ttWfSmoothMin(
  a: number,
  b: number,
  eps: number = TTWF_SMOOTH_MIN_EPS,
): number {
  return 0.5 * (a + b - Math.sqrt((a - b) * (a - b) + eps * eps));
}

/** Liquid-availability gate χ_l = clamp((h_g − h)/h_fg, 0, 1) (DESIGN §2).
 *  NOT a literal volume fraction: it goes to zero for a strongly superheated
 *  mixture and prevents rewetting without latent-capable inflow. */
export function ttWfLiquidAvailability(hNode: number, sat: DHSatState): number {
  const hg = sat.hf + sat.hfg;
  const chi = (hg - hNode) / sat.hfg;
  return Math.min(1, Math.max(0, chi));
}

/** Wetted perimeter of a circular tube, P_w = π·D [m]. */
export function ttWfWettedPerimeter(D: number): number {
  return Math.PI * D;
}

/**
 * Wall energy per axial length the front must remove [J/m]:
 *   E'_q = m'_wall·[H_s(T_w) − H_s(T_DNB)]⁺ + ε_E
 * (DESIGN §2 with the H3 cold-wall floor, see header).  E'_q only limits
 * the GEOMETRIC front advance; it is not an energy sink.
 */
export function ttWfFrontEnergyPerLength(
  wall: TtWfWallContext,
  Tw: number,
  TDnb: number,
): number {
  const dH = wall.enthalpy(Tw) - wall.enthalpy(TDnb);
  return wall.massPerLength * Math.max(dH, 0) + TTWF_FRONT_ENERGY_EPS;
}

/**
 * Rewet-hysteresis latch rule (DESIGN §"Drying and hysteresis"):
 *   set    if T_w ≤ T_wet
 *   clear  if T_w ≥ T_wet + ΔT_h AND χ_l < χ_dry
 *   retain otherwise.
 * Pure: returns the PROPOSED latch; never mutates the accepted state.
 */
export function ttWfLatchUpdate(
  Tw: number,
  Twet: number,
  chiL: number,
  latched: boolean,
  hysteresisK: number,
): boolean {
  if (Tw <= Twet) return true;
  if (Tw >= Twet + hysteresisK && chiL < TTWF_CHI_DRY) return false;
  return latched;
}

/**
 * Accepted-step wetted-fraction update (DESIGN §2, units-repaired per H2):
 *   f_trial = f + dt·(1−f)·smoothMin(r_E, r_L; ε_u),  f' = clamp(f_trial, 0, 1).
 * With the latch false the front is held at f = 0 (a reversed dry-front
 * speed is deliberately deferred by the DESIGN).  The (1−f) factor gives a
 * bounded, monotone smeared front; f can never decrease while latched
 * (r_q ≥ −ε_u/2 by smoothMin construction, and the clamp is counted).
 */
export function ttWfWettedFractionUpdate(
  f: number,
  latchedNext: boolean,
  rEnergy: number,
  rLiquid: number,
  dt: number,
  _segmentLength: number,
): { fNext: number; rFront: number; clamped: boolean; limiter: TtWfLimiter } {
  // Both rates are non-negative BY CONSTRUCTION (r_E carries max(q_W−q_F, 0);
  // r_L = j_l/Δz with G, χ_l ≥ 0).  smoothMin undershoots by up to ε_u/2 at
  // a = b (differentiable-by-design artifact); since a negative front rate
  // would be a reversed dry-front speed — which the DESIGN deliberately
  // defers — the rate is floored at 0.  The floor only cancels the
  // ε-undershoot; it can never bind a physically positive rate.
  const rFront = Math.max(ttWfSmoothMin(rEnergy, rLiquid), 0);
  const limiter: TtWfLimiter =
    rEnergy <= 0 ? "none" : rEnergy < rLiquid ? "energy" : "supply";
  if (!latchedNext) {
    return { fNext: 0, rFront, clamped: f !== 0, limiter };
  }
  const fTrial = f + dt * (1 - f) * rFront;
  const fNext = Math.min(1, Math.max(0, fTrial));
  return { fNext, rFront, clamped: fNext !== fTrial, limiter };
}

// ---------------------------------------------------------------------------
// Input validation (fail loud, never silently repair — invalidInput counter)
// ---------------------------------------------------------------------------

function invalid(reason: string): TtWfOutcome {
  return { ok: false, reason };
}

function validateInputs(
  args: TtWfEvaluateArgs,
  params: TtWfParams,
): string | null {
  const fin = (v: number) => Number.isFinite(v);
  if (!fin(args.Tw) || args.Tw <= 0)
    return `Tw must be finite positive K (got ${args.Tw})`;
  if (!fin(args.Tnode) || args.Tnode <= 0)
    return `Tnode must be finite positive K (got ${args.Tnode})`;
  if (!fin(args.hNode)) return `hNode must be finite (got ${args.hNode})`;
  if (!fin(args.G) || args.G < 0)
    return `G must be finite >= 0 (got ${args.G})`;
  if (!fin(args.D) || args.D <= 0)
    return `D must be finite positive (got ${args.D})`;
  if (!fin(args.L)) return `L must be finite (got ${args.L})`;
  if (!fin(args.ReLin)) return `ReLin must be finite (got ${args.ReLin})`;
  if (!fin(args.segmentLength) || args.segmentLength <= 0)
    return `segmentLength must be finite positive (got ${args.segmentLength})`;
  if (!fin(args.dt) || args.dt < 0)
    return `dt must be finite >= 0 (got ${args.dt})`;
  if (!fin(args.wall.massPerLength) || args.wall.massPerLength <= 0)
    return `wall.massPerLength must be finite positive (got ${args.wall.massPerLength})`;
  if (!fin(args.state.fWet) || args.state.fWet < 0 || args.state.fWet > 1)
    return `state.fWet must be in [0,1] (got ${args.state.fWet})`;
  if (typeof args.state.rewetLatched !== "boolean")
    return "state.rewetLatched must be boolean";
  if (!ttWfParamsInBounds(params))
    return (
      `ttWf params out of bounds: frontEnergyFactor in [${TTWF_FRONT_ENERGY_FACTOR_MIN}, ` +
      `${TTWF_FRONT_ENERGY_FACTOR_MAX}], rewetHysteresisOffsetK in [0, ${TTWF_HYSTERESIS_MAX_K}] ` +
      `(got ${JSON.stringify(params)})`
    );
  const s = args.sat;
  if (!fin(s.Tsat) || s.Tsat <= 0)
    return `sat.Tsat must be finite positive (got ${s.Tsat})`;
  if (!fin(s.hf) || !fin(s.hfg) || !(s.hfg > 0))
    return `sat.hf/hfg invalid (hf=${s.hf}, hfg=${s.hfg})`;
  if (!fin(s.rhof) || !(s.rhof > 0))
    return `sat.rhof must be finite positive (got ${s.rhof})`;
  return null;
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate the TT-WF closure at one segment/state.  PURE: reads the
 * ACCEPTED state, returns fluxes/regimes/diagnostics AND a PROPOSED next
 * state; mutates nothing.  The integrator commits proposedState only after
 * the step is accepted (frozen through Newton/Picard and rejected trials —
 * docs/solver-convergence.md is the standing warning).
 */
export function evaluateTtWf(args: TtWfEvaluateArgs): TtWfOutcome {
  const params = resolveTtWfParams(args.params);
  const bad = validateInputs(args, params);
  if (bad !== null) return invalid(bad);

  const { sat, vaporProps, Tw, Tnode, G, D } = args;
  const clamps = new Set<DHClampKind>();

  // --- D-H validity guards (SPEC §2.10), identical to evaluateDarrHartwig ---
  let ReLin = args.ReLin;
  if (!(ReLin >= DH_RE_LIN_MIN && ReLin <= DH_RE_LIN_MAX)) {
    ReLin = Math.min(DH_RE_LIN_MAX, Math.max(DH_RE_LIN_MIN, ReLin));
    clamps.add("relin");
  }
  let L = args.L;
  if (!(L >= DH_L_FRONT_MIN)) {
    L = DH_L_FRONT_MIN;
    clamps.add("frontDistance");
  }

  // --- Boundary temperatures.  TT-WF anchors the wet map at the RAW T_wet:
  //     ΔT_h lives in the accepted-step LATCH, not in a shifted map anchor
  //     (H1; contrast the D-H latch which shifts T_wet,eff). ---
  const wet = darrHartwigWetTemperature(G, D, sat.rhof, sat.sigma, sat.Tcr);
  if (wet.clamped) clamps.add("twetCrit");
  const Twet = wet.Twet;
  let TDnb = darrHartwigDnbTemperature(sat.Tsat);
  if (TDnb > Twet - 2 * DH_BLEND_HALF_WIDTH) {
    // Near-critical regime-map collapse guard (same as darrHartwig).
    TDnb = Twet - 2 * DH_BLEND_HALF_WIDTH;
    clamps.add("regimeCollapse");
  }

  // --- Two-temperature closure (P1 Eqs. 7, 9 + corrected SP convention) ---
  const xe = (args.hNode - sat.hf) / sat.hfg;
  const K = darrHartwigK(ReLin);
  const xa = darrHartwigActualQuality(xe, K);
  let Tv = darrHartwigVaporTemperature(xe, xa, sat.hfg, sat.cpg, sat.Tsat);
  if (Tv < Tnode) Tv = Tnode; // T_v = max(T_v, T_bulk) — see darrHartwig.ts header
  if (Tv > sat.TvapMax) {
    Tv = sat.TvapMax;
    clamps.add("tvapLimit");
  }
  const rhoV = xa > 0 ? vaporProps(Tv).rho : sat.rhog;

  // --- Regime flux map (DESIGN §3).  The closures below replicate
  //     evaluateDarrHartwig's blended q(T_w) with latch=false (T_wet,eff =
  //     T_wet) term for term and in the same operation order, so TT-WF's
  //     wet side is the D-H map bit-for-bit below T_wet and its dry side is
  //     D-H's film branch (test F asserts the agreement). ---
  const fbCtx = { G, D, L, xe, xa, Tv, rhoV, sat, vaporProps };
  const qFB = (tw: number) => darrHartwigFilmBoilingFlux(fbCtx, tw);
  const qNB = (tw: number) =>
    darrHartwigNucleateBoilingFlux(G, D, sat, tw - sat.Tsat);
  const hDB = darrHartwigLiquidDBH(G, D, sat);
  const qDB = (tw: number) => hDB * (tw - Tnode);

  let qFBatWetCache: number | undefined;
  const qFBatWet = () => (qFBatWetCache ??= qFB(Twet));
  let qNBatDNBCache: number | undefined;
  const qNBatDNB = () => (qNBatDNBCache ??= qNB(TDnb));
  // Linear transition bridge (S1 Eq. 17) — C0 at both anchors by construction
  const qTB = (tw: number) =>
    ((qNBatDNB() - qFBatWet()) * (tw - Twet)) / (TDnb - Twet) + qFBatWet();

  // Wet-side map: the C1-blended DB→NB→TB→(FB above T_wet) construction of
  // evaluateDarrHartwig with a raw-T_wet anchor (SPEC §7.2 blends, same
  // half-widths, same evaluation order).
  const qWetAt = (tw: number): number => {
    const sWet = darrHartwigBlendWeight(tw, Twet, DH_BLEND_HALF_WIDTH);
    let v: number;
    if (sWet >= 1) v = qFB(tw);
    else if (sWet <= 0) v = qTB(tw);
    else v = qTB(tw) * (1 - sWet) + qFB(tw) * sWet;

    const sDnb = darrHartwigBlendWeight(tw, TDnb, DH_BLEND_HALF_WIDTH);
    if (sDnb >= 1) return v;
    if (sDnb <= 0) v = qNB(tw);
    else v = qNB(tw) * (1 - sDnb) + v * sDnb;

    const sDb = darrHartwigBlendWeight(tw, sat.Tsat, DH_DB_BLEND_HALF_WIDTH);
    if (sDb >= 1) return v;
    if (sDb <= 0) return qDB(tw);
    return qDB(tw) * (1 - sDb) + v * sDb;
  };

  const qDry = qFB(Tw);
  const qWet = qWetAt(Tw);

  // --- Area average at the ACCEPTED fWet (DESIGN §"Conservation"): the
  //     same q_bar heats the mixture and cools the wall; fWet creates no
  //     latent heat. ---
  const f = args.state.fWet;
  const qBarAt = (tw: number) => (1 - f) * qFB(tw) + f * qWetAt(tw);
  const qBar = (1 - f) * qDry + f * qWet;

  // --- Guarded secant h_eff (identical contract to darrHartwig.ts's
  //     header): h_eff = q_bar/(T_w − T_node), and within 0.1 K of the
  //     node temperature the secant through the guarded point is used, so
  //     h_eff stays finite as T_w → T_node. ---
  const dTn = Tw - Tnode;
  let hEff: number;
  let hEffGuarded = false;
  if (Math.abs(dTn) >= DH_DT_NODE_GUARD) {
    hEff = qBar / dTn;
  } else {
    const sgn = dTn >= 0 ? 1 : -1;
    hEff = qBarAt(Tnode + sgn * DH_DT_NODE_GUARD) / (sgn * DH_DT_NODE_GUARD);
    hEffGuarded = true;
  }

  // --- Front evolution (DESIGN §2, H2/H3) ---
  const chiL = ttWfLiquidAvailability(args.hNode, sat);
  const jL = (G * chiL) / sat.rhof;
  const Eq = ttWfFrontEnergyPerLength(args.wall, Tw, TDnb);
  if (!Number.isFinite(Eq))
    return invalid("wall enthalpy returned a non-finite value");
  const Pw = ttWfWettedPerimeter(D);
  const rEnergy =
    (params.frontEnergyFactor * Pw * Math.max(qWet - qDry, 0)) / Eq;
  const rLiquid = jL / args.segmentLength;

  const latchedNext = ttWfLatchUpdate(
    Tw,
    Twet,
    chiL,
    args.state.rewetLatched,
    params.rewetHysteresisOffsetK,
  );
  const upd = ttWfWettedFractionUpdate(
    f,
    latchedNext,
    rEnergy,
    rLiquid,
    args.dt,
    args.segmentLength,
  );

  const latchTransition: TtWfLatchTransition =
    latchedNext === args.state.rewetLatched
      ? "unchanged"
      : latchedNext
        ? "set"
        : "cleared";

  // --- Un-blended regime labels ---
  const dryRegime: "FB" | "SP" = xa >= 0.99 ? "SP" : "FB";
  const wetRegime: "DB" | "NB" | "TB" | "FB" =
    Tw > Twet ? "FB" : Tw > TDnb ? "TB" : Tw > sat.Tsat ? "NB" : "DB";

  return {
    ok: true,
    result: {
      xe,
      xa,
      Tv,
      Twet,
      TDnb,
      qDry,
      qWet,
      qBar,
      hEff,
      hEffGuarded,
      wetWeight: f,
      dryWeight: 1 - f,
      dryRegime,
      wetRegime,
      chiL,
      jL,
      frontEnergyPerLength: Eq,
      rEnergy,
      rLiquid,
      rFront: upd.rFront,
      frontSpeed: upd.rFront * args.segmentLength,
      limiter: upd.limiter,
      proposedState: { fWet: upd.fNext, rewetLatched: latchedNext },
      latchTransition,
      fWetClamped: upd.clamped,
      clamps: [...clamps],
      params,
    },
  };
}
