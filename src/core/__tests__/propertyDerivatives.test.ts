import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { getCoolProp } from "../fluids/coolprop";
import { getSatProps } from "../fluids/realFluid";
import type { SupportedRealFluid } from "../fluids/realFluid";

/**
 * Validation of RealFluid.derivativesPH (analytic ∂ρ/∂P|_h, ∂ρ/∂h|_P,
 * ∂T/∂P|_h, ∂T/∂h|_P) against high-accuracy CENTRAL FINITE DIFFERENCES OF
 * OUR OWN statePH — deliberately NOT against CoolProp's own derivative
 * numbers, which would be circular for the in-dome case (CoolProp's in-dome
 * first_partial_deriv uses a different two-phase convention than our HEM
 * mixture density; see docs/real-fluid-performance.md §3).
 *
 * Coverage per fluid (Nitrogen, NitrousOxide, Water, Hydrogen):
 *   - single-phase liquid (Tsat−10 K), vapor (Tsat+40 K), supercritical
 *   - inside the dome at x = 0.01 / 0.5 / 0.99
 *   - just outside both dome edges (x ≈ ∓0.001)
 *   - exactly on both dome edges (kink convention, one-sided FDs)
 *   - branch consistency vs statePH, input validation, WASM-heap soak
 */

interface FluidFixture {
  name: SupportedRealFluid;
  P: number; // subcritical pressure for liquid/vapor/dome/boundary states
  Psc: number; // supercritical pressure
  fluid: RealFluid;
  Tsat: number;
  hf: number;
  hg: number;
  hLiquid: number;
  hVapor: number;
  hSupercrit: number;
}

// [fluid, subcritical P, supercritical P]
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
      // PropsSI is used only to FIXTURE single-phase h targets from (P, T);
      // every derivative assertion below is against FDs of our own statePH.
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
  console.log(
    "\n[propertyDerivatives] worst relative errors vs FD of statePH:",
  );
  for (const [k, v] of [...worstMargins.entries()].sort()) {
    console.log(`  ${k.padEnd(46)} ${v.toExponential(2)}`);
  }
});

const relErr = (a: number, b: number) =>
  Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

function expectMatchesFD(
  analytic: number,
  fd: number,
  tol: number,
  marginKey: string,
  label: string,
) {
  const rel = relErr(analytic, fd);
  recordMargin(marginKey, rel);
  expect(rel, `${label}: analytic=${analytic} FD=${fd}`).toBeLessThan(tol);
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

function expectAllFourMatchFD(
  f: FluidFixture,
  Ps: number,
  hs: number,
  dP: number,
  dh: number,
  marginKey: string,
) {
  const d = f.fluid.derivativesPH(Ps, hs);
  expectMatchesFD(
    d.drhodP_h,
    centralFD((P) => f.fluid.statePH(P, hs).rho, Ps, dP),
    SMOOTH_TOL,
    marginKey,
    `${marginKey} drhodP_h`,
  );
  expectMatchesFD(
    d.drhodh_P,
    centralFD((h) => f.fluid.statePH(Ps, h).rho, hs, dh),
    SMOOTH_TOL,
    marginKey,
    `${marginKey} drhodh_P`,
  );
  expectMatchesFD(
    d.dTdP_h,
    centralFD((P) => f.fluid.statePH(P, hs).T, Ps, dP),
    SMOOTH_TOL,
    marginKey,
    `${marginKey} dTdP_h`,
  );
  expectMatchesFD(
    d.dTdh_P,
    centralFD((h) => f.fluid.statePH(Ps, h).T, hs, dh),
    SMOOTH_TOL,
    marginKey,
    `${marginKey} dTdh_P`,
  );
  return d;
}

describe("derivativesPH — single-phase liquid / vapor / supercritical", () => {
  // FD steps chosen so FD truncation AND roundoff are both ≪ 1e-6 (measured
  // worst case across the matrix: ~2e-7, Water subcooled liquid ∂T/∂P|_h,
  // whose magnitude is only ~1.7e-7 K/Pa).
  for (const regime of ["liquid", "vapor", "supercritical"] as const) {
    it(`matches central FD of statePH in ${regime} (all four fluids)`, () => {
      for (const f of fixtures) {
        const Ps = regime === "supercritical" ? f.Psc : f.P;
        const hs =
          regime === "liquid"
            ? f.hLiquid
            : regime === "vapor"
              ? f.hVapor
              : f.hSupercrit;
        expect(f.fluid.statePH(Ps, hs).phase).toBe(regime);
        const dP = Ps * 1e-4;
        const dh = Math.max(1e-4 * Math.abs(hs), 10);
        const d = expectAllFourMatchFD(
          f,
          Ps,
          hs,
          dP,
          dh,
          `${f.name}/${regime}`,
        );
        expect(d.phase).toBe(regime);
      }
    });
  }
});

describe("derivativesPH — inside the two-phase dome", () => {
  for (const x of [0.01, 0.5, 0.99]) {
    it(`matches central FD of statePH at x=${x} (all four fluids)`, () => {
      for (const f of fixtures) {
        const { hf, hg } = f;
        const dhfg = hg - hf;
        const h = hf + x * dhfg;
        const st = f.fluid.statePH(f.P, h);
        expect(st.phase).toBe("twoPhase");
        expect(st.quality).toBeCloseTo(x, 12);

        // Small steps: FD truncation is negligible here (measured ≤7e-9);
        // both FD points stay well inside the dome.
        const dP = f.P * 1e-6;
        const dh = Math.max(1e-6 * Math.abs(h), dhfg * 1e-7);
        const key = `${f.name}/dome x=${x}`;
        const d = f.fluid.derivativesPH(f.P, h);
        expect(d.phase).toBe("twoPhase");
        expectMatchesFD(
          d.drhodP_h,
          centralFD((P) => f.fluid.statePH(P, h).rho, f.P, dP),
          SMOOTH_TOL,
          key,
          `${key} drhodP_h`,
        );
        expectMatchesFD(
          d.drhodh_P,
          centralFD((hh) => f.fluid.statePH(f.P, hh).rho, h, dh),
          SMOOTH_TOL,
          key,
          `${key} drhodh_P`,
        );
        expectMatchesFD(
          d.dTdP_h,
          centralFD((P) => f.fluid.statePH(P, h).T, f.P, dP),
          SMOOTH_TOL,
          key,
          `${key} dTdP_h (= dTsat/dP)`,
        );
        // ∂T/∂h|_P ≡ 0 in the dome (T = Tsat(P)); the FD residual is pure
        // roundoff (~1e-12), so assert absolutely rather than relatively.
        const fdDtdh = centralFD((hh) => f.fluid.statePH(f.P, hh).T, h, dh);
        expect(d.dTdh_P).toBe(0);
        expect(Math.abs(fdDtdh)).toBeLessThan(1e-9);
        recordMargin(`${key} dTdh_P (abs FD residual)`, Math.abs(fdDtdh));
      }
    });
  }
});

describe("derivativesPH — just outside the dome boundaries (single-phase side)", () => {
  for (const [side, xFrac] of [
    ["liquid", -1e-3],
    ["vapor", 1 + 1e-3],
  ] as const) {
    it(`matches central FD at x≈${xFrac} on the ${side} side (all four fluids)`, () => {
      for (const f of fixtures) {
        const dhfg = f.hg - f.hf;
        const h = f.hf + xFrac * dhfg;
        expect(f.fluid.statePH(f.P, h).phase).toBe(side);
        // Single-phase steps; both FD points stay single-phase (boundary is
        // ~1e-3·h_fg away in h, and the anchors move ≪ that over ±dP).
        const dP = f.P * 1e-4;
        const dh = Math.max(1e-4 * Math.abs(h), 10);
        const d = expectAllFourMatchFD(
          f,
          f.P,
          h,
          dP,
          dh,
          `${f.name}/just-outside ${side}`,
        );
        expect(d.phase).toBe(side);
      }
    });
  }
});

describe("derivativesPH — saturation-boundary kink convention", () => {
  it("branches twoPhase exactly on both dome edges, consistent with statePH", () => {
    for (const f of fixtures) {
      for (const hE of [f.hf, f.hg]) {
        expect(f.fluid.statePH(f.P, hE).phase).toBe("twoPhase");
        expect(f.fluid.derivativesPH(f.P, hE).phase).toBe("twoPhase");
      }
    }
  });

  it("returns the dome-side one-sided derivative at h=hf and h=hg (the documented kink)", () => {
    // Tolerances are looser than the smooth-regime 1e-6 because one-sided FD
    // stencils are only 2nd-order and the in-dome ρ(h) has large curvature
    // near the edges (worst: Water bubble-point ∂ρ/∂h, stencil error ~1.4e-4).
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
        const d = f.fluid.derivativesPH(f.P, hE);

        // ∂ρ/∂h|_P: dome side is h+δ at the bubble edge, h−δ at the dew edge.
        const fdDomeH = oneSidedFD(
          (h) => f.fluid.statePH(f.P, h).rho,
          hE,
          delta,
          hSide,
        );
        const fdOutH = oneSidedFD(
          (h) => f.fluid.statePH(f.P, h).rho,
          hE,
          delta,
          -hSide as 1 | -1,
        );
        expectMatchesFD(
          d.drhodh_P,
          fdDomeH,
          TOL_H,
          key,
          `${key} drhodh_P dome-side`,
        );
        // The kink is genuine: the single-phase-side slope differs (factor
        // ≥1.4 measured, up to ~2000 with sign flip for Water at bubble).
        expect(relErr(d.drhodh_P, fdOutH)).toBeGreaterThan(0.2);

        // ∂ρ/∂P|_h and ∂T/∂P|_h: which P-side is in-dome depends on the sign
        // of dh_f/dP (bubble) or dh_g/dP (dew — positive for Water at 2 bar!),
        // so detect it from statePH's own phase classification.
        const plusIsDome = f.fluid.statePH(f.P + dP, hE).phase === "twoPhase";
        const minusIsDome = f.fluid.statePH(f.P - dP, hE).phase === "twoPhase";
        expect(plusIsDome !== minusIsDome).toBe(true); // exactly one side is in-dome
        const pSide = (plusIsDome ? 1 : -1) as 1 | -1;
        const fdDomeP = oneSidedFD(
          (P) => f.fluid.statePH(P, hE).rho,
          f.P,
          dP,
          pSide,
        );
        expectMatchesFD(
          d.drhodP_h,
          fdDomeP,
          TOL_P,
          key,
          `${key} drhodP_h dome-side`,
        );
        // Bubble-edge ∂ρ/∂P kink is strong (≥12×) for every fluid — assert it.
        // Dew-edge ∂ρ/∂P kink is weak for some fluids (N₂O ~3e-2, Water ~4e-2),
        // so it is documented but not asserted.
        if (edge.startsWith("bubble")) {
          const fdOutP = oneSidedFD(
            (P) => f.fluid.statePH(P, hE).rho,
            f.P,
            dP,
            -pSide as 1 | -1,
          );
          expect(relErr(d.drhodP_h, fdOutP)).toBeGreaterThan(1);
        }

        // T at the edge: dome convention gives ∂T/∂h|_P = 0 and ∂T/∂P|_h =
        // dTsat/dP; the single-phase side has nonzero ∂T/∂h (kink).
        expect(d.dTdh_P).toBe(0);
        const fdDtdhOut = oneSidedFD(
          (h) => f.fluid.statePH(f.P, h).T,
          hE,
          delta,
          -hSide as 1 | -1,
        );
        expect(Math.abs(fdDtdhOut)).toBeGreaterThan(1e-5);
        const fdDtdpDome = oneSidedFD(
          (P) => f.fluid.statePH(P, hE).T,
          f.P,
          dP,
          pSide,
        );
        expectMatchesFD(
          d.dTdP_h,
          fdDtdpDome,
          TOL_P,
          key,
          `${key} dTdP_h dome-side (= dTsat/dP)`,
        );
        // ∂T/∂P kink at the bubble edge: liquid-side slope is ~100× smaller.
        if (edge.startsWith("bubble")) {
          const fdDtdpOut = oneSidedFD(
            (P) => f.fluid.statePH(P, hE).T,
            f.P,
            dP,
            -pSide as 1 | -1,
          );
          expect(relErr(d.dTdP_h, fdDtdpOut)).toBeGreaterThan(0.5);
        }
      }
    }
  });
});

describe("derivativesPH — branch consistency and input validation", () => {
  it("phase branch matches statePH across a dome-crossing h sweep", () => {
    for (const f of fixtures) {
      const lo = f.hf - 0.05 * (f.hg - f.hf);
      const hi = f.hg + 0.05 * (f.hg - f.hf);
      for (let i = 0; i <= 200; i++) {
        const h = lo + (i / 200) * (hi - lo);
        expect(f.fluid.derivativesPH(f.P, h).phase).toBe(
          f.fluid.statePH(f.P, h).phase,
        );
      }
    }
  });

  it("rejects invalid inputs", () => {
    const f = fixtures[0].fluid;
    expect(() => f.derivativesPH(-1, 0)).toThrow(/Pressure must be positive/);
    expect(() => f.derivativesPH(0, 0)).toThrow(/Pressure must be positive/);
    expect(() => f.derivativesPH(1e6, NaN)).toThrow(/Non-finite/);
    expect(() => f.derivativesPH(Infinity, 1e5)).toThrow(/Non-finite/);
  });
});

describe("derivativesPH — WASM heap robustness (N₂O fragility guard)", () => {
  it("survives a 5000-call soak interleaved with PQ→PT→HmassP sequences", () => {
    // NitrousOxide's HEOS/WASM backend is the historically fragile one
    // (heap corruption after certain PQ→PT→HmassP sequences on a cached
    // AbstractState — see the getState/safeViscosity notes in realFluid.ts).
    // The soak cycles all four fluids × all three derivative regimes and
    // interleaves the solver's own call patterns (dome statePH → PQ updates,
    // density → PT updates) on the same cached states.
    let n = 0;
    for (let i = 0; i < 5000; i++) {
      const f = fixtures[i % fixtures.length];
      const dhfg = f.hg - f.hf;
      switch (i % 3) {
        case 0: {
          // single-phase liquid, drifting h to force fresh HmassP updates
          const d = f.fluid.derivativesPH(f.P, f.hLiquid - (i % 97) * 50);
          expect(Number.isFinite(d.drhodP_h)).toBe(true);
          expect(Number.isFinite(d.drhodh_P)).toBe(true);
          break;
        }
        case 1: {
          // in-dome (PQ-updates + first_saturation_deriv path)
          const d = f.fluid.derivativesPH(f.P, f.hf + 0.37 * dhfg);
          expect(Number.isFinite(d.drhodh_P)).toBe(true);
          break;
        }
        default: {
          const d = f.fluid.derivativesPH(f.Psc, f.hSupercrit + (i % 89) * 100);
          expect(Number.isFinite(d.dTdP_h)).toBe(true);
        }
      }
      if (i % 5 === 0) f.fluid.statePH(f.P, f.hf + 0.63 * dhfg);
      if (i % 11 === 0) f.fluid.density(f.P, f.Tsat + 25);
      n++;
    }
    expect(n).toBe(5000);

    // Post-soak heap sanity: known states still evaluate correctly…
    const n2 = fixtures[0];
    expect(
      Math.abs(n2.fluid.density(101325, 300) - 1.1382) / 1.1382,
    ).toBeLessThan(0.005);
    const h2o = fixtures[2];
    expect(
      Math.abs(h2o.fluid.density(101325, 300) - 996.56) / 996.56,
    ).toBeLessThan(0.005);
    // …and derivatives still validate against FD after the soak (N₂O).
    const n2o = fixtures[1];
    const d = n2o.fluid.derivativesPH(n2o.P, n2o.hVapor);
    const dh = Math.max(1e-4 * Math.abs(n2o.hVapor), 10);
    const fd = centralFD(
      (h) => n2o.fluid.statePH(n2o.P, h).rho,
      n2o.hVapor,
      dh,
    );
    expect(relErr(d.drhodh_P, fd)).toBeLessThan(1e-6);
  });
});
