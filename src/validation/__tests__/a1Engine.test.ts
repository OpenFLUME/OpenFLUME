/**
 * SP-125 A-1 engine balance case (docs/validation/engine-balance-protocol.md).
 * One baseline solve at 7000 rpm and one nested balance on the shaft speed
 * (about 6 s in all).  Gates are about 1.5 times the error measured when the
 * case was first run.  Measured values at that run, model against the book
 *
 *   baseline at 7000 rpm: balance residual +209 bhp (+0.77 % of the turbine
 *   power), turbine power +0.17 %, injector end pressure +1.22 %, Pc +1.22 %,
 *   c* +2.16 %, chamber oxidizer flow -0.97 %, gas generator pressure +0.17 %
 *   balanced: shaft speed 7032.6 rpm (+0.47 %), residual below 1e-6 of the
 *   turbine power, turbine power +0.87 %, injector end pressure +1.88 %
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Orifice } from "../../core/components/orifice";
import {
  A1,
  BOOK,
  LB,
  PSI,
  a1Metrics,
  balanceA1,
  pumpCurve,
  solveA1,
  turbineArea,
  turbinePowerHp,
} from "../a1Engine";

const pctErr = (model: number, book: number): number =>
  Math.abs(100 * (model / book - 1));

describe("A-1 engine data and sizing", () => {
  it("the printed pressure budgets close", () => {
    expect(1505 - 25 - 35 - 150 - 200).toBe(1095);
    expect(1720 - 10 - 15 - 110 - 290 - 200).toBe(1095);
    expect(1505 - 25 - 25 - 615 - 10 - 120).toBe(710);
    expect(1720 - 25 - 25 - 800 - 20 - 140).toBe(710);
  });

  it("the book power equations reproduce the printed turbine power", () => {
    const hp = turbinePowerHp(92 * LB, 640 / 27);
    expect(pctErr(hp, BOOK.turbineHp)).toBeLessThan(0.15);
  });

  it("the turbine orifice passes 92 lb/s at the printed inlet state", () => {
    const o = new Orifice(turbineArea(A1.turbineR), 1);
    const m = o.massFlow(
      640 * PSI,
      27 * PSI,
      A1.turbineT,
      A1.turbineR,
      A1.turbineGamma,
    );
    expect(m / LB).toBeCloseTo(92, 6);
  });

  it("the pump curve passes through its design point and scales by affinity", () => {
    const q = 1;
    const rise = 1e7;
    const c1 = pumpCurve(q, rise, 1, 1.2);
    const c2 = pumpCurve(q, rise, 1.1, 1.2);
    const at = (c: Array<[number, number]>, x: number) =>
      c.find((p) => Math.abs(p[0] - x) < 1e-12)?.[1];
    expect(at(c1, 1)).toBeCloseTo(rise, 6);
    expect(at(c2, 1.1)).toBeCloseTo(rise * 1.21, 4);
  });
});

describe("A-1 engine balance", () => {
  let base: ReturnType<typeof a1Metrics>;
  let bal: ReturnType<typeof balanceA1>;
  let m: ReturnType<typeof a1Metrics>;
  beforeAll(() => {
    base = a1Metrics(solveA1());
    bal = balanceA1("speed");
    m = bal.metrics;
  });

  it("the baseline station pressures, flows and chamber stay near the book", () => {
    expect(pctErr(base.injectorEnd, BOOK.injectorEnd)).toBeLessThan(1.85);
    expect(pctErr(base.pc, BOOK.pc)).toBeLessThan(1.85);
    expect(pctErr(base.cstar, BOOK.cstar)).toBeLessThan(3.3);
    expect(pctErr(base.mdotOx, BOOK.mdotOx)).toBeLessThan(1.5);
    expect(pctErr(base.mdotFuel, BOOK.mdotFuel)).toBeLessThan(1.2);
    expect(pctErr(base.lox.pump, 1505)).toBeLessThan(0.6);
    expect(pctErr(base.fuel.pump, 1720)).toBeLessThan(0.4);
    expect(pctErr(base.ggInjectorEnd, BOOK.ggInjectorEnd)).toBeLessThan(0.3);
    expect(pctErr(base.turbineHp, BOOK.turbineHp)).toBeLessThan(0.3);
  });

  it("the balance residual at 7000 rpm is an output of about 0.8 percent", () => {
    expect(Math.abs(base.residualFraction)).toBeLessThan(0.0116);
    expect(base.residualFraction).toBeGreaterThan(0.003);
  });

  it("the inner loop closes the gas generator flow onto the turbine flow", () => {
    expect(Math.abs(base.ggOx + base.ggFuel - base.turbineMdot)).toBeLessThan(
      1e-6,
    );
  });

  it("the outer iteration closes the balance at a shaft speed near 7000 rpm", () => {
    expect(Math.abs(m.residualFraction)).toBeLessThan(1e-6);
    expect(pctErr(m.rpm, BOOK.rpm)).toBeLessThan(0.7);
    expect(pctErr(m.turbineHp, BOOK.turbineHp)).toBeLessThan(1.3);
    expect(pctErr(m.injectorEnd, BOOK.injectorEnd)).toBeLessThan(2.85);
    expect(bal.iterations).toBeLessThan(10);
  });
});
