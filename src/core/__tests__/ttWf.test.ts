/**
 * TT-WF (two-temperature / wetted-fraction) proposed chilldown closure —
 * Phase-1 local-model tests.
 *
 * The tests are ANALYTICAL/STRUCTURAL, not golden values copied from the
 * implementation:
 *  - independent in-test re-derivations (hand formulas from the D-H SPEC,
 *    first-principles energy balances) are used wherever an absolute number
 *    is asserted;
 *  - Darr–Hartwig compatibility is asserted against the EXISTING production
 *    evaluator (evaluateDarrHartwig), proving reuse rather than divergence;
 *  - continuity/conservation/hysteresis are asserted as mathematical
 *    properties over sweeps and traces.
 *
 * Fixture: LH2 (para-hydrogen) at P = 2 bar, G = 38 kg/m²s, D = 1.02 cm —
 * the middle of the D-H fit envelope (same fixture as darrHartwig.test.ts).
 * Anchors at this state (CoolProp): Tsat ≈ 22.80 K, T_wet ≈ 32.48 K,
 * T_DNB = Tsat + 2 K.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { getFluidLimits } from "../fluids/realFluid";
import {
  evaluateDarrHartwig,
  DH_DT_NODE_GUARD,
  type DHSatState,
  type DHVaporProps,
} from "../darrHartwig";
import {
  evaluateTtWf,
  initTtWfState,
  resolveTtWfParams,
  ttWfLatchUpdate,
  ttWfLiquidAvailability,
  ttWfSmoothMin,
  ttWfWettedFractionUpdate,
  ttWfFrontEnergyPerLength,
  ttWfWettedPerimeter,
  TTWF_DEFAULT_PARAMS,
  TTWF_CHI_DRY,
  TTWF_SMOOTH_MIN_EPS,
  TTWF_FRONT_ENERGY_EPS,
  type TtWfEvaluateArgs,
  type TtWfOutcome,
  type TtWfResult,
  type TtWfState,
} from "../ttWf";
import {
  getSolverDiagnostics,
  recordTtWfEvaluation,
  resetSolverDiagnostics,
} from "../diagnostics";
import { evaluateConvectionH, FALLBACK_H_FLOOR } from "../correlations";
import type {
  CorrelationConductor,
  CorrelationCtx,
  CorrelationState,
} from "../correlations";
import { validateNetwork } from "../validate";
import type { NetworkConfig } from "../schema";

/* =============================================================================
 * Fixture (LH2, 2 bar — identical construction to darrHartwig.test.ts)
 * ============================================================================= */
const P = 2e5;
const D = 0.0102;
const G = 38;
const L_FRONT = 0.5;

let fluid: RealFluid;
let sat: DHSatState;
let vap: (T: number) => DHVaporProps;
let RE_LIN: number;

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
  fluid = new RealFluid("ParaHydrogen");
  const s = fluid.saturationProperties(P);
  sat = {
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
    sigma: fluid.surfaceTension(P),
    Tcr: fluid.criticalTemperature(),
    TvapMax: 0.95 * getFluidLimits(fluid.fluidName).Tmax,
  };
  const T_LO = sat.Tsat + 0.25;
  const T_HI = Math.max(sat.TvapMax, T_LO);
  vap = (T) => fluid.transportPropsPT(P, Math.min(Math.max(T, T_LO), T_HI));
  RE_LIN = (G * D) / sat.muf;
}, 30000);

/** Hand (independent) Dittus–Boelter liquid h [P1 Eq. 14]. */
function handHDB(): number {
  const ReL = (G * D) / sat.muf;
  const PrL = (sat.cpf * sat.muf) / sat.kf;
  return (0.023 * Math.pow(ReL, 0.8) * Math.pow(PrL, 0.4) * sat.kf) / D;
}

/** Hand (independent) nucleate-boiling flux, q-form [P1 Eqs. 13–16]. */
function handQNB(dTSat: number): number {
  const ReL = (G * D) / sat.muf;
  return (
    61.6 *
    Math.pow(ReL, -0.332) *
    Math.pow(sat.cpf / sat.hfg, -0.254) *
    Math.pow(Math.max(dTSat, 0), 0.746) *
    handHDB()
  );
}

/** Constant-cp wall context (H_s(T) = cp·T — exact analytic enthalpy). */
const WALL_CP = 385; // J/kgK (copper-order value; the law never fits it)
const WALL_M_PER_L = 0.5; // kg/m
const wall = {
  massPerLength: WALL_M_PER_L,
  enthalpy: (T: number) => WALL_CP * T,
};

const TSAT = () => sat.Tsat;
let TWET_VAL = 0;
beforeAll(() => {
  // T_wet from the same published formula the implementation calls, but
  // computed here independently from the SPEC transcription:
  //   T_wet = 0.844·T_cr·(1 + 0.060·We_D^0.208),  We_D = G²D/(ρ_l·σ).
  const WeD = (G * G * D) / (sat.rhof * sat.sigma);
  TWET_VAL = 0.844 * sat.Tcr * (1 + 0.06 * Math.pow(WeD, 0.208));
});

/** Base evaluation args: two-phase x_e = 0.5 node, accepted state partially
 *  wetted + latched, wall a few K into the wet-side map.  Override freely. */
function baseArgs(over?: Partial<TtWfEvaluateArgs>): TtWfEvaluateArgs {
  return {
    sat,
    vaporProps: vap,
    Tw: TSAT() + 1, // NB region on the wet side
    Tnode: TSAT(),
    hNode: sat.hf + 0.5 * sat.hfg, // x_e = 0.5 ⇒ χ_l = 0.5
    G,
    D,
    L: L_FRONT,
    ReLin: RE_LIN,
    segmentLength: 10,
    dt: 0.1,
    state: { fWet: 0.3, rewetLatched: true },
    wall,
    ...over,
  };
}

function ok(out: TtWfOutcome): TtWfResult {
  if (!out.ok)
    throw new Error(`expected ok outcome, got reason: ${out.reason}`);
  return out.result;
}

/** Reference D-H evaluation with the identical property bundle. */
function dhRef(
  Tw: number,
  xe: number,
  over?: Partial<Parameters<typeof evaluateDarrHartwig>[0]>,
) {
  return evaluateDarrHartwig({
    sat,
    vaporProps: vap,
    Tw,
    Tnode: TSAT(),
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
 * A. Bounds and statefulness
 * ============================================================================= */
describe("A. bounds and statefulness", () => {
  it("fWet stays in [0,1] and all outputs finite across extreme inputs", () => {
    const Tws = [4, 15, TSAT(), 25, 28, TWET_VAL, TWET_VAL + 20, 100, 500];
    const xes = [-0.5, 0, 0.05, 0.5, 0.99, 2, 8, 50];
    const dts = [0, 1e-4, 0.1, 10, 1e6];
    const fs = [0, 0.3, 1];
    for (const Tw of Tws)
      for (const xe of xes)
        for (const dt of dts)
          for (const fWet of fs) {
            const r = ok(
              evaluateTtWf(
                baseArgs({
                  Tw,
                  hNode: sat.hf + xe * sat.hfg,
                  dt,
                  state: { fWet, rewetLatched: Tw <= TWET_VAL },
                }),
              ),
            );
            expect(r.proposedState.fWet).toBeGreaterThanOrEqual(0);
            expect(r.proposedState.fWet).toBeLessThanOrEqual(1);
            expect(Number.isFinite(r.qBar)).toBe(true);
            expect(Number.isFinite(r.hEff)).toBe(true);
            expect(Number.isFinite(r.rFront)).toBe(true);
            expect(r.rFront).toBeGreaterThanOrEqual(0);
            expect(r.Tv).toBeGreaterThanOrEqual(TSAT()); // never below saturation here
          }
  });

  it("evaluator is pure: accepted state is not mutated, results are fresh objects", () => {
    const state: TtWfState = Object.freeze({ fWet: 0.3, rewetLatched: true });
    const args = baseArgs({ state });
    const r1 = ok(evaluateTtWf(args));
    const r2 = ok(evaluateTtWf(args));
    expect(state.fWet).toBe(0.3);
    expect(state.rewetLatched).toBe(true);
    expect(r1).toEqual(r2); // deterministic
    expect(r1.proposedState).not.toBe(state); // proposal is a NEW object
    expect(r2.proposedState).not.toBe(r1.proposedState);
  });

  it("flux evaluation is independent of dt; dt only scales the proposal", () => {
    const a = baseArgs({ dt: 0 });
    const b = baseArgs({ dt: 10 });
    const ra = ok(evaluateTtWf(a));
    const rb = ok(evaluateTtWf(b));
    expect(ra.qBar).toBe(rb.qBar);
    expect(ra.hEff).toBe(rb.hEff);
    expect(ra.rFront).toBe(rb.rFront);
    expect(rb.proposedState.fWet).toBeGreaterThanOrEqual(ra.proposedState.fWet);
    // dt = 0 proposes no change at all
    expect(ra.proposedState.fWet).toBe(0.3);
  });

  it("rejects zero/negative/NaN inputs cleanly (ok:false + reason, no throw)", () => {
    const bads: Array<Partial<TtWfEvaluateArgs>> = [
      { Tw: 0 },
      { Tw: -5 },
      { Tw: NaN },
      { Tnode: 0 },
      { hNode: NaN },
      { G: -1 },
      { G: Infinity },
      { D: 0 },
      { L: NaN },
      { ReLin: NaN },
      { segmentLength: 0 },
      { segmentLength: -1 },
      { dt: -0.1 },
      { wall: { massPerLength: 0, enthalpy: wall.enthalpy } },
      { wall: { massPerLength: -1, enthalpy: wall.enthalpy } },
      { state: { fWet: 1.2, rewetLatched: true } },
      { state: { fWet: -0.1, rewetLatched: true } },
      { state: { fWet: NaN, rewetLatched: true } },
      { params: { frontEnergyFactor: 5 } }, // above hard bound 4
      { params: { frontEnergyFactor: 0.1 } }, // below hard bound 0.25
      { params: { rewetHysteresisOffsetK: -1 } },
      { params: { rewetHysteresisOffsetK: 6 } }, // above hard bound 5 K
      { wall: { massPerLength: 0.5, enthalpy: () => NaN } },
    ];
    for (const over of bads) {
      const out = evaluateTtWf(baseArgs(over));
      expect(out.ok).toBe(false);
      if (!out.ok) expect(typeof out.reason).toBe("string");
    }
  });

  it("pure helper laws match their defining equations", () => {
    // smoothMin is differentiable, ≤ min, and → min as separation grows
    expect(ttWfSmoothMin(3, 5)).toBeLessThanOrEqual(3);
    expect(ttWfSmoothMin(3, 5)).toBeCloseTo(
      3 - TTWF_SMOOTH_MIN_EPS ** 2 / 8,
      12,
    );
    expect(ttWfSmoothMin(2, 2)).toBeCloseTo(2 - TTWF_SMOOTH_MIN_EPS / 2, 15);
    // liquid availability gate
    expect(ttWfLiquidAvailability(sat.hf, sat)).toBe(1); // saturated liquid
    expect(ttWfLiquidAvailability(sat.hf + sat.hfg, sat)).toBe(0); // saturated vapor
    expect(ttWfLiquidAvailability(sat.hf + 0.25 * sat.hfg, sat)).toBe(0.75);
    expect(ttWfLiquidAvailability(sat.hf - 0.5 * sat.hfg, sat)).toBe(1); // subcooled clamps
    expect(ttWfLiquidAvailability(sat.hf + 3 * sat.hfg, sat)).toBe(0); // superheated clamps
    // wetted perimeter
    expect(ttWfWettedPerimeter(D)).toBe(Math.PI * D);
    // front energy per length: m'·[H_s(Tw) − H_s(T_DNB)]⁺ + ε
    const TDnb = TSAT() + 2;
    expect(ttWfFrontEnergyPerLength(wall, 28, TDnb)).toBeCloseTo(
      WALL_M_PER_L * WALL_CP * (28 - TDnb) + TTWF_FRONT_ENERGY_EPS,
      12,
    );
    // cold-wall guard: bracket floored at 0
    expect(ttWfFrontEnergyPerLength(wall, TDnb - 5, TDnb)).toBe(
      TTWF_FRONT_ENERGY_EPS,
    );
    // latch truth table
    expect(ttWfLatchUpdate(TWET_VAL - 0.1, TWET_VAL, 0.5, false, 2)).toBe(true); // set
    expect(ttWfLatchUpdate(TWET_VAL + 2.1, TWET_VAL, 0, true, 2)).toBe(false); // clear (dry)
    expect(ttWfLatchUpdate(TWET_VAL + 2.1, TWET_VAL, 0.5, true, 2)).toBe(true); // liquid present: retain
    expect(ttWfLatchUpdate(TWET_VAL + 1, TWET_VAL, 0, true, 2)).toBe(true); // inside ΔT_h: retain
    expect(ttWfLatchUpdate(TWET_VAL + 1, TWET_VAL, 0, false, 2)).toBe(false); // never wetted
    // BE front update against the analytic formula f + dt(1−f)r
    const upd = ttWfWettedFractionUpdate(0.2, true, 2, 50, 0.1, 10);
    expect(upd.rFront).toBeCloseTo(2 - TTWF_SMOOTH_MIN_EPS ** 2 / (4 * 48), 15);
    expect(upd.fNext).toBeCloseTo(0.2 + 0.1 * 0.8 * upd.rFront, 15);
    expect(upd.limiter).toBe("energy");
    const updL = ttWfWettedFractionUpdate(0.2, true, 50, 2, 0.1, 10);
    expect(updL.limiter).toBe("supply");
    expect(updL.fNext).toBeCloseTo(0.2 + 0.1 * 0.8 * updL.rFront, 15);
    // clamped at 1
    const updC = ttWfWettedFractionUpdate(0.9, true, 1e6, 1e6, 10, 1);
    expect(updC.fNext).toBe(1);
    expect(updC.clamped).toBe(true);
    // latch false ⇒ held at 0
    expect(ttWfWettedFractionUpdate(0.7, false, 1, 1, 0.1, 1).fNext).toBe(0);
    // init
    expect(initTtWfState(300, TWET_VAL)).toEqual({
      fWet: 0,
      rewetLatched: false,
    });
    expect(initTtWfState(TWET_VAL - 1, TWET_VAL)).toEqual({
      fWet: 1,
      rewetLatched: true,
    });
  });
});

/* =============================================================================
 * B. Local limits
 * ============================================================================= */
describe("B. local limits", () => {
  it("dry hot wall at low wet fraction selects film/FB behavior on (Tw − Tv)", () => {
    const Tw = TWET_VAL + 20;
    const r = ok(
      evaluateTtWf(baseArgs({ Tw, state: { fWet: 0, rewetLatched: false } })),
    );
    expect(r.dryRegime).toBe("FB");
    expect(r.Tv).toBeGreaterThan(TSAT()); // two-temperature: vapor superheat
    expect(r.qBar).toBe(r.qDry); // f = 0 ⇒ all dry
    // Film flux is driven by (Tw − Tv), NOT (Tw − Tsat): the NB-form flux
    // with (Tw − Tsat) would be far larger; assert the Tv reference by
    // direct comparison to the D-H film evaluation (same algebra).
    const dh = dhRef(Tw, 0.5);
    expect(r.qBar).toBe(dh.qFlux);
    // No front advance while unlatched
    expect(r.proposedState.fWet).toBe(0);
    expect(r.proposedState.rewetLatched).toBe(false);
  });

  it("fully wetted wall in NB selects the hand-computed nucleate flux", () => {
    const Tw = TSAT() + 1; // pure NB (outside the ±0.25 K DB blend, below T_DNB − 0.5)
    const r = ok(
      evaluateTtWf(baseArgs({ Tw, state: { fWet: 1, rewetLatched: true } })),
    );
    expect(r.wetRegime).toBe("NB");
    expect(r.qBar).toBe(r.qWet);
    // Independent hand value, 1e-12 relative
    expect(Math.abs(r.qWet / handQNB(1) - 1)).toBeLessThan(1e-12);
  });

  it("fully wetted sub-Tsat wall is single-phase liquid DB (fluid heats wall)", () => {
    const Tw = TSAT() - 1;
    const r = ok(
      evaluateTtWf(baseArgs({ Tw, state: { fWet: 1, rewetLatched: true } })),
    );
    expect(r.wetRegime).toBe("DB");
    expect(Math.abs(r.qWet / (handHDB() * (Tw - TSAT())) - 1)).toBeLessThan(
      1e-12,
    );
    expect(r.qBar).toBeLessThan(0); // wall colder than fluid
  });

  it("energy limiter binds when liquid is plentiful and wall energy is large", () => {
    // x_e = 0.05 ⇒ χ_l = 0.95 (plentiful liquid); tiny Δz ⇒ r_L huge.
    const Tw = 28; // TB region: q_W ≫ q_F, and T_DNB = 24.8 K ⇒ E'_q sizeable
    const r = ok(
      evaluateTtWf(
        baseArgs({
          Tw,
          hNode: sat.hf + 0.05 * sat.hfg,
          segmentLength: 0.01,
          dt: 0.5,
        }),
      ),
    );
    expect(r.limiter).toBe("energy");
    expect(r.rEnergy).toBeGreaterThan(0);
    expect(r.rEnergy).toBeLessThan(r.rLiquid);
    expect(r.rFront).toBeCloseTo(r.rEnergy, 9);
    // proposed advance follows the analytic BE law with r_E
    expect(r.proposedState.fWet).toBeCloseTo(0.3 + 0.5 * 0.7 * r.rEnergy, 12);
  });

  it("supply limiter binds when energy is cheap and liquid is scarce", () => {
    // χ_l = 0.1 (x_e = 0.9), Δz = 10 m ⇒ r_L = j_l/Δz small; wall close to
    // T_DNB would shrink E'_q — instead keep Tw = 28 (E'_q large) but make
    // the supply rate smaller still via χ_l.
    const r = ok(
      evaluateTtWf(
        baseArgs({
          Tw: 28,
          hNode: sat.hf + 0.9 * sat.hfg,
          segmentLength: 10,
          dt: 0.5,
        }),
      ),
    );
    expect(r.limiter).toBe("supply");
    expect(r.rLiquid).toBeLessThan(r.rEnergy);
    expect(r.rFront).toBeCloseTo(r.rLiquid, 9);
    // liquid superficial velocity ceiling: the front cannot advance faster
    // than the liquid arrives (u = r·Δz = j_l)
    expect(r.frontSpeed).toBeCloseTo(r.jL, 9);
    expect(r.jL).toBeCloseTo((G * 0.1) / sat.rhof, 12);
  });

  it("zero liquid availability forbids advance even with a strong thermal drive", () => {
    // x_e = 2 ⇒ χ_l = 0 (superheated mixture): no latent-capable inflow.
    const r = ok(
      evaluateTtWf(baseArgs({ Tw: 28, hNode: sat.hf + 2 * sat.hfg, dt: 100 })),
    );
    expect(r.chiL).toBe(0);
    expect(r.rLiquid).toBe(0);
    expect(r.rFront).toBeCloseTo(0, 15);
    expect(r.proposedState.fWet).toBe(0.3); // unchanged despite dt = 100 s
  });

  it("q_W ≤ q_F (wall hotter than T_wet) forbids advance even latched with liquid", () => {
    // Latch retained inside the hysteresis band, but the wet map has already
    // collapsed onto the film branch ⇒ max(q_W − q_F, 0) = 0.
    const Tw = TWET_VAL + 1; // < T_wet + ΔT_h (2 K): latch retained
    const r = ok(evaluateTtWf(baseArgs({ Tw, dt: 100 })));
    expect(r.proposedState.rewetLatched).toBe(true);
    expect(r.limiter).toBe("none");
    expect(r.rEnergy).toBe(0);
    expect(r.qWet).toBe(r.qDry); // wet map = film floor above T_wet
    expect(r.proposedState.fWet).toBe(0.3); // no advance
  });

  it("h_eff and q stay finite as T_w → T_fluid (guarded secant)", () => {
    for (const fWet of [0, 0.5, 1]) {
      for (const dT of [0, 1e-12, 1e-6, 0.09, -0.09, -1e-6]) {
        const r = ok(
          evaluateTtWf(
            baseArgs({ Tw: TSAT() + dT, state: { fWet, rewetLatched: true } }),
          ),
        );
        expect(Number.isFinite(r.hEff)).toBe(true);
        expect(Number.isFinite(r.qBar)).toBe(true);
        expect(r.hEffGuarded).toBe(Math.abs(dT) < DH_DT_NODE_GUARD);
      }
    }
    // At exactly T_w = T_node the mixture flux is ~0 and the guarded secant
    // reports the local slope (bounded)
    const r0 = ok(
      evaluateTtWf(
        baseArgs({ Tw: TSAT(), state: { fWet: 1, rewetLatched: true } }),
      ),
    );
    expect(Math.abs(r0.qBar)).toBeLessThan(1e-6);
    expect(Math.abs(r0.hEff)).toBeLessThan(1e9);
  });
});

/* =============================================================================
 * C. Hysteresis
 * ============================================================================= */
describe("C. hysteresis", () => {
  it("cooling through T_wet sets the latch; small reheating inside ΔT_h retains it", () => {
    const cold = { fWet: 0, rewetLatched: false };
    // Wall above T_wet: no set
    expect(
      ok(evaluateTtWf(baseArgs({ Tw: TWET_VAL + 0.1, state: cold })))
        .proposedState.rewetLatched,
    ).toBe(false);
    // Cooling through T_wet: set
    const afterCool = ok(
      evaluateTtWf(baseArgs({ Tw: TWET_VAL - 0.1, state: cold })),
    );
    expect(afterCool.latchTransition).toBe("set");
    expect(afterCool.proposedState.rewetLatched).toBe(true);
    // Reheat within ΔT_h (= 2 K default): retained, fWet NOT dried out
    const reheated = ok(
      evaluateTtWf(
        baseArgs({
          Tw: TWET_VAL + 1.5,
          state: { fWet: 0.6, rewetLatched: true },
        }),
      ),
    );
    expect(reheated.latchTransition).toBe("unchanged");
    expect(reheated.proposedState.rewetLatched).toBe(true);
    expect(reheated.proposedState.fWet).toBe(0.6); // no dewet inside ΔT_h
  });

  it("clearing requires BOTH superheat beyond ΔT_h AND dry availability", () => {
    const hot = TWET_VAL + 2.5; // beyond ΔT_h = 2 K
    // Liquid available (χ_l = 0.5): retained even this hot
    const wet = ok(
      evaluateTtWf(
        baseArgs({ Tw: hot, state: { fWet: 0.6, rewetLatched: true } }),
      ),
    );
    expect(wet.proposedState.rewetLatched).toBe(true);
    // Dry (x_e = 2 ⇒ χ_l = 0 < χ_dry): cleared and f dried to 0
    const dry = ok(
      evaluateTtWf(
        baseArgs({
          Tw: hot,
          hNode: sat.hf + 2 * sat.hfg,
          state: { fWet: 0.6, rewetLatched: true },
        }),
      ),
    );
    expect(dry.latchTransition).toBe("cleared");
    expect(dry.proposedState).toEqual({ fWet: 0, rewetLatched: false });
    // χ_l just above the χ_dry guard still retains
    const marginal = ok(
      evaluateTtWf(
        baseArgs({
          Tw: hot,
          hNode: sat.hf + (1 - TTWF_CHI_DRY - 0.005) * sat.hfg, // χ_l = χ_dry + 0.005
          state: { fWet: 0.6, rewetLatched: true },
        }),
      ),
    );
    expect(marginal.proposedState.rewetLatched).toBe(true);
  });

  it("sawtooth wall-T inside ΔT_h produces no latch chatter and monotone f", () => {
    resetSolverDiagnostics();
    // x_e = 2 (dry availability) so the ONLY thing preventing a clear is ΔT_h.
    const hHot = sat.hf + 2 * sat.hfg;
    let state: TtWfState = { fWet: 0.4, rewetLatched: true };
    let sets = 0;
    let clears = 0;
    let prevF = state.fWet;
    const dTh = TTWF_DEFAULT_PARAMS.rewetHysteresisOffsetK; // 2 K
    // 40 full sawtooth cycles between T_wet − 0.5 and T_wet + ΔT_h − 0.5
    for (let cycle = 0; cycle < 40; cycle++) {
      const trace: number[] = [];
      const steps = 8;
      for (let i = 0; i <= steps; i++)
        trace.push(TWET_VAL - 0.5 + (dTh - 1) * (i / steps));
      for (let i = steps - 1; i >= 1; i--)
        trace.push(TWET_VAL - 0.5 + (dTh - 1) * (i / steps));
      for (const Tw of trace) {
        const frozen = Object.freeze(state);
        const r = ok(
          evaluateTtWf(baseArgs({ Tw, hNode: hHot, state: frozen, dt: 0.05 })),
        );
        if (r.latchTransition === "set") sets++;
        if (r.latchTransition === "cleared") clears++;
        expect(r.proposedState.fWet).toBeGreaterThanOrEqual(prevF); // no dewet while latched
        expect(r.proposedState.fWet).toBeLessThanOrEqual(1);
        prevF = r.proposedState.fWet;
        state = r.proposedState; // simulated step acceptance
      }
    }
    // The whole oscillation stays inside the hysteresis band: the latch was
    // already set and must never clear — zero transitions over 40 cycles.
    expect(clears).toBe(0);
    expect(sets).toBe(0);
    expect(state.rewetLatched).toBe(true);
  });

  it("one-shot set then clear across a full quench–reheat cycle counts one transition each", () => {
    resetSolverDiagnostics();
    const hHot = sat.hf + 2 * sat.hfg; // χ_l = 0
    let state: TtWfState = { fWet: 0, rewetLatched: false };
    const commit = (Tw: number) => {
      const r = evaluateTtWf(baseArgs({ Tw, hNode: hHot, state, dt: 0.05 }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        recordTtWfEvaluation(r);
        state = r.result.proposedState;
        return r.result;
      }
      throw new Error("unreachable");
    };
    commit(TWET_VAL + 5); // hot dry: nothing
    expect(state.rewetLatched).toBe(false);
    commit(TWET_VAL - 1); // cools through T_wet: set
    expect(state.rewetLatched).toBe(true);
    commit(TWET_VAL + 1); // within ΔT_h: retained
    expect(state.rewetLatched).toBe(true);
    commit(TWET_VAL + 3); // beyond ΔT_h AND dry: cleared
    expect(state).toEqual({ fWet: 0, rewetLatched: false });
    const diag = getSolverDiagnostics();
    expect(diag.ttWf.latchSetCount).toBe(1);
    expect(diag.ttWf.latchClearCount).toBe(1);
    resetSolverDiagnostics();
  });
});

/* =============================================================================
 * D. Conservation / units of the front law
 * ============================================================================= */
describe("D. conservation and units", () => {
  it("energy-limited advance: newly wetted wall enthalpy == excess heat × dt (independent balance)", () => {
    const Tw = 28;
    const f = 0.3;
    const dt = 0.5;
    const dz = 0.01; // energy binds (verified by the limiter flag)
    const r = ok(
      evaluateTtWf(
        baseArgs({
          Tw,
          hNode: sat.hf + 0.05 * sat.hfg,
          segmentLength: dz,
          dt,
          state: { fWet: f, rewetLatched: true },
        }),
      ),
    );
    expect(r.limiter).toBe("energy");
    const df = r.proposedState.fWet - f;
    expect(df).toBeGreaterThan(0);

    // INDEPENDENT first-principles balance (do not import the law):
    // wall enthalpy that must leave the newly wetted length Δz·df to bring
    // it from T_w to T_DNB (constant-cp wall: H_s = cp·T):
    const TDnb = TSAT() + 2;
    const dEWall = df * dz * WALL_M_PER_L * WALL_CP * (Tw - TDnb);
    // excess wall→fluid heat over the segment during dt, weighted by the
    // smearing factor (1−f), with C_q = 1:
    const dEHeat = (1 - f) * dt * Math.PI * D * (r.qWet - r.qDry) * dz;
    // tolerance covers the fixed ε_E floor (ε_E/E'_q ≈ 1.6e-9) and smoothMin
    expect(Math.abs(dEWall / dEHeat - 1)).toBeLessThan(1e-6);
  });

  it("supply-limited advance moves the front at the liquid superficial velocity", () => {
    const Tw = 28;
    const f = 0.3;
    const dt = 0.5;
    const dz = 10;
    const r = ok(
      evaluateTtWf(
        baseArgs({
          Tw,
          hNode: sat.hf + 0.9 * sat.hfg,
          segmentLength: dz,
          dt,
          state: { fWet: f, rewetLatched: true },
        }),
      ),
    );
    expect(r.limiter).toBe("supply");
    // INDEPENDENT: the front displacement is j_l·dt smeared by (1−f):
    // df·Δz = (1−f)·j_l·dt — the wetted length cannot grow faster than the
    // liquid inflow covers it.
    const df = r.proposedState.fWet - f;
    const jL = (G * 0.1) / sat.rhof; // χ_l = 0.1
    expect(Math.abs((df * dz) / ((1 - f) * jL * dt) - 1)).toBeLessThan(1e-9);
    // and the wall-energy demand per unit advance stays exactly payable:
    // energy needed for the advance ≤ excess heat extracted during dt
    const TDnb = TSAT() + 2;
    const dEWall = df * dz * WALL_M_PER_L * WALL_CP * (Tw - TDnb);
    const dEHeat = dt * Math.PI * D * Math.max(r.qWet - r.qDry, 0) * dz;
    expect(dEWall).toBeLessThan(dEHeat);
  });

  it("q_bar is a convex combination: no heat appears from nowhere", () => {
    // For positive same-sign component fluxes, (1−f)q_F + f·q_W must lie
    // between them — f is an area fraction, not an energy source.
    for (const Tw of [24, 26, 28, 30, 32]) {
      for (const fWet of [0.13, 0.5, 0.87]) {
        const r = ok(
          evaluateTtWf(baseArgs({ Tw, state: { fWet, rewetLatched: true } })),
        );
        expect(r.qWet).toBeGreaterThan(0);
        const lo = Math.min(r.qDry, r.qWet);
        const hi = Math.max(r.qDry, r.qWet);
        expect(r.qBar).toBeGreaterThanOrEqual(lo);
        expect(r.qBar).toBeLessThanOrEqual(hi);
        // and the weights are exactly the accepted state
        expect(r.wetWeight).toBe(fWet);
        expect(r.dryWeight).toBe(1 - fWet);
      }
    }
  });

  it("the bounded update can never overshoot [0,1] even with dt → ∞", () => {
    const r = ok(
      evaluateTtWf(baseArgs({ Tw: 26, dt: 1e12, segmentLength: 0.01 })),
    );
    expect(r.proposedState.fWet).toBe(1);
    expect(r.fWetClamped).toBe(true);
  });
});

/* =============================================================================
 * E. Continuity (smoothness mandated by documented solver limit cycles)
 * ============================================================================= */
describe("E. continuity", () => {
  it("q_bar(T_w) is continuous with bounded slope through all blend regions", () => {
    const dT = 5e-3;
    const Tlo = TSAT() - 2;
    const Thi = TWET_VAL + 10;
    const n = Math.round((Thi - Tlo) / dT);
    let maxSlope = 0;
    for (const fWet of [0, 0.37, 1]) {
      let prevQ: number | undefined;
      for (let i = 0; i <= n; i++) {
        const Tw = Tlo + i * dT;
        const r = ok(
          evaluateTtWf(baseArgs({ Tw, state: { fWet, rewetLatched: false } })),
        );
        expect(Number.isFinite(r.qBar)).toBe(true);
        if (prevQ !== undefined) {
          const slope = Math.abs(r.qBar - prevQ) / dT;
          if (slope > maxSlope) maxSlope = slope;
        }
        prevQ = r.qBar;
      }
    }
    // Bounded numerical slope: the steepest physical feature is the blended
    // NB cusp near T_sat (≈ 5–6 kW/m²/K at this state; the reverse-slope TB
    // bridge ≈ 1 kW/m²/K).  5e4 W/m²/K is a generous regression tripwire —
    // a hard regime jump (a true discontinuity of size Δq over dT = 5 mK)
    // would read as slope ≥ Δq/0.005 ≈ 2e5·Δq[W/m²].
    expect(maxSlope).toBeLessThan(5e4);
    expect(maxSlope).toBeGreaterThan(0);
  });

  it("q_bar(x_e) is continuous through the IAF ramp and x_a → 1", () => {
    const dxe = 2e-4;
    const Tw = TWET_VAL + 5;
    let prevQ: number | undefined;
    let maxJump = 0;
    for (let xe = 0.8; xe <= 1.2 + 1e-12; xe += dxe) {
      const r = ok(
        evaluateTtWf(
          baseArgs({
            Tw,
            hNode: sat.hf + xe * sat.hfg,
            state: { fWet: 0, rewetLatched: false },
          }),
        ),
      );
      if (prevQ !== undefined)
        maxJump = Math.max(maxJump, Math.abs(r.qBar - prevQ));
      prevQ = r.qBar;
    }
    // relative to the flux scale (~kW/m²), per-step change stays tiny
    expect(maxJump).toBeLessThan(50); // W/m² over Δx_e = 2e-4
  });

  it("h_eff stays finite everywhere across the T_w sweep including T_w = T_node", () => {
    const dT = 2e-3;
    for (let Tw = TSAT() - 0.5; Tw <= TSAT() + 0.5 + 1e-12; Tw += dT) {
      for (const fWet of [0, 1]) {
        const r = ok(
          evaluateTtWf(baseArgs({ Tw, state: { fWet, rewetLatched: true } })),
        );
        expect(Number.isFinite(r.hEff)).toBe(true);
      }
    }
  });
});

/* =============================================================================
 * F. Darr–Hartwig compatibility (reuse, not divergence)
 * ============================================================================= */
describe("F. Darr–Hartwig compatibility", () => {
  it("T_v and x_a match the D-H algebraic closure exactly across qualities", () => {
    for (const xe of [-0.3, 0, 0.05, 0.5, 0.95, 2, 8]) {
      const r = ok(
        evaluateTtWf(
          baseArgs({
            hNode: sat.hf + xe * sat.hfg,
            state: { fWet: 0, rewetLatched: false },
          }),
        ),
      );
      const dh = dhRef(TSAT() + 1, xe);
      expect(r.xa).toBe(dh.xa);
      expect(r.Tv).toBe(dh.Tv);
      expect(r.Twet).toBe(dh.Twet);
      expect(r.TDnb).toBe(dh.TDnb);
    }
  });

  it("f = 0 dry side equals the D-H film map above T_wet (flux AND h_eff)", () => {
    for (const Tw of [TWET_VAL + 1, TWET_VAL + 5, TWET_VAL + 20]) {
      const r = ok(
        evaluateTtWf(baseArgs({ Tw, state: { fWet: 0, rewetLatched: false } })),
      );
      const dh = dhRef(Tw, 0.5);
      expect(r.qBar).toBe(dh.qFlux);
      expect(r.hEff).toBe(dh.hEff);
    }
  });

  it("f = 1 wet side equals the D-H DB/NB/TB map below T_wet (flux AND h_eff)", () => {
    const Tws = [
      TSAT() - 1,
      TSAT() + 1,
      TSAT() + 1.9,
      26,
      28,
      30,
      TWET_VAL - 0.6,
    ];
    for (const Tw of Tws) {
      const r = ok(
        evaluateTtWf(baseArgs({ Tw, state: { fWet: 1, rewetLatched: true } })),
      );
      const dh = dhRef(Tw, 0.5);
      expect(r.qBar).toBe(dh.qFlux);
      expect(r.hEff).toBe(dh.hEff);
    }
  });

  it("two-temperature limits: x_e ≤ 0 ⇒ no superheat; high quality ⇒ T_v ≥ T_b", () => {
    const sub = ok(
      evaluateTtWf(
        baseArgs({
          hNode: sat.hf - 0.2 * sat.hfg, // subcooled liquid
          Tnode: TSAT() - 5,
          Tw: TSAT() + 30,
          state: { fWet: 0, rewetLatched: false },
        }),
      ),
    );
    expect(sub.xa).toBe(0);
    expect(sub.Tv).toBe(sat.Tsat); // x_a = 0 ⇒ Eq. 9 collapses to T_sat
    const hi = ok(
      evaluateTtWf(
        baseArgs({
          hNode: sat.hf + 8 * sat.hfg,
          Tw: TSAT() + 30,
          state: { fWet: 0, rewetLatched: false },
        }),
      ),
    );
    expect(hi.Tv).toBeGreaterThanOrEqual(TSAT()); // T_v ≥ T_b (two-phase node)
    expect(hi.xa).toBeGreaterThan(0.99);
  });
});

/* =============================================================================
 * G. Parameter sensitivity and structural exclusion of solver knobs
 * ============================================================================= */
describe("G. parameter sensitivity", () => {
  it("C_q scales the energy-limited rate and nothing else", () => {
    const mk = (Cq: number) =>
      ok(
        evaluateTtWf(
          baseArgs({
            Tw: 28,
            hNode: sat.hf + 0.05 * sat.hfg,
            segmentLength: 0.01,
            dt: 0.5,
            params: { frontEnergyFactor: Cq },
          }),
        ),
      );
    const r1 = mk(1);
    const r2 = mk(2);
    expect(r1.limiter).toBe("energy");
    expect(r2.rEnergy).toBeCloseTo(2 * r1.rEnergy, 12);
    expect(r2.proposedState.fWet - 0.3).toBeCloseTo(
      2 * (r1.proposedState.fWet - 0.3),
      9,
    );
    // C_q does NOT touch the flux map, the latch, or the liquid ceiling
    expect(r2.qBar).toBe(r1.qBar);
    expect(r2.rLiquid).toBe(r1.rLiquid);
    expect(r2.proposedState.rewetLatched).toBe(r1.proposedState.rewetLatched);
  });

  it("C_q is irrelevant when the supply limiter binds (distinct physics, not collinear)", () => {
    const mk = (Cq: number) =>
      ok(
        evaluateTtWf(
          baseArgs({
            Tw: 28,
            hNode: sat.hf + 0.9 * sat.hfg,
            dt: 0.5,
            params: { frontEnergyFactor: Cq },
          }),
        ),
      );
    const r1 = mk(1);
    const r2 = mk(4);
    expect(r1.limiter).toBe("supply");
    expect(r2.limiter).toBe("supply");
    // equal to ~12 digits (the smoothMin cross-term differs by ~1e-22 — the
    // supply rate simply does not contain C_q)
    expect(r2.proposedState.fWet).toBeCloseTo(r1.proposedState.fWet, 12);
    expect(r2.rFront).toBeCloseTo(r1.rFront, 12);
  });

  it("ΔT_h changes drying hysteresis only — not the flux map or front speed", () => {
    const mk = (dTh: number) =>
      ok(
        evaluateTtWf(
          baseArgs({
            Tw: TWET_VAL + 2.5,
            hNode: sat.hf + 2 * sat.hfg, // dry availability
            state: { fWet: 0.6, rewetLatched: true },
            params: { rewetHysteresisOffsetK: dTh },
          }),
        ),
      );
    const narrow = mk(0); // ΔT_h = 0: 2.5 K above T_wet ⇒ clear
    const wide = mk(5); // ΔT_h = 5: inside the band ⇒ retain
    expect(narrow.proposedState).toEqual({ fWet: 0, rewetLatched: false });
    expect(wide.proposedState).toEqual({ fWet: 0.6, rewetLatched: true });
    // ΔT_h does NOT touch fluxes or rates
    expect(wide.qBar).toBe(narrow.qBar);
    expect(wide.rEnergy).toBe(narrow.rEnergy);
    expect(wide.rFront).toBe(narrow.rFront);
  });

  it("the public parameter type carries exactly the two physical knobs", () => {
    expect(Object.keys(TTWF_DEFAULT_PARAMS).sort()).toEqual([
      "frontEnergyFactor",
      "rewetHysteresisOffsetK",
    ]);
    // unknown keys are dropped (solver numerics cannot be smuggled in)
    const resolved = resolveTtWfParams({
      frontEnergyFactor: 2,
      hRelax: 0.9,
      blendWidth: 3,
      maxIterations: 5,
    } as unknown as Partial<typeof TTWF_DEFAULT_PARAMS>);
    expect(resolved).toEqual({
      frontEnergyFactor: 2,
      rewetHysteresisOffsetK: 2,
    });
    expect(resolveTtWfParams(undefined)).toEqual(TTWF_DEFAULT_PARAMS);
    expect(resolveTtWfParams({})).toEqual(TTWF_DEFAULT_PARAMS);
  });
});

/* =============================================================================
 * Diagnostics mapping + Phase-2 h-map integration
 * ============================================================================= */
describe("diagnostics and Phase-2 h-map integration", () => {
  it("recordTtWfEvaluation maps result flags onto the counters", () => {
    resetSolverDiagnostics();
    // invalid input
    recordTtWfEvaluation(evaluateTtWf(baseArgs({ Tw: -1 })));
    // limiter activations (front actually advances)
    recordTtWfEvaluation(
      evaluateTtWf(
        baseArgs({
          Tw: 28,
          hNode: sat.hf + 0.05 * sat.hfg,
          segmentLength: 0.01,
          dt: 0.5,
        }),
      ),
    ); // energy
    recordTtWfEvaluation(
      evaluateTtWf(
        baseArgs({ Tw: 28, hNode: sat.hf + 0.9 * sat.hfg, dt: 0.5 }),
      ),
    ); // supply
    // fWet clamp (huge dt; this evaluation is ALSO supply-limited)
    recordTtWfEvaluation(
      evaluateTtWf(
        baseArgs({ Tw: 26, hNode: sat.hf + 0.9 * sat.hfg, dt: 1e12 }),
      ),
    );
    const d = getSolverDiagnostics().ttWf;
    expect(d.invalidInputCount).toBe(1);
    expect(d.energyLimiterCount).toBe(1);
    expect(d.supplyLimiterCount).toBe(2);
    expect(d.fWetClampCount).toBe(1);
    // snapshot isolation + reset
    const snap = getSolverDiagnostics();
    snap.ttWf.invalidInputCount = 999;
    expect(getSolverDiagnostics().ttWf.invalidInputCount).toBe(1);
    resetSolverDiagnostics();
    expect(getSolverDiagnostics().ttWf).toEqual({
      fWetClampCount: 0,
      latchSetCount: 0,
      latchClearCount: 0,
      invalidInputCount: 0,
      energyLimiterCount: 0,
      supplyLimiterCount: 0,
      notIntegratedCount: 0,
    });
  });

  it("a ttWf conductor in evaluateConvectionH evaluates the integrated closure (never silent D-H)", () => {
    resetSolverDiagnostics();
    const cond: CorrelationConductor = {
      id: "conv-ttwf",
      from: "A",
      to: "WALL",
      type: {
        kind: "convection",
        area: 0.1,
        correlation: {
          model: "ttWf",
          diameter: D,
          axialPosition: 0.5,
          segmentLength: 1,
        },
      },
    };
    const accepted = { fWet: 0.3, rewetLatched: true };
    const ctx: CorrelationCtx = {
      fluid,
      isRealFluid: true,
      branches: [{ id: "b1", from: "A", to: "B" }],
      nBranch: 1,
      nodeMap: new Map([
        ["A", { id: "A", type: "internal" }],
        ["B", { id: "B", type: "boundary" }],
        ["WALL", { id: "WALL", type: "boundary" }],
      ]),
      ttWf: {
        state: new Map([["conv-ttwf", accepted]]),
        axialPosition: new Map([["conv-ttwf", 0.5]]),
        wall: new Map([["conv-ttwf", wall]]),
        lastSnapshot: new Map(),
      },
    };
    const state: CorrelationState = {
      nodeP: new Map([["A", P]]),
      nodeT: new Map([["A", TSAT()]]),
      nodeH: new Map([["A", sat.hf + 0.5 * sat.hfg]]),
      mdots: [0.01],
      solidT: new Map([["WALL", 40]]),
    };
    const h = evaluateConvectionH(cond, ctx, state);
    // Independent expectation: the pure evaluator at the same local state.
    // G from the documented convention ½·Σ|mdot|/flowArea; L = z − z_qf = 0
    // (the conductor's own accepted latch is set, so it IS the quench front;
    // the evaluator floors L at 0.05 m internally); dt = 0 (flux-only).
    const Gexp = (0.5 * 0.01) / ((Math.PI / 4) * D * D);
    const expected = ok(
      evaluateTtWf(
        baseArgs({
          Tw: 40,
          G: Gexp,
          L: 0,
          ReLin: (Gexp * D) / sat.muf,
          segmentLength: 1,
          dt: 0,
          state: accepted,
        }),
      ),
    );
    expect(h).toBe(expected.hEff);
    expect(h).not.toBe(FALLBACK_H_FLOOR);
    // The Phase-1 guard counter stays at zero forever after integration.
    expect(getSolverDiagnostics().ttWf.notIntegratedCount).toBe(0);
    // …and the frozen accepted state was not mutated by the h-map evaluation.
    expect(ctx.ttWf!.state.get("conv-ttwf")).toBe(accepted);
    resetSolverDiagnostics();
  });

  it("a ttWf conductor without shared state takes the counted loud fallback", () => {
    resetSolverDiagnostics();
    const cond: CorrelationConductor = {
      id: "conv-ttwf",
      from: "A",
      to: "WALL",
      type: {
        kind: "convection",
        area: 0.1,
        correlation: {
          model: "ttWf",
          diameter: D,
          axialPosition: 0.5,
          segmentLength: 1,
        },
      },
    };
    const ctx: CorrelationCtx = {
      fluid,
      isRealFluid: true,
      branches: [{ id: "b1", from: "A", to: "B" }],
      nBranch: 1,
      nodeMap: new Map([
        ["A", { id: "A", type: "internal" }],
        ["B", { id: "B", type: "boundary" }],
        ["WALL", { id: "WALL", type: "boundary" }],
      ]),
    };
    const state: CorrelationState = {
      nodeP: new Map([["A", P]]),
      nodeT: new Map([["A", TSAT()]]),
      nodeH: new Map([["A", sat.hf + 0.5 * sat.hfg]]),
      mdots: [0.01],
      solidT: new Map([["WALL", 40]]),
    };
    const h = evaluateConvectionH(cond, ctx, state);
    expect(h).toBe(FALLBACK_H_FLOOR);
    const d = getSolverDiagnostics().ttWf;
    expect(d.invalidInputCount).toBe(1);
    expect(d.notIntegratedCount).toBe(0);
    resetSolverDiagnostics();
  });
});

/* =============================================================================
 * Schema validation (validate.ts)
 * ============================================================================= */
describe("ttWf schema validation", () => {
  function ttwfConfig(
    corr: Record<string, unknown>,
    mode: "transient" | "steady" = "transient",
  ): NetworkConfig {
    return {
      meta: { name: "ttwf-validate", version: 2 },
      settings:
        mode === "transient"
          ? {
              mode,
              dt: 0.01,
              endTime: 0.02,
              tolerance: 1e-8,
              maxIterations: 50,
            }
          : { mode, tolerance: 1e-8, maxIterations: 50 },
      fluid: { model: "realFluid", params: { fluidName: "ParaHydrogen" } },
      nodes: [
        {
          id: "IN",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 23,
        },
        {
          id: "A",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 2e5,
          temperature: 23,
          volume: 1e-3,
        },
      ],
      solidNodes: [
        {
          id: "W",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 50,
          mass: 0.5,
          cp: 385,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "IN",
          to: "A",
          component: { type: "pipe", length: 1, diameter: D, roughness: 1e-5 },
        },
      ],
      conductors: [
        {
          id: "c1",
          from: "A",
          to: "W",
          type: {
            kind: "convection",
            area: 0.32,
            correlation: { model: "ttWf", diameter: D, ...corr },
          },
        },
      ],
    } as unknown as NetworkConfig;
  }

  it("accepts a well-formed ttWf conductor (params optional)", () => {
    expect(
      validateNetwork(ttwfConfig({ axialPosition: 0.5, segmentLength: 1 })),
    ).toEqual([]);
    expect(
      validateNetwork(
        ttwfConfig({
          axialPosition: 0.5,
          segmentLength: 1,
          frontEnergyFactor: 0.5,
          rewetHysteresisOffsetK: 3,
        }),
      ),
    ).toEqual([]);
  });

  it("requires axialPosition, segmentLength, and transient mode", () => {
    // withDerivedGeometry (geometry.ts) fills missing axialPosition /
    // segmentLength from pipe lengths when the pipe graph is a unique simple
    // path — as ttwfConfig's IN→A graph is.  Branch the graph at A so the
    // derivation cannot apply and the missing fields must be reported.
    const nonDerivable = (corr: Record<string, unknown>): NetworkConfig => {
      const cfg = ttwfConfig(corr);
      cfg.nodes.push(
        {
          id: "B",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 2e5,
          temperature: 23,
          volume: 1e-3,
        } as (typeof cfg.nodes)[number],
        {
          id: "C",
          type: "internal",
          x: 1,
          y: 1,
          pressure: 2e5,
          temperature: 23,
          volume: 1e-3,
        } as (typeof cfg.nodes)[number],
      );
      cfg.branches.push(
        {
          id: "p2",
          from: "A",
          to: "B",
          component: { type: "pipe", length: 1, diameter: D, roughness: 1e-5 },
        },
        {
          id: "p3",
          from: "A",
          to: "C",
          component: { type: "pipe", length: 1, diameter: D, roughness: 1e-5 },
        },
      );
      return cfg;
    };
    expect(
      validateNetwork(nonDerivable({ segmentLength: 1 })).join("\n"),
    ).toMatch(/axialPosition/);
    expect(
      validateNetwork(nonDerivable({ axialPosition: 0.5 })).join("\n"),
    ).toMatch(/segmentLength/);
    expect(
      validateNetwork(
        ttwfConfig({ axialPosition: 0.5, segmentLength: -1 }),
      ).join("\n"),
    ).toMatch(/segmentLength/);
    const steady = validateNetwork(
      ttwfConfig({ axialPosition: 0.5, segmentLength: 1 }, "steady"),
    );
    expect(steady.join("\n")).toMatch(/transient/);
  });

  it("enforces the pre-registered physical bounds", () => {
    const base = { axialPosition: 0.5, segmentLength: 1 };
    expect(
      validateNetwork(ttwfConfig({ ...base, frontEnergyFactor: 0.1 })).join(
        "\n",
      ),
    ).toMatch(/frontEnergyFactor/);
    expect(
      validateNetwork(ttwfConfig({ ...base, frontEnergyFactor: 5 })).join("\n"),
    ).toMatch(/frontEnergyFactor/);
    expect(
      validateNetwork(ttwfConfig({ ...base, rewetHysteresisOffsetK: -1 })).join(
        "\n",
      ),
    ).toMatch(/rewetHysteresisOffsetK/);
    expect(
      validateNetwork(ttwfConfig({ ...base, rewetHysteresisOffsetK: 6 })).join(
        "\n",
      ),
    ).toMatch(/rewetHysteresisOffsetK/);
    // bounds are inclusive at the edges
    expect(
      validateNetwork(
        ttwfConfig({
          ...base,
          frontEnergyFactor: 0.25,
          rewetHysteresisOffsetK: 0,
        }),
      ),
    ).toEqual([]);
    expect(
      validateNetwork(
        ttwfConfig({
          ...base,
          frontEnergyFactor: 4,
          rewetHysteresisOffsetK: 5,
        }),
      ),
    ).toEqual([]);
  });

  it("requires a solid wall endpoint with thermal mass (ambient rejected)", () => {
    const cfg = ttwfConfig({ axialPosition: 0.5, segmentLength: 1 });
    cfg.solidNodes = [
      { id: "W", type: "ambient", x: 1, y: 1, temperature: 50 },
    ];
    expect(validateNetwork(cfg).join("\n")).toMatch(
      /solid.*wall endpoint|wall endpoint/,
    );
  });

  it("requires realFluid (species models are structurally excluded)", () => {
    const cfg = ttwfConfig({ axialPosition: 0.5, segmentLength: 1 });
    cfg.fluid = { model: "incompressible", preset: "water" };
    expect(validateNetwork(cfg).join("\n")).toMatch(/realFluid/);
  });
});
