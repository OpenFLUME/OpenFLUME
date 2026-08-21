/**
 * Darr–Hartwig 2020 LH2 flow-boiling correlation set — validation tests.
 *
 * Every constant and formula is traceable to the primary source: Darr &
 * Hartwig, NTRS 20190029114 (preprint of Cryogenics 105:102999, 2020) —
 * cited as "P1".  The hand-calcs below RE-DERIVE the formulas from P1
 * independently of src/core/darrHartwig.ts (algebraic formulas ⇒ exact
 * agreement expected, 1e-10 relative), and physical anchors from the paper
 * are asserted (q″_NB(ΔT=2 K) ∈ [5,10] kW/m² — P1's own sanity check;
 * T_wet ∈ [31,33] K — P1 p. 15).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { NetworkConfig } from "../schema";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import {
  evaluateDarrHartwig,
  darrHartwigK,
  darrHartwigActualQuality,
  darrHartwigVaporTemperature,
  darrHartwigWetTemperature,
  darrHartwigDnbTemperature,
  DH_HYSTERESIS,
  DH_L_FRONT_MIN,
  DH_RE_LIN_MIN,
  type DHSatState,
  type DHVaporProps,
} from "../darrHartwig";
import {
  evaluateConvectionH,
  darrHartwigHeatFlux,
  updateDarrHartwigLatches,
  FALLBACK_H_FLOOR,
  type CorrelationConductor,
  type CorrelationCtx,
  type CorrelationState,
} from "../correlations";
import { getSolverDiagnostics, resetSolverDiagnostics } from "../diagnostics";
import { getFluidLimits } from "../fluids/realFluid";
import { solveSteady, solveTransient } from "..";

let fluid: RealFluid;
let sat: Sat;
let vap: (T: number) => DHVaporProps;
let RE_LIN: number;
beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
  fluid = new RealFluid("ParaHydrogen"); // LH2 set: parahydrogen properties
  sat = makeSat(P);
  vap = makeVap(P, sat);
  RE_LIN = (G * D) / sat.muf; // local-G estimate = production fallback
}, 30000);

/* =============================================================================
 * Test fixture state: P = 2 bar LH2, G = 38 kg/m²s, D = 1.02 cm — the middle
 * of the GRC fit envelope (P1: G_avg = 21/38/81 kg/m²s, ID 1.02 cm).
 * ============================================================================= */
const P = 2e5;
const D = 0.0102;
const G = 38;
const L_FRONT = 0.5;

type Sat = DHSatState;
function makeSat(Pp: number): Sat {
  const s = fluid.saturationProperties(Pp);
  return {
    Tsat: s.Tsat,
    hf: s.hf,
    hfg: s.hg - s.hf,
    rhof: s.rhof,
    rhog: s.rhog,
    muf: s.muf,
    mug: s.mug,
    cpf: s.cpf,
    cpg: s.cpg,
    kf: s.kf,
    kg: s.kg,
    sigma: fluid.surfaceTension(Pp),
    Tcr: fluid.criticalTemperature(),
    TvapMax: 0.95 * getFluidLimits(fluid.fluidName).Tmax,
  };
}

/** Vapor PT lookup, clamped exactly as the production wrapper does. */
function makeVap(Pp: number, sat: DHSatState): (T: number) => DHVaporProps {
  const T_LO = sat.Tsat + 0.25;
  const T_HI = Math.max(sat.TvapMax, T_LO);
  return (T) => fluid.transportPropsPT(Pp, Math.min(Math.max(T, T_LO), T_HI));
}

function evalDH(
  Tw: number,
  xe: number,
  over?: Partial<Parameters<typeof evaluateDarrHartwig>[0]>,
) {
  return evaluateDarrHartwig({
    sat,
    vaporProps: vap,
    Tw,
    Tnode: sat.Tsat, // two-phase node
    G,
    xe,
    D,
    L: L_FRONT,
    ReLin: RE_LIN,
    latched: false,
    ...over,
  });
}

/* =============================================================================
 * Independent in-test re-implementations (spec formulas re-typed; do NOT
 * import the implementation's algebra).
 * ============================================================================= */
const GRAV = 9.80665;
function smoothstep(t: number): number {
  const s = Math.min(1, Math.max(0, t));
  return s * s * (3 - 2 * s);
}

/** P1 Eq. 7, Table 1 — naive (textbook) evaluation. */
function handXa(xe: number, K: number): number {
  if (xe <= 0) return 0;
  return Math.pow(Math.pow(xe, -K) + 1, -1 / K);
}

/** P1 Eq. 9. */
function handTv(xe: number, xa: number, s: Sat): number {
  return ((xe - xa) / xa) * (s.hfg / s.cpg) + s.Tsat;
}

/** P1 Eq. 18. */
function handTwet(Gg: number, Dd: number, s: Sat): number {
  const WeD = (Gg * Gg * Dd) / (s.rhof * s.sigma);
  return 0.844 * s.Tcr * (1 + 0.06 * Math.pow(WeD, 0.208));
}

/** P1 Table 1 + text Eq. (6) prefactor, with the implementation's IAF ramp
 *  and p-norm epsilon. */
function handFB(
  Tw: number,
  Gg: number,
  Dd: number,
  L: number,
  xe: number,
  xa: number,
  Tv: number,
  s: Sat,
): number {
  const Tf = 0.5 * (Tw + Tv); // film temperature (Rohsenow/Groeneveld usage)
  const vf = vap(Tf);
  const PrVf = (vf.cp * vf.mu) / vf.k;
  let NuDF = 0;
  if (xe > 0 && xa > 0) {
    const rhoV = vap(Tv).rho; // ρ_v at (T_v, P) [P1 Eq. 5]
    const alpha = 1 / (1 + (rhoV / s.rhof) * ((1 - xa) / xa));
    const ReTp = (Gg * xa * Dd) / (vf.mu * alpha);
    NuDF = 0.015 * Math.pow(ReTp, 0.8774) * Math.pow(PrVf, 0.6112);
  }
  const S = xe <= 0.9 ? 1 : xe >= 1 ? 0 : 1 - smoothstep((xe - 0.9) / 0.1);
  let NuIAF = 0;
  if (S > 0) {
    const dTsat = Math.max(Tw - s.Tsat, 0.1);
    const bracket =
      (s.rhog * (s.rhof - s.rhog) * GRAV * s.hfg * Math.pow(s.kg, 3)) /
      (L * s.mug * dTsat);
    const hBuoy = 0.06 * Math.pow(Math.max(bracket, 0), 0.25);
    const NuBuoy = (hBuoy * Dd) / s.kg; // (D/k_v) prefactor — P1 text Eq. (6)
    const ReV = (Gg * Dd) / s.mug;
    const PrVsat = (s.cpg * s.mug) / s.kg;
    const NuSlug =
      0.015 * Math.pow(1 - xa, 4) * Math.pow(ReV, 0.8) * Math.pow(PrVsat, 0.8);
    NuIAF = S * (NuBuoy + NuSlug);
  }
  const NuFB = Math.pow(
    Math.pow(NuIAF + 1e-30, 0.75) + Math.pow(NuDF + 1e-30, 0.75),
    4 / 3,
  );
  return (NuFB * s.kg * (Tw - Tv)) / Dd;
}

/** P1 Eqs. 13–16 — h-form with Ja (textbook); the implementation uses the
 *  algebraically identical q-form. */
function handNB(dT: number, Gg: number, Dd: number, s: Sat): number {
  const ReL = (Gg * Dd) / s.muf;
  const PrL = (s.cpf * s.muf) / s.kf;
  const hDB = (0.023 * Math.pow(ReL, 0.8) * Math.pow(PrL, 0.4) * s.kf) / Dd;
  const Ja = (s.cpf * dT) / s.hfg;
  const hNB = 61.6 * Math.pow(ReL, -0.332) * Math.pow(Ja, -0.254) * hDB;
  return hNB * dT;
}

/** P1 Eq. 17 — linear bridge between hand anchors. */
function handTB(
  Tw: number,
  Twet: number,
  TDnb: number,
  qNBatDNB: number,
  qFBatWet: number,
): number {
  return ((qNBatDNB - qFBatWet) * (Tw - Twet)) / (TDnb - Twet) + qFBatWet;
}

const rel = (a: number, b: number) =>
  Math.abs(a - b) / Math.max(Math.abs(b), 1e-30);

/* =============================================================================
 * 1. Non-equilibrium closure: K, x_a, T_v (P1 Eqs. 7, 9)
 * ============================================================================= */
describe("x_a closure and bulk vapor temperature (hand-calc)", () => {
  it("K = 5.26e-5·Re_l,in + 0.11 (0.11 per P1 Table 1)", () => {
    expect(darrHartwigK(0)).toBe(0.11);
    expect(darrHartwigK(1e5)).toBeCloseTo(5.26 + 0.11, 12);
    expect(darrHartwigK(247000)).toBeCloseTo(5.26e-5 * 247000 + 0.11, 12);
  });

  it("x_a matches the naive formula and stays below x_e", () => {
    const cases: Array<[number, number]> = [
      [0.05, 1.956],
      [0.5, 2.5],
      [1.0, 5.37],
      [2.0, 5.37],
      [1e-3, 5.0],
      [50.0, 13.1],
    ];
    for (const [xe, K] of cases) {
      const xa = darrHartwigActualQuality(xe, K);
      expect(rel(xa, handXa(xe, K))).toBeLessThan(1e-12);
      expect(xa).toBeLessThan(xe);
      expect(xa).toBeGreaterThan(0);
    }
    // Limits: x_a → 0 as x_e → 0⁺; x_a → 1 as x_e → ∞
    expect(darrHartwigActualQuality(1e-12, 5)).toBeLessThan(1e-9);
    expect(darrHartwigActualQuality(1e6, 5)).toBeGreaterThan(0.999);
    // Subcooled: exactly 0 (DF term off, P1 p. 13)
    expect(darrHartwigActualQuality(0, 5)).toBe(0);
    expect(darrHartwigActualQuality(-0.3, 5)).toBe(0);
  });

  it("T_v matches Eq. 9 hand-calc at 3 states", () => {
    for (const xe of [0.3, 0.8, 3.0]) {
      const K = darrHartwigK(RE_LIN);
      const xa = handXa(xe, K);
      const TvExpected = handTv(xe, xa, sat);
      const TvActual = darrHartwigVaporTemperature(
        xe,
        xa,
        sat.hfg,
        sat.cpg,
        sat.Tsat,
      );
      expect(rel(TvActual, TvExpected)).toBeLessThan(1e-12);
      expect(TvActual).toBeGreaterThanOrEqual(sat.Tsat); // T_v ≥ T_sat always
    }
    // xa = 0 (subcooled): T_v = T_sat
    expect(
      darrHartwigVaporTemperature(-0.1, 0, sat.hfg, sat.cpg, sat.Tsat),
    ).toBe(sat.Tsat);
  });
});

/* =============================================================================
 * 2. Rewet / DNB temperatures (P1 Eqs. 18–19)
 * ============================================================================= */
describe("T_wet and T_DNB", () => {
  it("T_wet matches Eq. 18 hand-calc and lands in the spec range 31–33 K", () => {
    // G = 21/38 kg/m²s (the low/mid fit-envelope mass fluxes per P1):
    // raw Eq. 18 lands in P1's 31–33 K band with no clamp.  Hand values at
    // the test conditions (P = 2 bar, D = 1.02 cm, parahydrogen):
    //   G = 21 → We_D = 43.6  → T_wet = 31.457 K
    //   G = 38 → We_D = 142.8 → T_wet = 32.481 K
    for (const Gg of [21, 38]) {
      const { Twet, clamped } = darrHartwigWetTemperature(
        Gg,
        D,
        sat.rhof,
        sat.sigma,
        sat.Tcr,
      );
      expect(clamped).toBe(false);
      expect(rel(Twet, handTwet(Gg, D, sat))).toBeLessThan(1e-12);
      expect(Twet).toBeGreaterThan(31);
      expect(Twet).toBeLessThan(33);
    }
  });

  it("T_wet at G = 81: raw Eq. 18 overshoots T_cr, so the twetCrit cap binds (in-envelope edge)", () => {
    // Hand-calc at the test conditions: We_D = 648.8 → raw T_wet = 34.213 K
    // > T_cr = 32.938 K.  Raw Eq. 18 crosses T_cr at We_D ≈ 223 ⟺
    // G* ≈ 47.5 kg/m²s at 2 bar — INSIDE the fit envelope (G ≤ 81), and the
    // overshoot persists at every P1 test pressure (raw T_wet(81) =
    // 33.80–34.61 K over 0.9–3.2 bar): P1's "gives reasonable values of 31 K
    // to 33 K for hydrogen depending on the mass flux and the local pressure"
    // (p. 15) does not hold at the high-G end with real LH2 properties.
    // A rewet temperature above T_cr is physically meaningless for a boiling
    // regime map, so the documented T_cr cap (twetCrit) is the intended
    // behavior here — not a clamp malfunction.  See
    // (see the Darr–Hartwig test-resolution notes in this file).
    const raw = handTwet(81, D, sat);
    expect(raw).toBeGreaterThan(sat.Tcr);
    const { Twet, clamped } = darrHartwigWetTemperature(
      81,
      D,
      sat.rhof,
      sat.sigma,
      sat.Tcr,
    );
    expect(clamped).toBe(true);
    expect(Twet).toBe(sat.Tcr);
    // …and the capped value still lands in P1's stated band.
    expect(Twet).toBeGreaterThan(31);
    expect(Twet).toBeLessThan(33);
  });

  it("T_DNB = T_sat + 2 K (LH2-specific)", () => {
    expect(darrHartwigDnbTemperature(sat.Tsat)).toBe(sat.Tsat + 2);
    const r = evalDH(100, 0.3);
    expect(r.TDnb).toBe(sat.Tsat + 2);
  });
});

/* =============================================================================
 * 3. Per-regime hand-calc validation (task test 1) — 1e-10 relative
 * ============================================================================= */
describe("Film boiling hand-calc (P1 Eqs. 10–11)", () => {
  const TW_FB = 100; // deep FB (T_wet ≈ 32.5 K)
  it.each([
    { xe: 0.05, note: "IAF-dominant (low quality)" },
    { xe: 0.3, note: "mixed" },
    { xe: 0.8, note: "DF-dominant (medium-high quality)" },
  ])("xe=$xe ($note)", ({ xe }) => {
    const r = evalDH(TW_FB, xe);
    expect(r.regime).toBe("FB");
    const K = 5.26e-5 * RE_LIN + 0.11;
    const xa = handXa(xe, K);
    const Tv = handTv(xe, xa, sat);
    const qExpected = handFB(TW_FB, G, D, L_FRONT, xe, xa, Tv, sat);
    expect(rel(r.qFlux, qExpected)).toBeLessThan(1e-10);
    expect(r.xa).toBeCloseTo(xa, 12);
    // h_eff is the exact secant through the node temperature (T_node = T_sat)
    expect(rel(r.hEff, qExpected / (TW_FB - sat.Tsat))).toBeLessThan(1e-10);
  });

  it("subcooled node (xe < 0): Nu_DF ≡ 0, IAF-only FB", () => {
    const r = evalDH(TW_FB, -0.05);
    const qExpected = handFB(TW_FB, G, D, L_FRONT, -0.05, 0, sat.Tsat, sat);
    expect(rel(r.qFlux, qExpected)).toBeLessThan(1e-10);
    expect(r.xa).toBe(0);
    expect(r.Tv).toBe(sat.Tsat);
  });

  it("superheated node (xe = 1.5): IAF ramp fully off (P1 hard-cut state, S = 0)", () => {
    const xe = 1.5;
    const hNode = sat.hf + xe * sat.hfg;
    const Tnode = fluid.temperatureFromEnthalpy(P, hNode);
    const r = evalDH(TW_FB, xe, { Tnode });
    const K = 5.26e-5 * RE_LIN + 0.11;
    const xa = handXa(xe, K);
    const Tv = handTv(xe, xa, sat);
    const qExpected = handFB(TW_FB, G, D, L_FRONT, xe, xa, Tv, sat);
    expect(rel(r.qFlux, qExpected)).toBeLessThan(1e-10);
    expect(rel(r.hEff, qExpected / (TW_FB - Tnode))).toBeLessThan(1e-10);
  });

  it("FB physical sanity: q″ grows with T_w and with quality", () => {
    const rLow = evalDH(60, 0.3);
    const rHigh = evalDH(295, 0.3);
    expect(rHigh.qFlux).toBeGreaterThan(rLow.qFlux);
    // DFFB-scale h for H2 at G = 38: hundreds of W/m²K (literature band)
    expect(rHigh.hEff).toBeGreaterThan(100);
    expect(rHigh.hEff).toBeLessThan(2000);
  });
});

describe("Nucleate boiling hand-calc (P1 Eqs. 13–16)", () => {
  it.each([1.0, 1.4])("ΔT = %f K (pure NB, outside both blend bands)", (dT) => {
    const r = evalDH(sat.Tsat + dT, 0.3);
    expect(r.regime).toBe("NB");
    const qExpected = handNB(dT, G, D, sat);
    expect(rel(r.qFlux, qExpected)).toBeLessThan(1e-10);
    // h_eff = q″/ΔT exactly (T_node = T_sat)
    expect(rel(r.hEff, qExpected / dT)).toBeLessThan(1e-10);
  });

  it("P1 sanity anchor: q″_NB(ΔT = 2 K) ∈ [5, 10] kW/m² (Shirai et al. cross-check)", () => {
    const q = handNB(2, G, D, sat);
    expect(q).toBeGreaterThan(5e3);
    expect(q).toBeLessThan(10e3);
  });

  it("anchor exactness: q″(T_DNB) equals q″_NB(ΔT = 2 K) through the blend", () => {
    const r = evalDH(sat.Tsat + 2, 0.3); // blend center: qTB anchor == qNB anchor
    const qExpected = handNB(2, G, D, sat);
    expect(rel(r.qFlux, qExpected)).toBeLessThan(1e-10);
  });
});

describe("Transition bridge hand-calc (P1 Eq. 17)", () => {
  it("mid-bridge flux matches the linear interpolation of hand anchors", () => {
    const rProbe = evalDH(100, 0.3);
    const Twet = rProbe.Twet;
    const TDnb = rProbe.TDnb;
    const Tw = 0.5 * (TDnb + Twet); // 28.64 K — clear of both blend bands
    const K = 5.26e-5 * RE_LIN + 0.11;
    const xa = handXa(0.3, K);
    const Tv = handTv(0.3, xa, sat);
    const qFBatWet = handFB(Twet, G, D, L_FRONT, 0.3, xa, Tv, sat);
    const qNBatDNB = handNB(2, G, D, sat);
    const qExpected = handTB(Tw, Twet, TDnb, qNBatDNB, qFBatWet);

    const r = evalDH(Tw, 0.3);
    expect(r.regime).toBe("TB");
    expect(rel(r.qFlux, qExpected)).toBeLessThan(1e-10);
  });

  it("anchor exactness: q″(T_wet) equals the FB flux evaluated at T_wet", () => {
    const rProbe = evalDH(100, 0.3);
    const K = 5.26e-5 * RE_LIN + 0.11;
    const xa = handXa(0.3, K);
    const Tv = handTv(0.3, xa, sat);
    const qFBatWet = handFB(rProbe.Twet, G, D, L_FRONT, 0.3, xa, Tv, sat);
    const r = evalDH(rProbe.Twet, 0.3); // blend center: qTB(Twet) == qFB(Twet)
    expect(rel(r.qFlux, qFBatWet)).toBeLessThan(1e-10);
  });
});

describe("Single-phase vapor limit (P1 Eq. 12, continuous x_a)", () => {
  it("xe = 20: regime SP, xa ≥ 0.99, and q″ approaches the printed Eq. 12", () => {
    const xe = 20;
    const hNode = sat.hf + xe * sat.hfg;
    const Tnode = fluid.temperatureFromEnthalpy(P, hNode);
    const Tw = 700; // above T_v ≈ 632 K at this quality
    const r = evalDH(Tw, xe, { Tnode });
    expect(r.regime).toBe("SP");
    expect(r.xa).toBeGreaterThanOrEqual(0.99);
    expect(r.qFlux).toBeGreaterThan(0);
    // Printed SP limit (α = 1 exactly, no IAF): Nu = 0.015·(G·D/μ_v,f)^0.8774·Pr_v,f^0.6112
    const vf = vap(0.5 * (Tw + r.Tv));
    const NuSP =
      0.015 *
      Math.pow((G * D) / vf.mu, 0.8774) *
      Math.pow((vf.cp * vf.mu) / vf.k, 0.6112);
    const qSP = (NuSP * sat.kg * (Tw - r.Tv)) / D;
    // Deviation budget (the 0.99→1 snap of P1 p. 13 is intentionally
    // removed): x_a rides at 0.998545 < 1 here, so Re_tp = G·x_a·D/(μ_v,f·α)
    // < G·D/μ_v,f and q″ sits BELOW the printed Eq. 12 by
    //   ≈ 1 − (x_a/α)^0.8774 ≈ 0.8774·(1 − x_a) = 1.277e-3   (α = 0.9999984;
    // the IAF ramp is irrelevant — S(x_e = 20) = 0 long since).  This is the
    // documented continuous-riding deviation, not a ramp mis-implementation:
    // assert it is fully explained by the x_a-riding (50 % margin over the
    // leading-order estimate covers α and higher-order terms)…
    const xaRideBound = 1 - Math.pow(r.xa, 0.8774);
    expect(rel(r.qFlux, qSP)).toBeLessThan(1.5 * xaRideBound);
    // …and pin the implementation EXACTLY against the x_a/α-corrected SP
    // form (handFB at x_e = 20 has S = 0, i.e. it IS the corrected form).
    const qCorr = handFB(Tw, G, D, L_FRONT, xe, r.xa, r.Tv, sat);
    expect(rel(r.qFlux, qCorr)).toBeLessThan(1e-10);
  });
});

/* =============================================================================
 * 3b. SP-branch T_v semantics (P1 p. 13) — regression for the 2026-08-07
 * audit fix.  Eq. 9 with frozen sat c_p,v
 * UNDER-reads the bulk vapor temperature by up to ~80 K at NBS pressures
 * (c_p,v,sat 13.4→19.5→29.4 kJ/kgK over 2→5.2→11.2 bar); P1's SP branch
 * sets x_a = 1 and drives on the node bulk gas temperature instead.  The
 * implementation floors T_v at the node bulk temperature (continuous form
 * of P1's switch — thermodynamically T_v ≥ T_bulk must hold at fixed
 * enthalpy for x_a ≤ 1).  Every test below FAILS on the pre-fix code.
 * Fixture: the NBS LH2 74.97 psia point (P = 5.169 bar, D = 1.5875 cm).
 * ============================================================================= */
describe("SP-branch T_v floor at node bulk temperature (P1 p. 13)", () => {
  const P2 = 5.169e5;
  const D2 = 0.015875;
  const G2 = 75; // kg/m²s — the stall-phase mass flux of the recorded run
  let sat2: Sat;
  let vap2: (T: number) => DHVaporProps;
  beforeAll(() => {
    sat2 = makeSat(P2);
    vap2 = makeVap(P2, sat2);
  });
  function evalDH2(Tw: number, xe: number, Tnode: number) {
    return evaluateDarrHartwig({
      sat: sat2,
      vaporProps: vap2,
      Tw,
      Tnode,
      G: G2,
      xe,
      D: D2,
      L: 0.5,
      ReLin: (G2 * D2) / sat2.muf,
      latched: false,
    });
  }
  const xeWarm = 8; // deep-SP warm fill gas, the dominant downstream state
  const bulkAt = (xe: number) => fluid.statePH(P2, sat2.hf + xe * sat2.hfg).T;

  it("T_v never under-reads the node bulk temperature (the floor invariant)", () => {
    for (const xe of [2, 4, xeWarm]) {
      const Tbulk = bulkAt(xe);
      const r = evalDH2(300, xe, Tbulk);
      // pre-fix: Eq. 9 gave 46.1 / 83.6 / 158.6 K against bulk 56.9 / 115.0 /
      // 206.2 K — under-reading by up to 47.6 K at this pressure.
      expect(r.Tv).toBeGreaterThanOrEqual(Tbulk - 1e-9);
    }
  });

  it("heat-flow direction is physical for gas warmer/cooler than the wall", () => {
    const Tbulk = bulkAt(xeWarm); // ≈ 206 K; pre-fix T_v(Eq. 9) ≈ 158.6 K
    const Tw = 180; // between the two: pre-fix sign is wrong here
    const r = evalDH2(Tw, xeWarm, Tbulk);
    // Gas at 206 K over a 180 K wall must HEAT the wall: q″(wall→fluid) < 0.
    expect(r.qFlux).toBeLessThan(0);
    // …and the secant seen by the conductor must stay POSITIVE
    // (Q = h_eff·A·(T_w − T_node), both factors negative ⇒ heat into wall).
    expect(r.hEff).toBeGreaterThan(0);
  });

  it("wall and gas at the same temperature exchange ~zero heat, with a physical h", () => {
    // (Tnode = 300 K = wall: the warm-stagnant-fill state of the recorded run)
    const r = evalDH2(300, xeWarm, 300);
    expect(Math.abs(r.qFlux)).toBeLessThan(1000); // pre-fix: ~108 kW/m²
    // secant must be the plain vapor h = Nu·k/D, not the 1e5–1e6 guard blow-up
    expect(r.hEff).toBeGreaterThan(0);
    expect(r.hEff).toBeLessThan(20000); // pre-fix: ~1.2e6 W/m²K via the 0.1 K guard
  });

  it("warm 300 K wall over two-phase LH2 at 74.97 psia selects film boiling", () => {
    const r = evalDH2(300, 0.3, sat2.Tsat);
    expect(r.regime).toBe("FB");
    expect(r.qFlux).toBeGreaterThan(0);
  });

  it("T_v floor is inactive inside the fitted FB region (2 bar, low x_e)", () => {
    // At the P1 fit conditions Eq. 9 exceeds the (two-phase) bulk temperature
    // and must remain authoritative — the floor must not flatten physical
    // non-equilibrium there.  With Tnode = T_sat the floor can never bind
    // (T_v ≥ T_sat always), so T_v must equal the hand-computed Eq. 9 exactly.
    const r = evalDH(250, 0.5); // module fixture: 2 bar, Tnode = T_sat
    expect(r.Tv).toBe(handTv(0.5, r.xa, sat));
    expect(r.Tv).toBeGreaterThan(sat.Tsat + 3); // real non-equilibrium, unfloored
  });
});

/* =============================================================================
 * 3c. P1 Figure-5 canonical anchor (primary-source sample curve).
 * Figure 5 (p. 12, page image read 2026-08-07): q-DF / q-IAF / q-combined vs
 * equilibrium quality at G = 20 kg/m²s, P = 200 kPa, T_w = 250 K (D = 1.02 cm
 * test section).  Chart-read anchors with generous bands (chart tolerance),
 * tight enough to catch sign errors or order-of-magnitude drift:
 *   q-IAF > 100 kW/m² as x_e → 0, ≈ 33 at x_e ≈ 0.5, → 0 by x_e ≈ 1;
 *   q-DF peaks ≈ 33 kW/m² near x_e ≈ 1.5–2 and decays to ≈ 11 at x_e = 6,
 *   positive throughout (this is the published evidence that the film-boiling
 *   driving force (T_w − T_v) stays positive across the figure's x_e range).
 * ============================================================================= */
describe("P1 Figure-5 canonical curve (G=20, P=200 kPa, T_w=250 K)", () => {
  const G5 = 20;
  const evalFig5 = (xe: number) =>
    evaluateDarrHartwig({
      sat, // module fixture is exactly P = 200 kPa para-H2 (built in beforeAll)
      vaporProps: vap,
      Tw: 250,
      Tnode: sat.Tsat, // figure is a correlation breakdown, not a node state
      G: G5,
      xe,
      D,
      L: 0.5,
      ReLin: (G5 * D) / sat.muf,
      latched: false,
    });

  it("low-quality IAF-dominated magnitude and decay", () => {
    expect(evalFig5(0.02).qFlux / 1000).toBeGreaterThan(50); // figure: > 100 near 0
    expect(evalFig5(0.02).qFlux / 1000).toBeLessThan(160);
    expect(evalFig5(0.1).qFlux / 1000).toBeGreaterThan(45);
    expect(evalFig5(0.1).qFlux / 1000).toBeLessThan(120);
    expect(evalFig5(0.5).qFlux / 1000).toBeGreaterThan(25);
    expect(evalFig5(0.5).qFlux / 1000).toBeLessThan(70);
  });

  it("dispersed-flow peak and positive tail (the T_v driving-force check)", () => {
    const q2 = evalFig5(2).qFlux / 1000; // peak region ≈ 33
    expect(q2).toBeGreaterThan(20);
    expect(q2).toBeLessThan(40);
    const q6 = evalFig5(6).qFlux / 1000; // ≈ 11, positive
    expect(q6).toBeGreaterThan(4);
    expect(q6).toBeLessThan(20);
    // positivity of q″ out to x_e = 6 ⟺ T_v < T_w across the figure's range
    for (const xe of [0.5, 1, 2, 3, 4, 5, 6]) {
      expect(evalFig5(xe).qFlux).toBeGreaterThan(0);
    }
  });
});

/* =============================================================================
 * 4. Regime logic + rewet hysteresis latch (task test 2)
 * ============================================================================= */
describe("Regime selection across a T_w sweep (P1 p. 16 logic)", () => {
  it("DB → NB → TB → FB as T_w rises at fixed state", () => {
    const rProbe = evalDH(100, 0.3);
    expect(evalDH(sat.Tsat - 1, 0.3).regime).toBe("DB");
    expect(evalDH(sat.Tsat + 1, 0.3).regime).toBe("NB");
    expect(evalDH(sat.Tsat + 2.5, 0.3).regime).toBe("TB"); // above TDnb
    expect(evalDH(0.5 * (rProbe.TDnb + rProbe.Twet), 0.3).regime).toBe("TB");
    expect(evalDH(rProbe.Twet + 1, 0.3).regime).toBe("FB");
    expect(evalDH(295, 0.3).regime).toBe("FB");
  });

  it("latched: the FB boundary shifts by exactly DH_HYSTERESIS (2 K)", () => {
    const rProbe = evalDH(100, 0.3);
    const Twet = rProbe.Twet;
    // Just above T_wet: unlatched → FB; latched → still TB (anti-flap)
    expect(evalDH(Twet + 1.0, 0.3, { latched: false }).regime).toBe("FB");
    const rLatched = evalDH(Twet + 1.0, 0.3, { latched: true });
    expect(rLatched.regime).toBe("TB");
    expect(rLatched.TwetEff).toBe(Twet + DH_HYSTERESIS);
    // Above T_wet + 2 K: FB again
    expect(
      evalDH(Twet + DH_HYSTERESIS + 1.0, 0.3, { latched: true }).regime,
    ).toBe("FB");
  });

  it("latch state machine via updateDarrHartwigLatches (step-level)", () => {
    const Afl = (Math.PI / 4) * D * D;
    const mdot = G * Afl;
    const shared = {
      latch: new Map<string, { rewetLatched: boolean }>(),
      axialPosition: new Map([["c1", 0.5]]),
    };
    const ctx: CorrelationCtx = {
      fluid,
      isRealFluid: true,
      branches: [
        { id: "b0", from: "in", to: "f1" },
        { id: "b1", from: "f1", to: "out" },
      ],
      nBranch: 2,
      nodeMap: new Map([
        ["in", { id: "in", type: "boundary" }],
        ["f1", { id: "f1", type: "internal" }],
        ["out", { id: "out", type: "boundary" }],
      ]),
      darrHartwig: shared,
    };
    const cond: CorrelationConductor = {
      id: "c1",
      from: "f1",
      to: "w1",
      type: {
        kind: "convection",
        area: Math.PI * D * 0.5,
        correlation: {
          model: "darrHartwig",
          diameter: D,
          flowArea: Afl,
          axialPosition: 0.5,
        },
      },
    };
    const makeState = (Tw: number): CorrelationState => ({
      nodeP: new Map([["f1", P]]),
      nodeT: new Map([["f1", sat.Tsat]]),
      nodeH: new Map([["f1", sat.hf + 0.3 * sat.hfg]]),
      mdots: [mdot, mdot],
      solidT: new Map([["w1", Tw]]),
    });
    const { Twet } = darrHartwigWetTemperature(
      G,
      D,
      sat.rhof,
      sat.sigma,
      sat.Tcr,
    );

    // Hot wall: not latched (memoryless init)
    updateDarrHartwigLatches(ctx, [cond], makeState(100));
    expect(shared.latch.get("c1")!.rewetLatched).toBe(false);
    // Cooling path crosses T_wet: latched (rewet)
    updateDarrHartwigLatches(ctx, [cond], makeState(Twet - 0.5));
    expect(shared.latch.get("c1")!.rewetLatched).toBe(true);
    // Small rebound within the 2 K band: STAYS latched (no FB re-entry)
    updateDarrHartwigLatches(ctx, [cond], makeState(Twet + 1.5));
    expect(shared.latch.get("c1")!.rewetLatched).toBe(true);
    // Reheat beyond T_wet + 2 K: unlatches
    updateDarrHartwigLatches(
      ctx,
      [cond],
      makeState(Twet + DH_HYSTERESIS + 0.5),
    );
    expect(shared.latch.get("c1")!.rewetLatched).toBe(false);
    // …and the evaluation honors the frozen latch: at Twet + 1.5 the unlatched
    // map would be FB; the latched map stays TB.
    updateDarrHartwigLatches(ctx, [cond], makeState(Twet - 0.5));
    expect(shared.latch.get("c1")!.rewetLatched).toBe(true);
    const hLatched = evaluateConvectionH(cond, ctx, makeState(Twet + 1.5));
    // Quench-front L semantics (see correlations.ts): z_qf is the
    // most-downstream LATCHED position — here c1 itself (z = 0.5), so the
    // plumbing computes L = z − z_qf = 0 at the front node, floored to
    // DH_L_FRONT_MIN (counted as frontDistance).  The direct call must pass
    // that same effective L for an exact comparison; with L = 0.5 the two
    // paths differ by 1.35 % via the IAF buoyancy term (∝ L^(−1/4)).
    const direct = darrHartwigHeatFlux(fluid, {
      P,
      hNode: sat.hf + 0.3 * sat.hfg,
      Tnode: sat.Tsat,
      Tw: Twet + 1.5,
      G,
      D,
      L: DH_L_FRONT_MIN,
      latched: true,
    });
    expect(direct.ok).toBe(true);
    if (direct.ok)
      expect(rel(hLatched, direct.result.hEff)).toBeLessThan(1e-12);
  });
});

/* =============================================================================
 * 5. Continuity sweeps (task test 3 — the anti-limit-cycle guarantee)
 * ============================================================================= */
describe("C0/C1 continuity of q″(T_w) and boundedness of h_eff", () => {
  function sweep(
    Tlo: number,
    Thi: number,
    step: number,
    xe = 0.3,
    latched = false,
  ) {
    const out: Array<{ Tw: number; q: number; h: number }> = [];
    for (let Tw = Tlo; Tw <= Thi + 1e-12; Tw += step) {
      const r = evalDH(Tw, xe, { latched });
      out.push({ Tw, q: r.qFlux, h: r.hEff });
    }
    return out;
  }

  it("through T_DNB: no jumps, bounded numerical derivative", () => {
    const TDnb = sat.Tsat + 2;
    const step = 5e-3;
    const pts = sweep(TDnb - 1.5, TDnb + 1.5, step);
    let maxSlope = 0;
    for (let i = 1; i < pts.length; i++) {
      const dq = Math.abs(pts[i].q - pts[i - 1].q);
      maxSlope = Math.max(maxSlope, dq / step);
      // A hard switch would jump O(1e3) W/m² in one step; the physical slope
      // here is ≲ 4·10³ W/m²K (NB branch at ΔT ≥ 0.5 K).
      expect(dq).toBeLessThan(3e4 * step);
    }
    expect(maxSlope).toBeLessThan(3e4);
    expect(maxSlope).toBeGreaterThan(100); // non-vacuous (real signal present)
  });

  it("through T_wet: no jumps, bounded numerical derivative (also latched)", () => {
    const Twet = evalDH(100, 0.3).Twet;
    for (const latched of [false, true]) {
      const Tb = Twet + (latched ? DH_HYSTERESIS : 0);
      const step = 5e-3;
      const pts = sweep(Tb - 1.5, Tb + 1.5, step, 0.3, latched);
      let maxSlope = 0;
      for (let i = 1; i < pts.length; i++) {
        const dq = Math.abs(pts[i].q - pts[i - 1].q);
        maxSlope = Math.max(maxSlope, dq / step);
        expect(dq).toBeLessThan(3e4 * step);
      }
      expect(maxSlope).toBeLessThan(3e4);
      expect(maxSlope).toBeGreaterThan(10);
    }
  });

  it("through T_sat (DB↔NB implementer extension): C0 with the physical NB cusp", () => {
    const step = 2e-3;
    const pts = sweep(sat.Tsat - 0.5, sat.Tsat + 0.5, step);
    for (let i = 1; i < pts.length; i++) {
      // q″ ∝ ΔT^0.746 cusp at ΔT→0 is the PUBLISHED NB behavior —
      // assert Hölder-scale smallness (no value jump), not Lipschitz.
      expect(Math.abs(pts[i].q - pts[i - 1].q)).toBeLessThan(4e4 * step);
    }
    // C0 at the seam itself: values approach q = 0 from both sides
    const below = evalDH(sat.Tsat - 1e-3, 0.3).qFlux;
    const above = evalDH(sat.Tsat + 1e-3, 0.3).qFlux;
    expect(Math.abs(below)).toBeLessThan(50);
    expect(Math.abs(above)).toBeLessThan(50);
  });

  it("h_eff stays finite and bounded as T_w → T_node (the secant guard)", () => {
    const step = 1e-3;
    const pts = sweep(sat.Tsat - 0.5, sat.Tsat + 0.5, step);
    let maxH = 0;
    for (const p of pts) {
      expect(isFinite(p.h)).toBe(true);
      expect(p.h).toBeGreaterThan(0); // q″ and (T_w − T_node) share sign here
      maxH = Math.max(maxH, p.h);
    }
    // Bound: the guard caps the denominator at 0.1 K (the h-cap guard);
    // max|q″| in this band is ~2000 W/m² ⇒ h_eff ≲ 2e4 W/m²K.
    expect(maxH).toBeLessThan(2e4);
    expect(maxH).toBeGreaterThan(1000); // non-vacuous (DB branch h ≈ 1079)
  });

  it("h_eff finite over the full chilldown range T_w ∈ [T_node, 300]", () => {
    for (const xe of [-0.05, 0.05, 0.3, 0.8, 1.5]) {
      const hNode = sat.hf + Math.max(xe, 0.001) * sat.hfg;
      const Tnode =
        xe <= 1 ? sat.Tsat : fluid.temperatureFromEnthalpy(P, hNode);
      for (let Tw = Tnode; Tw <= 300; Tw += 0.37) {
        const r = evalDH(Tw, xe, { Tnode });
        expect(isFinite(r.qFlux)).toBe(true);
        expect(isFinite(r.hEff)).toBe(true);
      }
    }
  });
});

/* =============================================================================
 * 6. Validity-envelope guards (P1 fit envelope)
 * ============================================================================= */
describe("Validity clamps (counted, never silently extrapolated)", () => {
  it("Re_l,in outside [1e4, 1e6] clamps and is equivalent to the boundary value", () => {
    const r = evalDH(100, 0.3, { ReLin: 500 });
    expect(r.clamps).toContain("relin");
    const rBoundary = evalDH(100, 0.3, { ReLin: DH_RE_LIN_MIN });
    expect(r.qFlux).toBe(rBoundary.qFlux);
    const rHi = evalDH(100, 0.3, { ReLin: 1e9 });
    expect(rHi.clamps).toContain("relin");
  });

  it("L below the 0.05 m front floor clamps (quench-front singularity guard)", () => {
    const r = evalDH(100, 0.3, { L: 0.005 });
    expect(r.clamps).toContain("frontDistance");
    const rFloor = evalDH(100, 0.3, { L: DH_L_FRONT_MIN });
    expect(r.qFlux).toBe(rFloor.qFlux);
  });

  it("T_wet Weber blow-up clamps at T_cr", () => {
    const GBlow = 500; // We_D ≈ 2.5e4 — far outside the fit (G ≤ 81)
    const r = evalDH(100, 0.3, { G: GBlow });
    expect(r.clamps).toContain("twetCrit");
    expect(r.Twet).toBe(sat.Tcr);
  });

  it("T_v beyond the property ceiling clamps (xe huge)", () => {
    const r = evalDH(300, 1e6, { Tnode: 900 });
    expect(r.clamps).toContain("tvapLimit");
    expect(r.Tv).toBe(sat.TvapMax);
    expect(isFinite(r.qFlux)).toBe(true);
  });

  it("near-critical pressure collapses the regime map with a counted guard", () => {
    const Pnc = 1.2e6; // 0.93·Pc — far above the fit range (≤ ~3.2 bar)
    const satNc = makeSat(Pnc);
    const r = evaluateDarrHartwig({
      sat: satNc,
      vaporProps: makeVap(Pnc, satNc),
      Tw: 100,
      Tnode: satNc.Tsat,
      G,
      xe: 0.3,
      D,
      L: L_FRONT,
      ReLin: RE_LIN,
      latched: false,
    });
    expect(r.clamps).toContain("regimeCollapse");
    expect(isFinite(r.qFlux)).toBe(true);
    expect(r.TDnb).toBeLessThan(satNc.Tsat + 2);
  });
});

/* =============================================================================
 * 7. Plumbing through evaluateConvectionH (task reqs 2–4)
 * ============================================================================= */
describe("Conductor plumbing", () => {
  const Afl = (Math.PI / 4) * D * D;
  const mdot = G * Afl;
  function makeCtx(): CorrelationCtx {
    return {
      fluid,
      isRealFluid: true,
      branches: [
        { id: "b0", from: "in", to: "f1" },
        { id: "b1", from: "f1", to: "out" },
      ],
      nBranch: 2,
      nodeMap: new Map([
        ["in", { id: "in", type: "boundary" }],
        ["f1", { id: "f1", type: "internal" }],
        ["out", { id: "out", type: "boundary" }],
      ]),
      darrHartwig: { latch: new Map(), axialPosition: new Map([["c1", 0.5]]) },
    };
  }
  const cond: CorrelationConductor = {
    id: "c1",
    from: "f1",
    to: "w1",
    type: {
      kind: "convection",
      area: Math.PI * D * 0.5,
      correlation: {
        model: "darrHartwig",
        diameter: D,
        flowArea: Afl,
        axialPosition: 0.5,
      },
    },
  };
  function makeState(Tw: number, xe = 0.3): CorrelationState {
    return {
      nodeP: new Map([["f1", P]]),
      nodeT: new Map([["f1", sat.Tsat]]),
      nodeH: new Map([["f1", sat.hf + xe * sat.hfg]]),
      mdots: [mdot, mdot],
      solidT: new Map([["w1", Tw]]),
    };
  }

  it("evaluateConvectionH returns the guarded secant h_eff (matches direct evaluation)", () => {
    resetSolverDiagnostics();
    const h = evaluateConvectionH(cond, makeCtx(), makeState(100));
    const direct = darrHartwigHeatFlux(fluid, {
      P,
      hNode: sat.hf + 0.3 * sat.hfg,
      Tnode: sat.Tsat,
      Tw: 100,
      G,
      D,
      L: 0.5,
      latched: false,
    });
    expect(direct.ok).toBe(true);
    if (direct.ok) expect(rel(h, direct.result.hEff)).toBeLessThan(1e-12);
    const diag = getSolverDiagnostics();
    expect(diag.darrHartwig.propertyFailureCount).toBe(0);
    expect(diag.darrHartwig.missingWallTempCount).toBe(0);
  });

  it("missing wall temperature → fallback floor + counted (documented)", () => {
    resetSolverDiagnostics();
    const state = makeState(100);
    state.solidT = new Map(); // no w1 entry
    const h = evaluateConvectionH(cond, makeCtx(), state);
    expect(h).toBe(FALLBACK_H_FLOOR);
    expect(getSolverDiagnostics().darrHartwig.missingWallTempCount).toBe(1);
    resetSolverDiagnostics();
  });

  it("inletLiquidReynolds override is honored (per-pipe global value)", () => {
    resetSolverDiagnostics();
    const condRe: CorrelationConductor = {
      ...cond,
      type: {
        ...cond.type,
        correlation: { ...cond.type.correlation!, inletLiquidReynolds: 1e5 },
      },
    };
    const h = evaluateConvectionH(condRe, makeCtx(), makeState(100));
    const direct = darrHartwigHeatFlux(fluid, {
      P,
      hNode: sat.hf + 0.3 * sat.hfg,
      Tnode: sat.Tsat,
      Tw: 100,
      G,
      D,
      L: 0.5,
      inletLiquidReynolds: 1e5,
      latched: false,
    });
    expect(direct.ok).toBe(true);
    if (direct.ok) expect(rel(h, direct.result.hEff)).toBeLessThan(1e-12);
  });
});

/* =============================================================================
 * 8. Bit-identity: pre-change goldens (task test 5)
 * Captured on main @ 6ed2d6c BEFORE the darrHartwig plumbing existed
 * (tmp_dh_goldens.ts, deleted after capture).
 * ============================================================================= */
describe("Bit-identity of existing models", () => {
  it("constant-h steady regression reproduces exact pre-change digits", () => {
    const config: NetworkConfig = {
      meta: { name: "regression", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "f1",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      solidNodes: [
        { id: "a1", type: "ambient", x: 0, y: 0, temperature: 400 },
        { id: "s1", type: "solid", x: 1, y: 0, temperature: 350 },
      ],
      conductors: [
        {
          id: "cond1",
          from: "a1",
          to: "s1",
          type: { kind: "conduction", k: 10, area: 0.01, length: 0.1 },
        },
        {
          id: "conv1",
          from: "s1",
          to: "f1",
          type: { kind: "convection", h: 100, area: 0.01 },
        },
      ],
      branches: [
        {
          id: "dummy",
          from: "f1",
          to: "f1",
          component: { type: "flowSource", massFlow: 0 },
        },
      ],
    };
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(res.conductors!.conv1.heatRate).toBe(50);
    expect(res.conductors!.conv1.heatTransferCoeff).toBe(100);
    expect(res.solidNodes!.s1.temperature).toBe(350);
  });

  it("miropolskii two-phase transient reproduces exact pre-change digits", () => {
    const Dd = 0.015875;
    const Afl2 = (Math.PI / 4) * Dd * Dd;
    const cfg: NetworkConfig = {
      meta: { name: "dh-bitid", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.5,
        endTime: 2,
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.5,
      },
      fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 0.4e6,
          quality: 0.1,
        },
        {
          id: "m1",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 0.35e6,
          quality: 0.1,
          volume: 1e-4,
        },
        {
          id: "m2",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 0.3e6,
          quality: 0.1,
          volume: 1e-4,
        },
        {
          id: "out",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: 0.25e6,
          quality: 0.3,
        },
      ],
      branches: [
        {
          id: "b0",
          from: "in",
          to: "m1",
          component: { type: "flowSource", massFlow: 0.08 },
        },
        {
          id: "b1",
          from: "m1",
          to: "m2",
          component: {
            type: "pipe",
            length: 0.5,
            diameter: Dd,
            roughness: 1.5e-6,
          },
        },
        {
          id: "b2",
          from: "m2",
          to: "out",
          component: {
            type: "pipe",
            length: 0.5,
            diameter: Dd,
            roughness: 1.5e-6,
          },
        },
      ],
      solidNodes: [
        {
          id: "w1",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 250,
          mass: 0.05,
          cp: 400,
        },
        {
          id: "w2",
          type: "solid",
          x: 2,
          y: 1,
          temperature: 250,
          mass: 0.05,
          cp: 400,
        },
      ],
      conductors: [
        {
          id: "c1",
          from: "m1",
          to: "w1",
          type: {
            kind: "convection",
            area: 0.005,
            correlation: { model: "miropolskii", diameter: Dd, flowArea: Afl2 },
          },
        },
        {
          id: "c2",
          from: "m2",
          to: "w2",
          type: {
            kind: "convection",
            area: 0.005,
            correlation: { model: "miropolskii", diameter: Dd, flowArea: Afl2 },
          },
        },
        {
          id: "k1",
          from: "w1",
          to: "w2",
          type: { kind: "conduction", k: 400, area: 4e-5, length: 0.5 },
        },
      ],
    };
    const rt = solveTransient(cfg);
    expect(rt.converged).toBe(true);
    expect(rt.solidNodes!.w1.temperature).toEqual([
      250, 248.1318359054469, 246.33683079985227, 244.5593191303614,
      242.8010865507715,
    ]);
    expect(rt.solidNodes!.w2.temperature).toEqual([
      250, 247.99023628332407, 246.1577345960308, 244.3407590130666,
      242.54303566789494,
    ]);
    expect(rt.conductors!.c1.heatTransferCoeff).toEqual([
      90.81838218567584, 92.17931277821674, 89.5339986169411, 89.6813103226151,
      89.68273020710521,
    ]);
    expect(rt.conductors!.c1.heatRate).toEqual([
      -72.81023458383926, -74.72448511738017, -71.78493495728279,
      -71.10624165100933, -70.31899654982645,
    ]);
    expect(rt.nodes.m1.pressure).toEqual([
      350000, 251814.08179956267, 251368.52937083866, 251355.5656651236,
      251353.21261500122,
    ]);
    expect(rt.nodes.m1.temperature).toEqual([
      89.65749481205114, 86.00329997859065, 85.98448182367225,
      85.98393392420137, 85.98383447238784,
    ]);
    expect(rt.nodes.m1.quality).toEqual([
      0.09999999999999992, 0.15408101982052433, 0.159404205479823,
      0.1600913986723134, 0.16014107939023123,
    ]);
  }, 20000);
});

/* =============================================================================
 * 9. Integration smoke test: one LH2 chilldown segment (task test 6)
 * ============================================================================= */
describe("LH2 chilldown smoke (darrHartwig selected)", () => {
  it("runs, converges, cools the wall, counters clean", () => {
    resetSolverDiagnostics();
    const Dd = 0.0102; // GRC test-section ID (P1)
    const OD = 0.0127;
    const segL = 0.5;
    const Afl3 = (Math.PI / 4) * Dd * Dd;
    const mdot = 3.1e-3; // ≈ G 38 kg/m²s — mid-fit
    const config: NetworkConfig = {
      meta: { name: "dh-lh2-smoke", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.1,
        endTime: 2,
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.5,
      },
      fluid: { model: "realFluid", params: { fluidName: "ParaHydrogen" } },
      nodes: [
        { id: "in", type: "boundary", x: 0, y: 0, pressure: 3e5, quality: 0 },
        {
          id: "f1",
          type: "internal",
          x: 0.5,
          y: 0,
          pressure: 2.5e5,
          temperature: 250,
          volume: Afl3 * segL,
        },
        {
          id: "out",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 2e5,
          temperature: 250,
        },
      ],
      branches: [
        {
          id: "b0",
          from: "in",
          to: "f1",
          component: { type: "flowSource", massFlow: mdot },
        },
        {
          id: "b1",
          from: "f1",
          to: "out",
          component: {
            type: "pipe",
            length: segL,
            diameter: Dd,
            roughness: 1.5e-6,
          },
        },
      ],
      solidNodes: [
        {
          id: "w1",
          type: "solid",
          x: 0.5,
          y: 1,
          temperature: 250,
          mass: 7900 * (Math.PI / 4) * (OD * OD - Dd * Dd) * segL, // SS wall
          cp: 450,
        },
      ],
      conductors: [
        {
          id: "c1",
          from: "f1",
          to: "w1",
          type: {
            kind: "convection",
            area: Math.PI * Dd * segL,
            correlation: {
              model: "darrHartwig",
              diameter: Dd,
              flowArea: Afl3,
              axialPosition: segL,
            },
          },
        },
      ],
    };
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    const Tw = res.solidNodes!.w1.temperature;
    for (const t of Tw) expect(isFinite(t)).toBe(true);
    // Wall cools monotonically (within solver noise)
    for (let i = 1; i < Tw.length; i++)
      expect(Tw[i]).toBeLessThanOrEqual(Tw[i - 1] + 1e-6);
    expect(Tw[Tw.length - 1]).toBeLessThan(250);
    // Wall never below its local fluid temperature (physical asymptote)
    const lastT = res.nodes.f1.temperature[res.times.length - 1];
    expect(Tw[Tw.length - 1]).toBeGreaterThan(lastT - 0.5);
    // h series finite, positive, and physically scaled (film boiling hundreds,
    // nucleate thousands of W/m²K)
    const hSer = res.conductors!.c1.heatTransferCoeff!;
    for (const h of hSer) {
      expect(isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThan(5e4);
    }
    const diag = getSolverDiagnostics();
    console.log(
      "DH smoke diagnostics:",
      JSON.stringify(diag.darrHartwig),
      "hFloorClamp:",
      diag.hFloorClampCount,
    );
    expect(diag.statePHFallbackCount.lastResort).toBe(0);
    expect(diag.darrHartwig.propertyFailureCount).toBe(0);
    expect(diag.darrHartwig.missingWallTempCount).toBe(0);
    expect(diag.darrHartwig.validityClamps.tvapLimit).toBe(0);
    expect(diag.darrHartwig.validityClamps.regimeCollapse).toBe(0);
    // The relin/twetCrit/hFloor clamps fire ONLY on the t=0 state:
    // createInitialState seeds branch mdots at ≈ 0.1 kg/s, so the t=0 h-map
    // (and the identical step-1 entry h-map — hence ×2) sees
    //   G = 1224 kg/m²s (15× the fit-envelope ceiling 81; 25× G* ≈ 47.5
    //   where raw Eq. 18 crosses T_cr), Re_l,in = 1.21e6 (> 1e6),
    //   T_v = 252.8 K > T_w = 250 K = T_node (the documented negative-h_eff
    //   sliver → h-floor catch).  All are the guards working as designed on
    //   a grossly out-of-envelope INITIAL GUESS, counted loudly; from step 1
    //   on the flow relaxes to the imposed 3.1 g/s and every accepted state
    //   is in-envelope (swept below).  Assert RARE + bounded, not zero:
    expect(diag.darrHartwig.validityClamps.relin).toBeLessThanOrEqual(2);
    expect(diag.darrHartwig.validityClamps.twetCrit).toBeLessThanOrEqual(2);
    expect(diag.hFloorClampCount).toBeLessThanOrEqual(2);
    // Pin the mechanism: re-evaluate the correlation at every RECORDED state.
    // The t=0 state must reproduce exactly the counted clamps; every accepted
    // state (i ≥ 1) must be fully in-envelope with h_eff above the floor.
    const b0m = res.branches.b0.mdot;
    const b1m = res.branches.b1.mdot;
    const f1n = res.nodes.f1;
    const w1T = res.solidNodes!.w1.temperature;
    const sweepAt = (i: number) =>
      darrHartwigHeatFlux(fluid, {
        P: f1n.pressure[i],
        hNode: f1n.enthalpy![i],
        Tnode: f1n.temperature[i],
        Tw: w1T[i],
        // massFluxAtNode convention: ½·Σ|mdot| over attached branches / flowArea
        G: (0.5 * (Math.abs(b0m[i]) + Math.abs(b1m[i]))) / Afl3,
        D: Dd,
        L: segL,
        latched: false,
      });
    const r0 = sweepAt(0);
    expect(r0.ok).toBe(true);
    if (r0.ok) {
      expect(r0.result.clamps).toContain("relin");
      expect(r0.result.clamps).toContain("twetCrit");
      expect(r0.result.hEff).toBeLessThan(FALLBACK_H_FLOOR); // the T_v > T_w sliver catch
    }
    for (let i = 1; i < res.times.length; i++) {
      const ri = sweepAt(i);
      expect(ri.ok).toBe(true);
      if (ri.ok) {
        expect(ri.result.clamps).toEqual([]);
        expect(ri.result.hEff).toBeGreaterThanOrEqual(FALLBACK_H_FLOOR);
      }
    }
    resetSolverDiagnostics();
  }, 60000);
});
