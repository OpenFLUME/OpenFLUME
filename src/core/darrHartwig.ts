/**
 * Darr–Hartwig 2020 cryogenic flow-boiling correlation set (LH2) — opt-in
 * convection-correlation model for chilldown simulation.
 *
 * PRIMARY SOURCE: Darr & Hartwig, "Two-Phase Convection Heat Transfer
 * Correlations for Liquid Hydrogen Pipe Chilldown," NTRS 20190029114 (author
 * preprint of Cryogenics 105:102999, 2020) — cited as "P1" throughout. Every
 * constant below is transcribed from P1 Table 1 / Eqs. (3)–(19); anything the
 * paper leaves unspecified is an implementer decision and is flagged as such
 * inline. Validity: LH2, vertical upward flow, 1 g (the P1 fit envelope).
 *
 * ============================================================================
 * INTEGRATION CONTRACT (h_eff secant — task decision, documented)
 * ============================================================================
 * The conductor framework computes Q = h·A·(T_wall − T_node) with h FROZEN
 * within each Newton solve and refreshed between outer (Picard) iterations.
 * This correlation set, however, drives film boiling on (T_w − T_v) with T_v
 * from its own non-equilibrium bulk-vapor-temperature equation (P1 Eq. 9) —
 * NOT (T_w − T_sat): using (T_w − T_sat) is precisely the error the x_a/T_v
 * machinery corrects.
 *
 * We therefore return the exact SECANT
 *
 *     h_eff = q″(T_w) / (T_w − T_node)
 *
 * evaluated at the frozen Picard state, where q″ is the full blended
 * regime map below and T_node is the fluid-node bulk temperature (= T_sat
 * for a two-phase equilibrium node). At the converged Picard fixed point
 * Q = h_eff·A·(T_w − T_node) = q″·A exactly; within a step it is a
 * secant slope, the same linearization the framework already applies to
 * every state-dependent h. No framework change (no Q-injection path) is
 * required.
 *
 * T_w → T_node guard: when |T_w − T_node| < DH_DT_NODE_GUARD (0.1 K), h_eff
 * is replaced by the secant through the guarded point T_node ± 0.1 K:
 * h_eff = q″(T_node ± 0.1)/(±0.1). This is the h-cap for the NB Ja^(−0.254)
 * singularity (an implementation device, not from P1), generalized to the
 * whole map; h_eff is then bounded and continuous in T_w (a C0 kink at
 * the guard seam, far inside any physical boundary layer). q″ itself is
 * always evaluated at the true T_w.
 *
 * Sign analysis: T_v ≥ T_node holds BY CONSTRUCTION (see the T_v floor in
 * evaluateDarrHartwig): thermodynamically the vapor phase of a
 * non-equilibrium mixture at enthalpy h is HOTTER than the equilibrium bulk
 * temperature at the same h (the un-evaporated liquid fraction (1−x_a) locks
 * up latent enthalpy: T_v − T_sat = [(T_bulk − T_sat) + (1−x_a)·h_fg/c_p]/
 * x_a ≥ T_bulk − T_sat). Eq. 9 is that identity with c_p,v frozen at the
 * saturated-vapor value; at elevated pressure (c_p,v,sat rises steeply toward
 * the dome: 13.4 kJ/kgK at 2 bar → 19.5 at 5.2 bar → 29.4 at 11.2 bar for
 * para-H2) the frozen-c_p linearization UNDER-reads T_v by up to ~80 K at
 * x_e ≈ 8 — i.e. it breaks its own energy identity. P1's SP branch avoids
 * this by construction: "if x_a > 0.99, set x_a = 1 and the heat transfer
 * mechanism is single-phase vapor convection" (p. 13) with T_v the node
 * bulk gas temperature (P1 Eq. 9 context). We therefore floor T_v at the
 * node bulk temperature: T_v := max(T_v[Eq. 9], T_node). This is exactly
 * P1's SP semantics, restored continuously (the 0.99→1 snap removal is
 * retained for x_a/α/Re_tp but must NOT extend Eq. 9 past the SP boundary —
 * a ~1 % Nu correction there vs. an 8.9× wall-heat over-injection error
 * here, measured on the 74.97 psia trace).
 * With the floor, q″ and (T_w − T_node) share sign in FB/SP whenever
 * T_w ≥ T_v or T_w ≤ T_node; the remaining negative-h_eff sliver
 * T_node < T_w < T_v (hot vapor core over a wall that is above T_sat but
 * below the vapor temperature — genuinely two-way heat transfer) is floored
 * by the shared FALLBACK_H_FLOOR clamp in correlations.ts (counted via
 * hFloorClampCount). Rare, small, and loud.
 *
 * ============================================================================
 * REGIME MAP (P1 p. 16 selection logic) with C1 blends — all C1 in T_w
 * ============================================================================
 *   T_w ≤ T_sat        : single-phase liquid Dittus–Boelter q″ = h_DB·(T_w − T_node)
 *                        [implementer extension — the published set does not
 *                        cover sub-T_sat walls]
 *   T_sat < T_w ≤ T_DNB: nucleate boiling, q-FORM (see below)
 *   T_DNB < T_w ≤ T_wet,eff: linear transition bridge (P1 Eq. 17)
 *   T_w > T_wet,eff    : film boiling (P1 Eqs. 10–11) with x_a closure (Eq. 7),
 *                        T_v (Eq. 9); SP vapor is the automatic x_a → 1 limit
 *                        (Eq. 12) — P1 p. 13's 0.99→1 snap is REMOVED so x_a
 *                        rides continuously (deviation ≪ 1 %).
 *
 * Blends (implementer smoothing design, not from the sources): cubic-Hermite
 * (smoothstep) in T_w, half-width DH_BLEND_HALF_WIDTH = 0.5 K at T_wet,eff
 * and T_DNB (0.5 ≪ T_wet − T_DNB ≈ 5–10 K for LH2); DB↔NB blend half-width
 * 0.25 K at T_sat; Nu_IAF multiplied by smoothstep S(x_e): 1 for x_e ≤ 0.9,
 * 0 for x_e ≥ 1.0 (replaces P1's hard x_e > 1 switch); p-norm ε = 1e−30
 * guards 0^0.75. The NB branch is evaluated in q-form so the Ja^(−0.254)
 * h-singularity never materialises.
 *
 * NB: q″ ∝ ΔT^0.746 near ΔT = 0 is the PHYSICAL boiling-curve cusp of the
 * published set (h_NB → ∞); it is not a regime boundary. C1 holds at both
 * published regime boundaries (T_wet, T_DNB).
 *
 * ============================================================================
 * REWET HYSTERESIS LATCH (implementer addition, not in P1)
 * ============================================================================
 * The published set is memoryless; G oscillations can flap a node across
 * T_wet. The caller freezes a per-conductor boolean latch at TIME-STEP
 * level (see correlations.ts updateDarrHartwigLatches): once T_w ≤ T_wet
 * the node is latched rewetted and the FB boundary shifts to
 * T_wet,eff = T_wet + DH_HYSTERESIS (2 K) until T_w > T_wet,eff. The TB
 * bridge re-anchors to q″_FB(T_wet,eff), preserving C0 by construction.
 * The latch is never read or written inside a Newton iteration.
 *
 * ============================================================================
 * VALIDITY GUARDS (P1 fit envelope) — clamp + diagnostics counter, never silent
 * ============================================================================
 *   relin:          Re_l,in clamped into [1e4, 1e6] (fit 18,400–433,000, margin)
 *   twetCrit:       T_wet clamped to ≤ T_cr (Weber blow-up / γ → 0 near-critical).
 *                   NOTE: raw Eq. 18 crosses T_cr at G ≳ 48 kg/m²s (2 bar,
 *                   1.02 cm) — INSIDE the fit envelope's high-G end (G ≤ 81);
 *                   P1's "31–33 K" summary does not hold there with real LH2
 *                   properties (raw T_wet(81) ≈ 33.8–34.6 K over the 0.9–3.2
 *                   bar test range). The cap is the physically meaningful
 *                   bound (no boiling regime map above T_cr) and shifts the
 *                   FB boundary by ≲ 1.3 K where it binds — far below the
 *                   correlation's own 19.5 K fit MAE.
 *   tvapLimit:      T_v clamped to ≤ 0.95·T_max of the property package
 *   frontDistance:  L floored at DH_L_FRONT_MIN = 0.05 m (~1 node length of
 *                   the 43-node / 1.98 m GFSSP reference model)
 *   regimeCollapse: T_sat + 2 K would meet/exceed T_wet,eff (near-critical,
 *                   far outside the fit envelope): T_DNB is shifted down to
 *                   keep a minimal TB segment and the formulas finite.
 * Additionally the FLUID check (fit is LH2-only) is enforced by the caller
 * via a diagnostic, and a property-evaluation failure degrades to the
 * fallback h floor with its own counter (both in correlations.ts).
 *
 * Everything in this module is PURE ALGEBRA over an explicit property bundle
 * (no solver state, no globals) so the tests can re-derive every number
 * independently from the published formulas.
 */

import { DEFAULT_GRAVITY } from "./schema";

/** Standard-gravity magnitude [m/s²] — the schema default along −y. */
const STANDARD_GRAVITY = -DEFAULT_GRAVITY.z;

// ---------------------------------------------------------------------------
// Numerics guards (solver devices, NOT physics constants — each cited)
// ---------------------------------------------------------------------------

/** T_w blend half-width at T_wet,eff / T_DNB [K] (implementer smoothing). */
export const DH_BLEND_HALF_WIDTH = 0.5;
/** T_w blend half-width at T_sat for the DB extension [K]. */
export const DH_DB_BLEND_HALF_WIDTH = 0.25;
/** Rewet hysteresis offset [K] (implementer addition, ΔT_hyst ≈ 2 K). */
export const DH_HYSTERESIS = 2.0;
/** |T_w − T_node| guard for the h_eff secant [K] (see module header). */
export const DH_DT_NODE_GUARD = 0.1;
/** Re_l floor: NB carries Re_l^(−0.332) — a negative exponent needs Re_l > 0. */
const DH_RE_L_FLOOR = 1;
/** L floor [m] — guard L ≥ ~1 node length at the quench front. */
export const DH_L_FRONT_MIN = 0.05;
/** Re_l,in validity clamp window (fit 18,400–433,000 with generous margin). */
export const DH_RE_LIN_MIN = 1e4;
export const DH_RE_LIN_MAX = 1e6;
/** p-norm 0^0.75 guard. */
const DH_PNORM_EPS = 1e-30;
/** Nu_IAF smoothstep ramp edges in x_e (replaces P1's hard x_e > 1 switch). */
const DH_IAF_RAMP_XE_LO = 0.9;
const DH_IAF_RAMP_XE_HI = 1.0;
/** IAF buoyancy-bracket (T_w − T_sat) floor [K] — binds only in the counted
 *  regimeCollapse state (in-envelope T_w > T_wet ⇒ T_w − T_sat ≳ 4 K). */
const DH_IAF_DT_FLOOR = 0.1;

// ---------------------------------------------------------------------------
// Property bundle (assembled by the caller from a RealFluid)
// ---------------------------------------------------------------------------

/** Saturation-state properties at local P plus critical/validity constants. */
export interface DHSatState {
  Tsat: number; // K
  hf: number; // J/kg, saturated liquid enthalpy (x_e reference)
  hfg: number; // J/kg, latent heat
  rhof: number; // kg/m³, saturated liquid
  rhog: number; // kg/m³, saturated vapor
  muf: number; // Pa·s, saturated liquid
  mug: number; // Pa·s, saturated vapor (μ_g of the IAF bracket; state not printed in P1)
  cpf: number; // J/kg·K, saturated liquid
  cpg: number; // J/kg·K, saturated vapor (c_p,v fixed at sat — P1 p. 13)
  kf: number; // W/m·K, saturated liquid
  kg: number; // W/m·K, saturated vapor
  sigma: number; // N/m, surface tension at saturation (We_D)
  Tcr: number; // K, critical temperature of the property package in use
  TvapMax: number; // K, vapor-property validity ceiling (0.95·T_max)
}

/** Vapor transport properties at (P, T) — superheated vapor PT lookup.
 *  The implementation clamps T into the valid single-phase range. */
export interface DHVaporProps {
  rho: number;
  mu: number;
  cp: number;
  k: number;
}

// ---------------------------------------------------------------------------
// Non-equilibrium closure (P1 Eqs. 7, 9, Table 1)
// ---------------------------------------------------------------------------

/** K = 5.26e−5·Re_l,in + 0.11  [P1 Table 1 — a 2025 companion slide deck
 *  prints 0.1; the source publication's 0.11 is used]. */
export function darrHartwigK(ReLin: number): number {
  return 5.26e-5 * ReLin + 0.11;
}

/** Actual (non-equilibrium) quality x_a = (x_e^(−K) + 1)^(−1/K)  [P1 Eq. 7].
 *  x_a = 0 for x_e ≤ 0 (subcooled: DF term off, P1 p. 13). x_a < x_e always
 *  and → 1 only as x_e → ∞; the 0.99→1 snap of P1 p. 13 is intentionally NOT
 *  applied (continuity choice — deviation ≪ 1 %).
 *  Numerically stable rewrites (identical algebra, branch on x_e so neither
 *  x_e^±K can overflow):
 *    x_e ≤ 1: x_a = x_e·exp(−log1p(x_e^K)/K)  — also rounds strictly below
 *             x_e, so the invariant x_a < x_e holds in floating point (the
 *             single exp/log1p form below lands up to 2 ulp ABOVE x_e for
 *             x_e ≲ 1, e.g. x_e = 1e-3, K = 5);
 *    x_e > 1: x_a = exp(−log1p(exp(−K·log x_e))/K)  (x_e^K could overflow). */
export function darrHartwigActualQuality(xe: number, K: number): number {
  if (!(xe > 0) || !(K > 0)) return 0;
  if (xe <= 1) return xe * Math.exp(-Math.log1p(Math.pow(xe, K)) / K);
  return Math.exp(-Math.log1p(Math.exp(-K * Math.log(xe))) / K);
}

/** Bulk vapor temperature T_v = ((x_e − x_a)/x_a)·h_fg/c_p,v + T_sat
 *  [P1 Eq. 9; c_p,v at saturated vapor, local P — P1's explicit non-iterative
 *  choice]. T_v ≥ T_sat always (x_a ≤ x_e); T_v = T_sat for x_a = 0. */
export function darrHartwigVaporTemperature(
  xe: number,
  xa: number,
  hfg: number,
  cpvSat: number,
  Tsat: number,
): number {
  if (!(xa > 0)) return Tsat;
  return Tsat + ((xe - xa) / xa) * (hfg / cpvSat);
}

/** Vapor volume (void) fraction, slip ratio = 1  [P1 Eq. 5]:
 *  α = [1 + (ρ_v/ρ_l,sat)·((1−x_a)/x_a)]⁻¹,  ρ_v at (T_v, P). */
function darrHartwigVoidFraction(
  xa: number,
  rhoV: number,
  rhoLSat: number,
): number {
  if (!(xa > 0)) return 0;
  if (xa >= 1) return 1;
  return 1 / (1 + (rhoV / rhoLSat) * ((1 - xa) / xa));
}

// ---------------------------------------------------------------------------
// Regime-boundary temperatures (P1 Eqs. 18–19)
// ---------------------------------------------------------------------------

/** T_wet = 0.844·T_cr·(1 + 0.060·We_D^0.208)  [P1 Eq. 18, Table 1 — constants
 *  verified against the P1 PDF, 2026-08-06],
 *  We_D = G²D/(ρ_l,sat·γ)  [P1 nomenclature prints bare ρ in G²D/(ργ);
 *  resolved to saturated-liquid density, consistent with the earlier
 *  companion papers' We_l = G²D/(ρ_l·σ_l) usage].
 *  Guard (twetCrit clamp): γ or ρ_l non-positive (near-critical property
 *  collapse) or T_wet overshooting T_cr (Weber blow-up) — T_wet is capped at
 *  T_cr. The cap binds for We_D ≳ 223, i.e. G ≳ 48 kg/m²s at 2 bar / 1.02 cm
 *  — the high-G EDGE of the fit envelope, not only far outside it (raw
 *  Eq. 18 gives 34.21 K at G = 81, 2 bar). P1's "31–33 K depending on mass
 *  flux and local pressure" (p. 15) is consistent with the capped value, not
 *  the raw overshoot. */
export function darrHartwigWetTemperature(
  G: number,
  D: number,
  rhoLSat: number,
  sigma: number,
  Tcr: number,
): { Twet: number; clamped: boolean } {
  if (!(sigma > 0) || !(rhoLSat > 0)) return { Twet: Tcr, clamped: true };
  const WeD = (G * G * D) / (rhoLSat * sigma);
  const Twet = 0.844 * Tcr * (1 + 0.06 * Math.pow(WeD, 0.208));
  if (!(Twet <= Tcr)) return { Twet: Tcr, clamped: true }; // also catches NaN/Inf
  return { Twet, clamped: false };
}

/** T_DNB = T_sat(P) + 2 K  [P1 Eq. 19, Table 1 — LH2-specific]. */
export function darrHartwigDnbTemperature(Tsat: number): number {
  return Tsat + 2;
}

// ---------------------------------------------------------------------------
// Branch fluxes (P1 Table 1 / Eqs. 10–17)
// ---------------------------------------------------------------------------

/** Nu_IAF smoothstep ramp S(x_e): 1 for x_e ≤ 0.9 → 0 for x_e ≥ 1.0
 *  (implementer smoothing — replaces P1's hard `x_e > 1 ⇒ Nu_IAF = 0`
 *  switch, the main hard switch of the published regime logic). */
function darrHartwigIafRamp(xe: number): number {
  const t = (xe - DH_IAF_RAMP_XE_LO) / (DH_IAF_RAMP_XE_HI - DH_IAF_RAMP_XE_LO);
  const s = Math.min(1, Math.max(0, t));
  return 1 - s * s * (3 - 2 * s);
}

/** Smoothstep (cubic Hermite) weight: 0 for T_w ≤ T_b − hw, 1 for
 *  T_w ≥ T_b + hw, C1 between. */
export function darrHartwigBlendWeight(
  Tw: number,
  Tb: number,
  halfWidth: number,
): number {
  const t = (Tw - (Tb - halfWidth)) / (2 * halfWidth);
  const s = Math.min(1, Math.max(0, t));
  return s * s * (3 - 2 * s);
}

/** Liquid Dittus–Boelter h_DB = 0.023·Re_l^0.8·Pr_l^0.4·k_l/D  [P1 Eq. 14].
 *  Used inside NB (Eq. 13) and as the sub-T_sat implementer extension. */
export function darrHartwigLiquidDBH(
  G: number,
  D: number,
  sat: DHSatState,
): number {
  const ReL = Math.max((G * D) / sat.muf, DH_RE_L_FLOOR);
  const PrL = (sat.cpf * sat.muf) / sat.kf;
  return (0.023 * Math.pow(ReL, 0.8) * Math.pow(PrL, 0.4) * sat.kf) / D;
}

/** Nucleate boiling heat flux, q-FORM (avoids the Ja^(−0.254)
 *  h-singularity as ΔT → 0):
 *    q″_NB = 61.6·Re_l^(−0.332)·(c_p,l/h_fg)^(−0.254)·ΔT^0.746·h_DB
 *  Algebraically identical to h_NB·ΔT with h_NB = 61.6·Re_l^(−0.332)·
 *  Ja_l^(−0.254)·h_DB, Ja_l = c_p,l·ΔT/h_fg  [P1 Eqs. 13–16].
 *  ΔT = T_w − T_sat ≥ 0 (clamped at 0; the DB blend covers the seam). */
export function darrHartwigNucleateBoilingFlux(
  G: number,
  D: number,
  sat: DHSatState,
  dTSat: number,
): number {
  const ReL = Math.max((G * D) / sat.muf, DH_RE_L_FLOOR);
  const hDB = darrHartwigLiquidDBH(G, D, sat);
  const dT = Math.max(dTSat, 0);
  return (
    61.6 *
    Math.pow(ReL, -0.332) *
    Math.pow(sat.cpf / sat.hfg, -0.254) *
    Math.pow(dT, 0.746) *
    hDB
  );
}

/** Context frozen across T_w evaluations of the film-boiling flux. */
interface DHFilmCtx {
  G: number;
  D: number;
  L: number;
  xe: number;
  xa: number;
  Tv: number;
  rhoV: number; // vapor density at (T_v, P) [P1 Eq. 5]
  sat: DHSatState;
  vaporProps: (T: number) => DHVaporProps;
}

/** Film-boiling heat flux q″_FB = Nu_FB·k_v,sat·(T_w − T_v)/D  [P1 Eq. 11]
 *  with the p-norm Nu_FB = (Nu_IAF^0.75 + Nu_DF^0.75)^(4/3)  [P1 Eq. 10,
 *  Table 1 — super-additive combiner, p = 3/4 < 1 intended].
 *
 *  Nu_DF = 0.015·Re_tp^0.8774·Pr_v,f^0.6112, Re_tp = G·x_a·D/(μ_v,f·α)
 *  [P1 Table 1]; OFF for x_e ≤ 0 (P1 p. 13). Film temperature
 *  T_f = ½(T_w + T_v) [not defined in P1 — standard Rohsenow/Groeneveld
 *  DFFB usage adopted].
 *
 *  Nu_IAF = 0.06·(D/k_v,sat)·[ρ_v(ρ_l−ρ_v)·g·h_fg·k_v,sat³ /
 *           (L·μ_g·(T_w−T_sat))]^(1/4) + 0.015·(1−x_a)⁴·Re_v^0.8·Pr_v,sat^0.8
 *  [P1 Table 1 with the (D/k_v,sat) prefactor made explicit in P1 text
 *  Eq. (6)], multiplied by the smoothstep ramp S(x_e).
 *
 *  At x_a → 1 this reduces continuously to the SP-vapor limit
 *  Nu_SP = 0.015·(G·D/μ_v,f)^0.8774·Pr_v,f^0.6112  [P1 Eq. 12]. */
export function darrHartwigFilmBoilingFlux(ctx: DHFilmCtx, Tw: number): number {
  const { sat } = ctx;
  const Tf = 0.5 * (Tw + ctx.Tv);
  const vf = ctx.vaporProps(Tf);
  const PrVf = (vf.cp * vf.mu) / vf.k;

  // Dispersed-flow term (dominant at medium/high quality)
  let NuDF = 0;
  if (ctx.xe > 0 && ctx.xa > 0 && vf.mu > 0) {
    const alpha = darrHartwigVoidFraction(ctx.xa, ctx.rhoV, sat.rhof);
    if (alpha > 0) {
      const ReTp = (ctx.G * ctx.xa * ctx.D) / (vf.mu * alpha);
      NuDF = 0.015 * Math.pow(ReTp, 0.8774) * Math.pow(PrVf, 0.6112);
    }
  }

  // Inverted-annular / slug-flow term (dominant at low quality), ramped
  const S = darrHartwigIafRamp(ctx.xe);
  let NuIAF = 0;
  if (S > 0) {
    const dTSat = Math.max(Tw - sat.Tsat, DH_IAF_DT_FLOOR); // collapse guard
    const bracket =
      (sat.rhog *
        (sat.rhof - sat.rhog) *
        STANDARD_GRAVITY *
        sat.hfg *
        Math.pow(sat.kg, 3)) /
      (ctx.L * sat.mug * dTSat);
    const hBuoy = 0.06 * Math.pow(Math.max(bracket, 0), 0.25); // W/m²K (Bromley-type)
    const NuBuoy = (hBuoy * ctx.D) / sat.kg; // (D/k) prefactor: P1 text Eq. (6)
    const ReV = (ctx.G * ctx.D) / sat.mug; // saturated vapor (state not printed in P1)
    const PrVsat = (sat.cpg * sat.mug) / sat.kg;
    const NuSlug =
      0.015 *
      Math.pow(1 - ctx.xa, 4) *
      Math.pow(Math.max(ReV, 1e-12), 0.8) *
      Math.pow(PrVsat, 0.8);
    NuIAF = S * (NuBuoy + NuSlug);
  }

  const NuFB = Math.pow(
    Math.pow(NuIAF + DH_PNORM_EPS, 0.75) + Math.pow(NuDF + DH_PNORM_EPS, 0.75),
    4 / 3,
  );
  return (NuFB * sat.kg * (Tw - ctx.Tv)) / ctx.D;
}

// ---------------------------------------------------------------------------
// Full regime map
// ---------------------------------------------------------------------------

export type DHClampKind =
  "relin" | "twetCrit" | "tvapLimit" | "frontDistance" | "regimeCollapse";

export type DHRegime = "DB" | "NB" | "TB" | "FB" | "SP";

export interface DHEvaluateArgs {
  sat: DHSatState;
  /** Vapor PT lookup at local P (implementation clamps T into validity). */
  vaporProps: (T: number) => DHVaporProps;
  Tw: number; // K, local wall temperature (radially lumped)
  /** K, fluid-node bulk temperature (conductor reference). CONTRACT: this
   *  must be the physical bulk temperature at the node's own enthalpy
   *  (statePH(P, h).T) — the SP branch floors T_v at this value per
   *  P1 p. 13 (T_v = bulk gas temperature when x_a → 1; see header). */
  Tnode: number;
  G: number; // kg/m²·s, local mass flux
  xe: number; // equilibrium quality from node enthalpy, (h − h_f)/h_fg ∈ ℝ
  D: number; // m, tube inner diameter
  L: number; // m, axial distance from the quench front
  ReLin: number; // inlet liquid Reynolds (one global value per pipe, P1 Table 1)
  latched: boolean; // rewet hysteresis latch (frozen at step level; module header)
}

export interface DHResult {
  /** Heat flux wall → fluid [W/m²], signed (negative: fluid heats wall). */
  qFlux: number;
  /** Secant h_eff = q″/(T_w − T_node), guarded (see module header) [W/m²K]. */
  hEff: number;
  regime: DHRegime;
  Twet: number; // un-latched rewet temperature used this call
  TwetEff: number; // effective FB boundary (Twet + hysteresis when latched)
  TDnb: number; // (possibly collapse-shifted) NB/TB boundary
  xa: number;
  Tv: number;
  /** Equilibrium quality x_e = (h − h_f)/h_fg passed in args (echo, for
   *  diagnostic replay/gating — not used by the map itself beyond xa). */
  xe: number;
  /** χ_l = clamp(1 − x_e, 0, 1): the TT-WF liquid-availability function of
   *  the same node enthalpy (diagnostic echo). */
  chiL: number;
  clamps: DHClampKind[];
}

/** Evaluate the full Darr–Hartwig 2020 regime map at one node/state.
 *  Pure: no globals, no solver state. See module header for the contract. */
export function evaluateDarrHartwig(args: DHEvaluateArgs): DHResult {
  const { sat, vaporProps, Tw, Tnode, G, xe, D } = args;
  const clamps = new Set<DHClampKind>();

  // --- Validity guards (P1 fit envelope) ---
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

  // --- Boundary temperatures (P1 Eqs. 18–19) + hysteresis latch ---
  const wet = darrHartwigWetTemperature(G, D, sat.rhof, sat.sigma, sat.Tcr);
  if (wet.clamped) clamps.add("twetCrit");
  const Twet = wet.Twet;
  const TwetEff = Twet + (args.latched ? DH_HYSTERESIS : 0);
  let TDnb = darrHartwigDnbTemperature(sat.Tsat);
  if (TDnb > TwetEff - 2 * DH_BLEND_HALF_WIDTH) {
    // Near-critical regime-map collapse (far outside the fit envelope):
    // keep a minimal TB segment so all formulas stay finite.
    TDnb = TwetEff - 2 * DH_BLEND_HALF_WIDTH;
    clamps.add("regimeCollapse");
  }

  // --- Non-equilibrium closure (P1 Eqs. 7, 9) ---
  const K = darrHartwigK(ReLin);
  const xa = darrHartwigActualQuality(xe, K); // rides continuously (no 0.99→1 snap)
  let Tv = darrHartwigVaporTemperature(xe, xa, sat.hfg, sat.cpg, sat.Tsat);
  // P1 p. 13 SP-branch semantics, restored continuously (module header):
  // the vapor phase cannot be colder than the equilibrium bulk temperature
  // at the same enthalpy — Eq. 9 with frozen sat c_p,v violates that bound
  // by up to ~80 K at elevated pressure, and P1 itself switches T_v to the
  // node bulk gas temperature once x_a ≥ 0.99. Flooring T_v at Tnode is
  // that rule in continuous form (exact at x_a = 1, inactive in the fitted
  // 0.9–3.2 bar two-phase FB region where Eq. 9 > T_node anyway).
  if (Tv < Tnode) Tv = Tnode;
  if (Tv > sat.TvapMax) {
    Tv = sat.TvapMax;
    clamps.add("tvapLimit");
  }
  const rhoV = xa > 0 ? vaporProps(Tv).rho : sat.rhog;

  const fbCtx: DHFilmCtx = { G, D, L, xe, xa, Tv, rhoV, sat, vaporProps };

  // --- Branch fluxes as closures of T_w (anchors cached lazily) ---
  const qFB = (tw: number) => darrHartwigFilmBoilingFlux(fbCtx, tw);
  const qNB = (tw: number) =>
    darrHartwigNucleateBoilingFlux(G, D, sat, tw - sat.Tsat);
  const hDB = darrHartwigLiquidDBH(G, D, sat);
  const qDB = (tw: number) => hDB * (tw - Tnode); // sub-T_sat implementer extension

  let qFBatWetCache: number | undefined;
  const qFBatWet = () => (qFBatWetCache ??= qFB(TwetEff));
  let qNBatDNBCache: number | undefined;
  const qNBatDNB = () => (qNBatDNBCache ??= qNB(TDnb));
  // Linear transition bridge [P1 Eq. 17] — C0 at both anchors by construction
  const qTB = (tw: number) =>
    ((qNBatDNB() - qFBatWet()) * (tw - TwetEff)) / (TDnb - TwetEff) +
    qFBatWet();

  // --- Blended global q″(T_w): C1 at T_wet,eff and T_DNB, C1 DB seam at
  //     T_sat (smoothstep blends; module header) ---
  const q = (tw: number): number => {
    const sWet = darrHartwigBlendWeight(tw, TwetEff, DH_BLEND_HALF_WIDTH);
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

  const qFlux = q(Tw);

  // --- Secant h_eff with the T_w → T_node guard (module header) ---
  const dTn = Tw - Tnode;
  let hEff: number;
  if (Math.abs(dTn) >= DH_DT_NODE_GUARD) {
    hEff = qFlux / dTn;
  } else {
    const sgn = dTn >= 0 ? 1 : -1;
    hEff = q(Tnode + sgn * DH_DT_NODE_GUARD) / (sgn * DH_DT_NODE_GUARD);
  }

  // --- Regime label (un-blended position; blends only smooth the seams) ---
  const regime: DHRegime =
    Tw > TwetEff
      ? xa >= 0.99
        ? "SP"
        : "FB"
      : Tw > TDnb
        ? "TB"
        : Tw > sat.Tsat
          ? "NB"
          : "DB";

  return {
    qFlux,
    hEff,
    regime,
    Twet,
    TwetEff,
    TDnb,
    xa,
    Tv,
    xe,
    chiL: Math.min(1, Math.max(0, 1 - xe)),
    clamps: [...clamps],
  };
}
