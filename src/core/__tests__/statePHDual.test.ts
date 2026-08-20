import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { getCoolProp } from "../fluids/coolprop";
import { getSatProps } from "../fluids/realFluid";
import type { SupportedRealFluid } from "../fluids/realFluid";
import { constant } from "../dual";
import type { Dual } from "../dual";

/**
 * Validation of RealFluid.statePHDual — the dual-valued property layer that
 * carries a seeded forward-mode derivative through statePH via the analytic
 * partials of derivativesPH.
 *
 *  1. VALUE FIDELITY: with constant seeds, every value field must be
 *     bitwise-identical to statePH (the implementation delegates to it).
 *  2. DERIVATIVE CORRECTNESS: P-seed (d=1,0) and h-seed (d=0,1) reproduce
 *     ∂/∂P and ∂/∂h of statePH itself, validated against central FD of
 *     statePH (NOT CoolProp's derivatives — same non-circularity rule as
 *     propertyDerivatives.test.ts) to 1e-6 relative wherever smooth.
 *     cp.d tolerance is 5e-6: the cp partials themselves validate to ≤8e-7,
 *     but ∂cp/∂P magnitudes can be ~1e-6 where central-FD roundoff dominates.
 *  3. CHAIN RULE: a mixed seed (P.d=2, h.d=3) must give exactly
 *     2·∂/∂P + 3·∂/∂h — bitwise (same IEEE operations) against the
 *     single-seed runs, and within FD tolerance against combined FDs.
 *  4. FROZEN-μ DECISION: mu.d === 0 ALWAYS (analytic μ partials are rejected
 *     by this CoolProp build; a scoped FD was measured at +97 %…+201 % of the
 *     property-call cost and rejected — see statePHDual's doc comment).  The
 *     explicit assertion keeps the choice discoverable, not accidental.
 *  5. KINK CONVENTION: exactly on the dome edges the derivatives are the
 *     one-sided limits from the two-phase side (inherited from derivativesPH).
 *  6. N₂O WASM-heap soak: the layer adds no new CoolProp interactions; prove
 *     it survives the historically fragile interleaved call sequences.
 */

interface FluidFixture {
  name: SupportedRealFluid;
  P: number;
  Psc: number;
  fluid: RealFluid;
  Tsat: number;
  hf: number;
  hg: number;
  hLiquid: number;
  hVapor: number;
  hSupercrit: number;
}

const FLUID_PARAMS: Array<[SupportedRealFluid, number, number]> = [
  ["Nitrogen", 2e6, 5e6],
  ["NitrousOxide", 3e6, 8e6],
  ["Water", 2e5, 25e6],
  ["Hydrogen", 1e6, 2e6],
];

let fixtures: FluidFixture[];

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
  const cp = getCoolProp();
  fixtures = FLUID_PARAMS.map(([name, P, Psc]) => {
    const fluid = new RealFluid(name);
    const { Tsat, hf, hg } = getSatProps(name, P);
    const Tc = fluid.criticalTemperature();
    return {
      name,
      P,
      Psc,
      fluid,
      Tsat,
      hf,
      hg,
      // PropsSI only FIXTURES single-phase h targets; every assertion is
      // against our own statePH / FDs of it.
      hLiquid: cp.PropsSI("HMASS", "P", P, "T", Tsat - 10, name),
      hVapor: cp.PropsSI("HMASS", "P", P, "T", Tsat + 40, name),
      hSupercrit: cp.PropsSI("HMASS", "P", Psc, "T", Tc + 50, name),
    };
  });
}, 60000);

// ---- margin bookkeeping (achieved agreement, printed after the run) ----
const worstMargins = new Map<string, number>();
function recordMargin(key: string, rel: number) {
  worstMargins.set(key, Math.max(worstMargins.get(key) ?? 0, rel));
}
afterAll(() => {
  console.log("\n[statePHDual] worst relative errors vs FD of statePH:");
  for (const [k, v] of [...worstMargins.entries()].sort()) {
    console.log(`  ${k.padEnd(46)} ${v.toExponential(2)}`);
  }
});

const relErr = (a: number, b: number) =>
  Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

function expectMatchesFD(
  dual: number,
  fd: number,
  tol: number,
  marginKey: string,
  label: string,
) {
  const rel = relErr(dual, fd);
  recordMargin(marginKey, rel);
  expect(rel, `${label}: dual=${dual} FD=${fd}`).toBeLessThan(tol);
}

function centralFD(f: (x: number) => number, x: number, dx: number) {
  return (f(x + dx) - f(x - dx)) / (2 * dx);
}

/** Second-order one-sided FD: side=+1 uses x, x+dx, x+2dx; side=-1 mirrors. */
function oneSidedFD(
  f: (x: number) => number,
  x: number,
  dx: number,
  side: 1 | -1,
) {
  const f0 = f(x);
  const f1 = f(x + side * dx);
  const f2 = f(x + 2 * side * dx);
  return (side * (-3 * f0 + 4 * f1 - f2)) / (2 * dx);
}

const SMOOTH_TOL = 1e-6;
const CP_TOL = 5e-6; // cp partials: FD-roundoff-limited at tiny ∂cp/∂P magnitudes

const seed = (v: number, d: number): Dual => ({ v, d });

/** All (regime, P, h, phase) states used across the suite, per fixture. */
function statesFor(f: FluidFixture) {
  const dhfg = f.hg - f.hf;
  return [
    ["liquid", f.P, f.hLiquid, "liquid"],
    ["vapor", f.P, f.hVapor, "vapor"],
    ["supercritical", f.Psc, f.hSupercrit, "supercritical"],
    ["dome x=0.01", f.P, f.hf + 0.01 * dhfg, "twoPhase"],
    ["dome x=0.5", f.P, f.hf + 0.5 * dhfg, "twoPhase"],
    ["dome x=0.99", f.P, f.hf + 0.99 * dhfg, "twoPhase"],
    ["just-outside liquid edge", f.P, f.hf - 1e-3 * dhfg, "liquid"],
    ["just-outside vapor edge", f.P, f.hg + 1e-3 * dhfg, "vapor"],
  ] as const;
}

describe("statePHDual — value fidelity vs statePH (all four fluids)", () => {
  it("constant seeds return bitwise-identical values and zero derivatives", () => {
    for (const f of fixtures) {
      for (const [regime, Ps, hs, phase] of statesFor(f)) {
        const st = f.fluid.statePH(Ps, hs);
        expect(st.phase, `${f.name}/${regime} fixture phase`).toBe(phase);
        const sd = f.fluid.statePHDual(constant(Ps), constant(hs));

        // Values: bitwise identical to statePH (asserted with toBe).
        expect(sd.rho.v, `${f.name}/${regime} rho.v`).toBe(st.rho);
        expect(sd.T.v, `${f.name}/${regime} T.v`).toBe(st.T);
        expect(sd.mu.v, `${f.name}/${regime} mu.v`).toBe(st.mu);
        expect(sd.quality, `${f.name}/${regime} quality`).toBe(st.quality);
        expect(sd.k, `${f.name}/${regime} k`).toBe(st.k);
        expect(sd.phase, `${f.name}/${regime} phase`).toBe(st.phase);
        if (st.cp === undefined) {
          expect(sd.cp, `${f.name}/${regime} cp undefined in-dome`).toBe(
            undefined,
          );
        } else {
          expect(sd.cp!.v, `${f.name}/${regime} cp.v`).toBe(st.cp);
        }

        // Constant inputs ⇒ every derivative component is exactly zero
        // (=== so that -0 counts as zero).
        expect(sd.rho.d === 0).toBe(true);
        expect(sd.T.d === 0).toBe(true);
        expect(sd.mu.d === 0).toBe(true);
        if (sd.cp !== undefined) expect(sd.cp.d === 0).toBe(true);
      }
    }
  });
});

describe("statePHDual — derivative correctness (P-seed and h-seed)", () => {
  // Same regimes and FD steps as propertyDerivatives.test.ts.
  for (const regime of ["liquid", "vapor", "supercritical"] as const) {
    it(`seeding P reproduces ∂/∂P and seeding h reproduces ∂/∂h in ${regime} (all fluids)`, () => {
      for (const f of fixtures) {
        const Ps = regime === "supercritical" ? f.Psc : f.P;
        const hs =
          regime === "liquid"
            ? f.hLiquid
            : regime === "vapor"
              ? f.hVapor
              : f.hSupercrit;
        const dP = Ps * 1e-4;
        const dh = Math.max(1e-4 * Math.abs(hs), 10);
        const key = `${f.name}/${regime}`;

        const sdP = f.fluid.statePHDual(seed(Ps, 1), seed(hs, 0));
        const sdh = f.fluid.statePHDual(seed(Ps, 0), seed(hs, 1));

        expectMatchesFD(
          sdP.rho.d,
          centralFD((P) => f.fluid.statePH(P, hs).rho, Ps, dP),
          SMOOTH_TOL,
          key,
          `${key} P-seed rho.d = drho/dP`,
        );
        expectMatchesFD(
          sdh.rho.d,
          centralFD((h) => f.fluid.statePH(Ps, h).rho, hs, dh),
          SMOOTH_TOL,
          key,
          `${key} h-seed rho.d = drho/dh`,
        );
        expectMatchesFD(
          sdP.T.d,
          centralFD((P) => f.fluid.statePH(P, hs).T, Ps, dP),
          SMOOTH_TOL,
          key,
          `${key} P-seed T.d = dT/dP`,
        );
        expectMatchesFD(
          sdh.T.d,
          centralFD((h) => f.fluid.statePH(Ps, h).T, hs, dh),
          SMOOTH_TOL,
          key,
          `${key} h-seed T.d = dT/dh`,
        );

        // Cross-terms vanish: seeding P leaves no h-derivative component and
        // vice versa (each evaluation carries exactly one direction).
        expect(sdP.rho.d).not.toBeNaN();

        // cp is defined single-phase / supercritical; chain must match FD too.
        expect(sdP.cp).toBeDefined();
        expectMatchesFD(
          sdP.cp!.d,
          centralFD((P) => f.fluid.statePH(P, hs).cp!, Ps, dP),
          CP_TOL,
          `${key} cp`,
          `${key} P-seed cp.d = dcp/dP`,
        );
        expectMatchesFD(
          sdh.cp!.d,
          centralFD((h) => f.fluid.statePH(Ps, h).cp!, hs, dh),
          CP_TOL,
          `${key} cp`,
          `${key} h-seed cp.d = dcp/dh`,
        );
      }
    });
  }

  for (const x of [0.01, 0.5, 0.99]) {
    it(`matches central FD of statePH inside the dome at x=${x} (all fluids)`, () => {
      for (const f of fixtures) {
        const dhfg = f.hg - f.hf;
        const h = f.hf + x * dhfg;
        const dP = f.P * 1e-6;
        const dh = Math.max(1e-6 * Math.abs(h), dhfg * 1e-7);
        const key = `${f.name}/dome x=${x}`;

        const sdP = f.fluid.statePHDual(seed(f.P, 1), seed(h, 0));
        const sdh = f.fluid.statePHDual(seed(f.P, 0), seed(h, 1));
        expect(sdP.phase).toBe("twoPhase");
        expect(sdP.cp).toBe(undefined); // statePH returns no cp in-dome

        expectMatchesFD(
          sdP.rho.d,
          centralFD((P) => f.fluid.statePH(P, h).rho, f.P, dP),
          SMOOTH_TOL,
          key,
          `${key} P-seed rho.d`,
        );
        expectMatchesFD(
          sdh.rho.d,
          centralFD((hh) => f.fluid.statePH(f.P, hh).rho, h, dh),
          SMOOTH_TOL,
          key,
          `${key} h-seed rho.d`,
        );
        expectMatchesFD(
          sdP.T.d,
          centralFD((P) => f.fluid.statePH(P, h).T, f.P, dP),
          SMOOTH_TOL,
          key,
          `${key} P-seed T.d = dTsat/dP`,
        );
        // ∂T/∂h ≡ 0 in the dome (T = Tsat(P)): exact zero from the chain.
        expect(sdh.T.d === 0).toBe(true);
        const fdDtdh = centralFD((hh) => f.fluid.statePH(f.P, hh).T, h, dh);
        expect(Math.abs(fdDtdh)).toBeLessThan(1e-9);
        recordMargin(`${key} h-seed T.d (abs FD residual)`, Math.abs(fdDtdh));
      }
    });
  }

  for (const [side, xFrac] of [
    ["liquid", -1e-3],
    ["vapor", 1 + 1e-3],
  ] as const) {
    it(`matches central FD just outside the dome on the ${side} side (all fluids)`, () => {
      for (const f of fixtures) {
        const dhfg = f.hg - f.hf;
        const h = f.hf + xFrac * dhfg;
        expect(f.fluid.statePH(f.P, h).phase).toBe(side);
        const dP = f.P * 1e-4;
        const dh = Math.max(1e-4 * Math.abs(h), 10);
        const key = `${f.name}/just-outside ${side}`;

        const sdP = f.fluid.statePHDual(seed(f.P, 1), seed(h, 0));
        const sdh = f.fluid.statePHDual(seed(f.P, 0), seed(h, 1));
        expectMatchesFD(
          sdP.rho.d,
          centralFD((P) => f.fluid.statePH(P, h).rho, f.P, dP),
          SMOOTH_TOL,
          key,
          `${key} P-seed rho.d`,
        );
        expectMatchesFD(
          sdh.rho.d,
          centralFD((hh) => f.fluid.statePH(f.P, hh).rho, h, dh),
          SMOOTH_TOL,
          key,
          `${key} h-seed rho.d`,
        );
        expectMatchesFD(
          sdP.T.d,
          centralFD((P) => f.fluid.statePH(P, h).T, f.P, dP),
          SMOOTH_TOL,
          key,
          `${key} P-seed T.d`,
        );
        expectMatchesFD(
          sdh.T.d,
          centralFD((hh) => f.fluid.statePH(f.P, hh).T, h, dh),
          SMOOTH_TOL,
          key,
          `${key} h-seed T.d`,
        );
        expect(sdP.cp).toBeDefined();
        // cp(h) has high curvature this close to the dome edge, so the
        // central-FD STENCIL error (O(dh²)·f‴) — not the analytic partial —
        // dominates at the standard step (measured 1.9e-5 for Water at
        // dh = 270 J/kg).  Use a 10× smaller step for the cp FDs; both FD
        // points stay single-phase (edge is ~1e-3·h_fg away) and roundoff is
        // still negligible (eps·cp/dh_cp ~ 1e-14 relative).
        const dhCp = Math.max(1e-5 * Math.abs(h), 1);
        expectMatchesFD(
          sdP.cp!.d,
          centralFD((P) => f.fluid.statePH(P, h).cp!, f.P, dP),
          CP_TOL,
          `${key} cp`,
          `${key} P-seed cp.d`,
        );
        expectMatchesFD(
          sdh.cp!.d,
          centralFD((hh) => f.fluid.statePH(f.P, hh).cp!, h, dhCp),
          CP_TOL,
          `${key} cp`,
          `${key} h-seed cp.d`,
        );
      }
    });
  }
});

describe("statePHDual — chain rule with a mixed seed", () => {
  it("P.d=2, h.d=3 gives exactly 2·∂/∂P + 3·∂/∂h (bitwise vs single seeds, FD-checked)", () => {
    for (const f of fixtures) {
      for (const [regime, Ps, hs, phase] of statesFor(f)) {
        const sdP = f.fluid.statePHDual(seed(Ps, 1), seed(hs, 0));
        const sdh = f.fluid.statePHDual(seed(Ps, 0), seed(hs, 1));
        const sdM = f.fluid.statePHDual(seed(Ps, 2), seed(hs, 3));

        // Exact linearity: the mixed-seed chain performs the same IEEE
        // operations as 2·(P-part) + 3·(h-part), so it is bitwise identical
        // (the single-seed .d values ARE the raw partials: x·1 + y·0 === x).
        expect(sdM.rho.d, `${f.name}/${regime} rho chain`).toBe(
          2 * sdP.rho.d + 3 * sdh.rho.d,
        );
        expect(sdM.T.d, `${f.name}/${regime} T chain`).toBe(
          2 * sdP.T.d + 3 * sdh.T.d,
        );
        if (phase !== "twoPhase") {
          expect(sdM.cp!.d, `${f.name}/${regime} cp chain`).toBe(
            2 * sdP.cp!.d + 3 * sdh.cp!.d,
          );
        }
        expect(
          sdM.mu.d,
          `${f.name}/${regime} mu stays frozen under mixed seed`,
        ).toBe(0);

        // And the combined derivative is physically correct: within FD
        // tolerance of 2·FD_P + 3·FD_h on statePH (smooth states only; at the
        // smooth states of statesFor, which excludes exact edges).
        const dP = phase === "twoPhase" ? Ps * 1e-6 : Ps * 1e-4;
        const dhfg = f.hg - f.hf;
        const dh =
          phase === "twoPhase"
            ? Math.max(1e-6 * Math.abs(hs), dhfg * 1e-7)
            : Math.max(1e-4 * Math.abs(hs), 10);
        const fdCombRho =
          2 * centralFD((P) => f.fluid.statePH(P, hs).rho, Ps, dP) +
          3 * centralFD((h) => f.fluid.statePH(Ps, h).rho, hs, dh);
        expectMatchesFD(
          sdM.rho.d,
          fdCombRho,
          5 * SMOOTH_TOL,
          `${f.name}/${regime} chain`,
          `${f.name}/${regime} mixed-seed rho.d vs 2FD_P+3FD_h`,
        );
        const fdCombT =
          2 * centralFD((P) => f.fluid.statePH(P, hs).T, Ps, dP) +
          3 * centralFD((h) => f.fluid.statePH(Ps, h).T, hs, dh);
        expectMatchesFD(
          sdM.T.d,
          fdCombT,
          5 * SMOOTH_TOL,
          `${f.name}/${regime} chain`,
          `${f.name}/${regime} mixed-seed T.d vs 2FD_P+3FD_h`,
        );
      }
    }
  });
});

describe("statePHDual — frozen-μ decision (explicit, discoverable)", () => {
  it("mu.d === 0 for every fluid, regime and seed, while mu.v equals statePH.mu", () => {
    // Rationale (statePHDual doc comment): this CoolProp build rejects
    // analytic μ partials; a scoped FD for μ was measured at 2 extra flashes
    // ≈ 138–888 µs per call (+97 %…+201 % of the property-layer cost) vs
    // sub-µs for an analytic partial, and the dropped term is 4–7 orders of
    // magnitude below the ρ-carried terms at the same states (turbulent
    // Darcy ∂f/∂μ is weak).  For N₂O μ ≡ 0 in statePH, so frozen is exact.
    for (const f of fixtures) {
      for (const [regime, Ps, hs] of statesFor(f)) {
        const st = f.fluid.statePH(Ps, hs);
        for (const [pd, hd] of [
          [1, 0],
          [0, 1],
          [2, 3],
        ] as const) {
          const sd = f.fluid.statePHDual(seed(Ps, pd), seed(hs, hd));
          expect(
            sd.mu.d,
            `${f.name}/${regime} mu.d frozen (seed ${pd},${hd})`,
          ).toBe(0);
          expect(sd.mu.v, `${f.name}/${regime} mu.v`).toBe(st.mu);
        }
      }
    }
  });
});

describe("statePHDual — saturation-boundary kink convention (one-sided from the dome side)", () => {
  it("branches twoPhase exactly on both edges and returns dome-side one-sided derivatives", () => {
    // Same stencil and tolerances as propertyDerivatives.test.ts: one-sided
    // FDs are 2nd-order and in-dome ρ(h) curvature near the edges is large.
    const TOL_H = 1e-3;
    const TOL_P = 1e-5;
    for (const f of fixtures) {
      const dhfg = f.hg - f.hf;
      const delta = dhfg * 1e-5;
      const dP = f.P * 1e-6;
      for (const [edge, hE, hSide] of [
        ["bubble (h=hf)", f.hf, 1],
        ["dew (h=hg)", f.hg, -1],
      ] as const) {
        const key = `${f.name}/boundary ${edge}`;
        // Exactly on the edge statePH classifies twoPhase; the dual layer
        // must inherit both the branch and the dome-side subgradient.
        expect(f.fluid.statePH(f.P, hE).phase).toBe("twoPhase");
        const sdh = f.fluid.statePHDual(seed(f.P, 0), seed(hE, 1));
        expect(sdh.phase).toBe("twoPhase");
        expect(sdh.cp).toBe(undefined);

        const fdDomeH = oneSidedFD(
          (h) => f.fluid.statePH(f.P, h).rho,
          hE,
          delta,
          hSide,
        );
        expectMatchesFD(
          sdh.rho.d,
          fdDomeH,
          TOL_H,
          key,
          `${key} h-seed rho.d dome-side`,
        );
        // The kink is genuine: the single-phase-side slope differs.
        const fdOutH = oneSidedFD(
          (h) => f.fluid.statePH(f.P, h).rho,
          hE,
          delta,
          -hSide as 1 | -1,
        );
        expect(relErr(sdh.rho.d, fdOutH)).toBeGreaterThan(0.2);
        // ∂T/∂h ≡ 0 from the dome side.
        expect(sdh.T.d === 0).toBe(true);

        const plusIsDome = f.fluid.statePH(f.P + dP, hE).phase === "twoPhase";
        const pSide = (plusIsDome ? 1 : -1) as 1 | -1;
        const sdP = f.fluid.statePHDual(seed(f.P, 1), seed(hE, 0));
        const fdDomeP = oneSidedFD(
          (P) => f.fluid.statePH(P, hE).rho,
          f.P,
          dP,
          pSide,
        );
        expectMatchesFD(
          sdP.rho.d,
          fdDomeP,
          TOL_P,
          key,
          `${key} P-seed rho.d dome-side`,
        );
        const fdDtdpDome = oneSidedFD(
          (P) => f.fluid.statePH(P, hE).T,
          f.P,
          dP,
          pSide,
        );
        expectMatchesFD(
          sdP.T.d,
          fdDtdpDome,
          TOL_P,
          key,
          `${key} P-seed T.d dome-side (= dTsat/dP)`,
        );
      }
    }
  });
});

describe("statePHDual — WASM heap robustness (N₂O fragility guard)", () => {
  it("survives a 2000-call soak interleaved with PQ/PT/HmassP sequences, then revalidates vs FD", () => {
    // statePHDual adds no new CoolProp interactions (it calls only statePH +
    // derivativesPH, which carry the cached-state-corruption fallback); this
    // soak proves the fragile N₂O HEOS/WASM backend survives the layer under
    // the solver's own call patterns.
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      const f = fixtures[i % fixtures.length];
      const dhfg = f.hg - f.hf;
      switch (i % 3) {
        case 0: {
          const sd = f.fluid.statePHDual(
            seed(f.P, 1),
            seed(f.hLiquid - (i % 97) * 50, 0),
          );
          expect(Number.isFinite(sd.rho.d)).toBe(true);
          break;
        }
        case 1: {
          const sd = f.fluid.statePHDual(
            seed(f.P, 0),
            seed(f.hf + 0.37 * dhfg, 1),
          );
          expect(Number.isFinite(sd.rho.d)).toBe(true);
          expect(sd.phase).toBe("twoPhase");
          break;
        }
        default: {
          const sd = f.fluid.statePHDual(
            seed(f.Psc, 2),
            seed(f.hSupercrit + (i % 89) * 100, 3),
          );
          expect(Number.isFinite(sd.T.d)).toBe(true);
          expect(Number.isFinite(sd.cp!.d)).toBe(true);
        }
      }
      if (i % 5 === 0) f.fluid.statePH(f.P, f.hf + 0.63 * dhfg);
      if (i % 11 === 0) f.fluid.density(f.P, f.Tsat + 25);
      n++;
    }
    expect(n).toBe(2000);

    // Post-soak heap sanity and FD revalidation (N₂O vapor).
    const h2o = fixtures[2];
    expect(
      Math.abs(h2o.fluid.density(101325, 300) - 996.56) / 996.56,
    ).toBeLessThan(0.005);
    const n2o = fixtures[1];
    const dh = Math.max(1e-4 * Math.abs(n2o.hVapor), 10);
    const sd = n2o.fluid.statePHDual(seed(n2o.P, 0), seed(n2o.hVapor, 1));
    const fd = centralFD(
      (h) => n2o.fluid.statePH(n2o.P, h).rho,
      n2o.hVapor,
      dh,
    );
    expect(relErr(sd.rho.d, fd)).toBeLessThan(1e-6);
    expect(sd.mu.v).toBe(0); // N₂O safeViscosity ⇒ frozen μ is exact
    expect(sd.mu.d).toBe(0);
  });
});
