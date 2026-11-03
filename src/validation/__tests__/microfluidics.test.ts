/**
 * Published microfluidic network cases (scientific tier — excluded from the
 * fast PR gate in vitest.fast.config.ts, run by `npm run test:all`).
 *
 * Each case is defined once in src/validation/microfluidics.ts and rendered
 * by scripts/microfluidics-validation-report.ts.  Tolerances below reflect
 * what each paper actually provides: a measurement with its error bar, the
 * authors' own model value, or an exact reference computed here.
 */
import { describe, it, expect } from "vitest";
import {
  GUERMONPREZ_2015,
  LEE_2012,
  OLANREWAJU_2016,
  REIS_2021,
  VASILAKIS_2019,
  guermonprezLadder,
  lee2012,
  olanrewaju2016,
  reis2021Flow,
  tanTakeuchi2007,
  vasilakis2019,
} from "../microfluidics";

describe("Vasilakis et al. 2019 — pressure/flow-balanced serial-dilution cell", () => {
  const r = vasilakis2019();
  const pub = VASILAKIS_2019.published;

  it("balances both inlet pressures at the COMSOL value (85.2 Pa at 0.4 µL/min)", () => {
    for (const p of [r.inletPressureA, r.inletPressureB])
      expect(
        Math.abs(p - pub.inletPressureCOMSOL) / pub.inletPressureCOMSOL,
      ).toBeLessThan(0.01);
    // The design goal: equal pressure at both inlets.
    expect(Math.abs(r.inletPressureA - r.inletPressureB)).toBeLessThan(0.2);
  });

  it("produces the 2:3 design dilution ratio, within the measurement accuracy", () => {
    expect(Math.abs(r.ratio - pub.ratioDesign)).toBeLessThan(0.005);
    // The paper judges its measurements against the glucose meter's ±10 %
    // accuracy (§3.2): both measured stage-1 ratios lie inside that band of
    // the model.  By its own SD the 0.4 µL/min point (0.70 ± 0.01) is ~3σ
    // above the design value — reported, not hidden, in the report.
    for (const m of pub.ratioMeasured)
      expect(Math.abs(r.ratio - m.mean)).toBeLessThanOrEqual(0.1 * m.mean);
    const low = pub.ratioMeasured[0];
    expect(Math.abs(r.ratio - low.mean)).toBeLessThanOrEqual(2 * low.sd);
  });
});

describe("Tan & Takeuchi 2007 — hydrodynamic trap design rule", () => {
  it("reproduces Q1/Q2 of both devices and predicts which one traps beads", () => {
    for (const d of tanTakeuchi2007()) {
      expect(Math.abs(d.ratio - d.ratioPaper)).toBeLessThan(0.01);
      expect(d.predictsTrapping).toBe(d.trapped);
    }
  });
});

describe("Guermonprez, Michelin & Baroud 2015 — 20-branch ladder manifold", () => {
  for (const c of GUERMONPREZ_2015.cases) {
    it(`R/R_b = ${c.ratio}: matches the paper's distribution statement and an exact nodal solve`, () => {
      const r = guermonprezLadder(GUERMONPREZ_2015.branches, c.ratio);
      r.fractions.forEach((f, i) =>
        expect(Math.abs(f - r.reference[i])).toBeLessThan(1e-9),
      );
      if (c.endShare !== undefined)
        expect(Math.abs(r.endShare - c.endShare)).toBeLessThan(0.02);
      if (c.maxSpread !== undefined)
        expect(r.spread).toBeLessThanOrEqual(c.maxSpread);
    });
  }
});

describe("Reis et al. 2021 — gravity-driven microcapillary siphon", () => {
  const c = REIS_2021;

  it("equals Hagen–Poiseuille for 10 bores under hydrostatic head", () => {
    const r = reis2021Flow(c.measured.hOverL);
    expect(
      Math.abs(r.solved - r.hagenPoiseuille) / r.hagenPoiseuille,
    ).toBeLessThan(1e-9);
  });

  it("brackets the measured 3.63 µL/s within the stated bore-diameter uncertainty", () => {
    const lo = reis2021Flow(
      c.measured.hOverL,
      c.diameter - c.diameterSd,
    ).solved;
    const hi = reis2021Flow(
      c.measured.hOverL,
      c.diameter + c.diameterSd,
    ).solved;
    expect(lo).toBeLessThan(c.measured.flow);
    expect(hi).toBeGreaterThan(c.measured.flow);
  });

  it("gives ≈2.5 µL/s for the Fig. 2 devices (H = 40 mm, L = 70 mm)", () => {
    const r = reis2021Flow(c.fig2.H / c.fig2.L);
    expect(Math.abs(r.solved - c.fig2.flow) / c.fig2.flow).toBeLessThan(0.1);
  });
});

describe("Olanrewaju et al. 2016 — capillaric-circuit valve and pump pressures", () => {
  const r = olanrewaju2016();

  it("reproduces Table 1 retention-burst-valve pressures with per-wall Young–Laplace", () => {
    for (const v of r.rbv)
      expect(Math.abs(v.solved - v.p) / Math.abs(v.p)).toBeLessThan(0.015);
  });

  it("records that the stated 95° cover angle does not reproduce the paper's own Table 1", () => {
    // A finding about the source, pinned so the report stays honest: 95°
    // under-predicts every tabulated valve by 3–6 %, 89° matches.
    for (const v of r.rbv) {
      const e = Math.abs(v.solvedRbvTextAngle - v.p) / Math.abs(v.p);
      expect(e).toBeGreaterThan(0.03);
      expect(e).toBeLessThan(0.06);
    }
  });

  it("gives the −736 Pa capillary pump within 2 % from the advancing angles", () => {
    expect(
      Math.abs(r.pump.solved - r.pump.p) / Math.abs(r.pump.p),
    ).toBeLessThan(0.02);
    expect(OLANREWAJU_2016.advancing.cover).toBe(114);
  });
});

describe("Lee, Rahman, Laoui & Karnik 2012 — bubble-damped syringe network", () => {
  const maxRel = (r: ReturnType<typeof lee2012>) => {
    let err = 0;
    let scale = 0;
    r.q1.forEach((q, i) => {
      err = Math.max(err, Math.abs(q - r.reference[i]));
      scale = Math.max(scale, Math.abs(r.reference[i]));
    });
    return err / scale;
  };

  it("follows the exact isothermal-bubble ODE for 2, 5 and 10 µL bubbles", () => {
    for (const v of LEE_2012.bubbles)
      expect(maxRel(lee2012(v))).toBeLessThan(2e-3);
  });

  it("does so at the UI default tolerance too (flow-scaled Newton stopping test)", () => {
    expect(maxRel(lee2012(5, 1e-6))).toBeLessThan(2e-3);
  });

  it("collapses the responses onto one curve in t/t0, t0 = V0·R3/P0, as the paper reports", () => {
    const small = lee2012(2);
    const large = lee2012(10);
    expect(small.q1.length).toBe(large.q1.length);
    small.q1.forEach((q, i) =>
      expect(Math.abs(q - large.q1[i]) / small.q1[0]).toBeLessThan(1e-9),
    );
  });
});
