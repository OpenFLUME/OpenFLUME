import { describe, it, expect } from "vitest";
import {
  constant,
  variable,
  add,
  sub,
  mul,
  div,
  pow,
  sqrt,
  abs,
  exp,
  log,
  min,
  max,
  neg,
  tanh,
  sqr,
  value,
  derivative,
} from "../dual";

/** Small tolerance for floating-point comparisons. */
const EPS = 1e-12;

function expectClose(a: number, b: number, tol = EPS) {
  expect(Math.abs(a - b)).toBeLessThan(tol);
}

describe("Dual arithmetic", () => {
  it("constant has zero derivative", () => {
    const c = constant(5);
    expect(c.v).toBe(5);
    expect(c.d).toBe(0);
  });

  it("variable has unit derivative", () => {
    const x = variable(3);
    expect(x.v).toBe(3);
    expect(x.d).toBe(1);
  });

  it("addition", () => {
    const x = variable(2);
    const y = constant(3);
    const z = add(x, y);
    expect(z.v).toBe(5);
    expect(z.d).toBe(1);
  });

  it("subtraction", () => {
    const x = variable(5);
    const z = sub(x, constant(3));
    expect(z.v).toBe(2);
    expect(z.d).toBe(1);
  });

  it("negation", () => {
    const x = variable(4);
    const z = neg(x);
    expect(z.v).toBe(-4);
    expect(z.d).toBe(-1);
  });

  it("multiplication", () => {
    const x = variable(3);
    const z = mul(x, constant(4));
    expect(z.v).toBe(12);
    expect(z.d).toBe(4);
  });

  it("division", () => {
    const x = variable(6);
    const z = div(x, constant(2));
    expect(z.v).toBe(3);
    expect(z.d).toBe(0.5);
  });

  it("power (x^2)", () => {
    const x = variable(3);
    const z = pow(x, constant(2));
    expect(z.v).toBe(9);
    expect(z.d).toBe(6);
  });

  it("power (x^3)", () => {
    const x = variable(2);
    const z = pow(x, constant(3));
    expect(z.v).toBe(8);
    expect(z.d).toBe(12);
  });

  it("sqrt", () => {
    const x = variable(4);
    const z = sqrt(x);
    expect(z.v).toBe(2);
    expect(z.d).toBe(0.25);
  });

  it("exp", () => {
    const x = variable(0);
    const z = exp(x);
    expect(z.v).toBe(1);
    expect(z.d).toBe(1);
  });

  it("log", () => {
    const x = variable(Math.E);
    const z = log(x);
    expect(z.v).toBe(1);
    expectClose(z.d, 1 / Math.E);
  });

  it("sqr", () => {
    const x = variable(5);
    const z = sqr(x);
    expect(z.v).toBe(25);
    expect(z.d).toBe(10);
  });

  it("tanh", () => {
    const x = variable(0);
    const z = tanh(x);
    expect(z.v).toBe(0);
    expect(z.d).toBe(1);
  });
});

describe("Composed expressions", () => {
  it("polynomial 3x^2 + 2x + 1", () => {
    const x = variable(2);
    const z = add(
      add(mul(constant(3), sqr(x)), mul(constant(2), x)),
      constant(1),
    );
    expect(z.v).toBe(17);
    expect(z.d).toBe(14); // 6x + 2 = 14
  });

  it("sqrt(x^2 + 1)", () => {
    const x = variable(3);
    const z = sqrt(add(sqr(x), constant(1)));
    expect(z.v).toBe(Math.sqrt(10));
    expectClose(z.d, 3 / Math.sqrt(10));
  });

  it("exp(-x^2)", () => {
    const x = variable(1);
    const z = exp(neg(sqr(x)));
    expect(z.v).toBe(Math.exp(-1));
    expectClose(z.d, -2 * Math.exp(-1));
  });

  it("division chain x / (x + 1)", () => {
    const x = variable(2);
    const z = div(x, add(x, constant(1)));
    expect(z.v).toBe(2 / 3);
    expectClose(z.d, 1 / 9); // 1/(x+1) - x/(x+1)^2 = 1/9
  });

  it("mixed scalar and dual operands", () => {
    const x = variable(4);
    const z = add(2, mul(3, x)); // 2 + 3x
    expect(z.v).toBe(14);
    expect(z.d).toBe(3);
  });
});

describe("Branch conventions", () => {
  describe("abs", () => {
    it("positive x: derivative = +1", () => {
      const x = variable(3);
      const z = abs(x);
      expect(z.v).toBe(3);
      expect(z.d).toBe(1);
    });

    it("negative x: derivative = -1", () => {
      const x = variable(-3);
      const z = abs(x);
      expect(z.v).toBe(3);
      expect(z.d).toBe(-1);
    });

    it("at zero: derivative = 0 (subgradient convention)", () => {
      const x = variable(0);
      const z = abs(x);
      expect(z.v).toBe(0);
      expect(z.d).toBe(0);
    });

    it("near zero positive: right derivative ≈ +1", () => {
      const x = variable(1e-8);
      const z = abs(x);
      expect(z.d).toBe(1);
    });

    it("near zero negative: left derivative ≈ -1", () => {
      const x = variable(-1e-8);
      const z = abs(x);
      expect(z.d).toBe(-1);
    });
  });

  describe("min", () => {
    it("a < b: picks a derivative", () => {
      const a = variable(1);
      const b = constant(3);
      const z = min(a, b);
      expect(z.v).toBe(1);
      expect(z.d).toBe(1);
    });

    it("a > b: picks b derivative", () => {
      const a = variable(5);
      const b = constant(3);
      const z = min(a, b);
      expect(z.v).toBe(3);
      expect(z.d).toBe(0);
    });

    it("at tie: average subgradient", () => {
      const a = variable(2);
      const b = variable(2);
      const z = min(a, b);
      expect(z.v).toBe(2);
      expect(z.d).toBe(1); // (1 + 1) / 2 = 1
    });

    it("at tie with different slopes: average", () => {
      const a = add(mul(constant(2), variable(1)), constant(0)); // 2x, d=2 at x=1
      const b = add(mul(constant(3), variable(1)), constant(-1)); // 3x-1, d=3 at x=1
      // At x=1: a=2, b=2 (tie)
      const z = min(a, b);
      expect(z.v).toBe(2);
      expect(z.d).toBe(2.5); // (2 + 3) / 2
    });
  });

  describe("max", () => {
    it("a > b: picks a derivative", () => {
      const a = variable(5);
      const b = constant(3);
      const z = max(a, b);
      expect(z.v).toBe(5);
      expect(z.d).toBe(1);
    });

    it("a < b: picks b derivative", () => {
      const a = variable(1);
      const b = constant(3);
      const z = max(a, b);
      expect(z.v).toBe(3);
      expect(z.d).toBe(0);
    });

    it("at tie: average subgradient", () => {
      const a = add(mul(constant(2), variable(1)), constant(0));
      const b = add(mul(constant(3), variable(1)), constant(-1));
      const z = max(a, b);
      expect(z.v).toBe(2);
      expect(z.d).toBe(2.5);
    });
  });
});

describe("value / derivative helpers", () => {
  it("extract from number", () => {
    expect(value(5)).toBe(5);
    expect(derivative(5)).toBe(0);
  });

  it("extract from Dual", () => {
    const d = variable(7);
    expect(value(d)).toBe(7);
    expect(derivative(d)).toBe(1);
  });
});
