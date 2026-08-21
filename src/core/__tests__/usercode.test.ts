import { describe, it, expect } from "vitest";
import {
  ExpressionError,
  compileExpression,
  evaluateExpression,
} from "../usercode/expression";
import {
  UserCodeError,
  compileUserComponent,
  compileInlinePressureDrop,
  checkUserCodeSyntax,
} from "../usercode/sandbox";

describe("expression evaluation", () => {
  it("evaluates arithmetic with correct precedence", () => {
    expect(evaluateExpression("1 + 2 * 3")).toBe(7);
    expect(evaluateExpression("(1 + 2) * 3")).toBe(9);
    expect(evaluateExpression("10 % 3")).toBe(1);
    expect(evaluateExpression("2 ^ 3 ^ 2")).toBe(512); // right-assoc
    expect(evaluateExpression("-2 ^ 2")).toBe(-4); // ^ binds tighter than unary
    expect(evaluateExpression("2 ^ -2")).toBe(0.25);
    expect(evaluateExpression("1.5e-3 * 1000")).toBe(1.5);
  });

  it("evaluates comparisons and logic as booleans", () => {
    expect(evaluateExpression("1 < 2")).toBe(true);
    expect(evaluateExpression("2 <= 2")).toBe(true);
    expect(evaluateExpression("3 > 4")).toBe(false);
    expect(evaluateExpression("3 == 3")).toBe(true);
    expect(evaluateExpression("3 != 'a'")).toBe(true);
    expect(evaluateExpression("1 && 0")).toBe(false);
    expect(evaluateExpression("1 || 0")).toBe(true);
    expect(evaluateExpression("!5")).toBe(false);
    expect(evaluateExpression("!'x'")).toBe(false);
  });

  it("evaluates ternary", () => {
    expect(evaluateExpression("1 > 2 ? 10 : 20")).toBe(20);
    expect(evaluateExpression("1 < 2 ? 10 : 20")).toBe(10);
  });

  it("supports builtins", () => {
    expect(evaluateExpression("min(3, 1, 2)")).toBe(1);
    expect(evaluateExpression("max(3, 1, 2)")).toBe(3);
    expect(evaluateExpression("abs(-4)")).toBe(4);
    expect(evaluateExpression("sqrt(16)")).toBe(4);
    expect(evaluateExpression("exp(0)")).toBe(1);
    expect(evaluateExpression("log(exp(2))")).toBeCloseTo(2);
    expect(evaluateExpression("sin(0)")).toBe(0);
    expect(evaluateExpression("cos(0)")).toBe(1);
    expect(evaluateExpression("tanh(0)")).toBe(0);
    expect(evaluateExpression("clamp(5, 0, 3)")).toBe(3);
    expect(evaluateExpression("clamp(-5, 0, 3)")).toBe(0);
    expect(evaluateExpression("smoothstep(0, 1, 0.5)")).toBe(0.5);
    expect(evaluateExpression("smoothstep(0, 1, 2)")).toBe(1);
    expect(evaluateExpression("pi")).toBeCloseTo(Math.PI);
  });

  it("supports scope functions and property access (node/branch/solid/reg/t pattern)", () => {
    const scope = {
      t: 12,
      node: (id: string) => ({ P: id === "n1" ? 101325 : 0, T: 300 }),
      branch: (id: string) => ({ mdot: id === "b1" ? 0.5 : 0 }),
      solid: (id: string) => ({ T: id === "s1" ? 77 : 0 }),
      reg: (name: string) => (name === "gain" ? 2.5 : 0),
    };
    expect(evaluateExpression("node('n1').P", scope)).toBe(101325);
    expect(
      evaluateExpression("branch('b1').mdot * reg('gain')", scope),
    ).toBeCloseTo(1.25);
    expect(evaluateExpression("solid('s1').T < 100 ? t : 0", scope)).toBe(12);
  });

  it("typed compile API coerces results", () => {
    const c = compileExpression("t * 2");
    expect(c.evaluateNumber({ t: 3 })).toBe(6);
    expect(compileExpression("t > 1").evaluateBoolean({ t: 2 })).toBe(true);
    expect(() => compileExpression("'abc'").evaluateNumber()).toThrow(
      ExpressionError,
    );
  });

  it("throws useful parse errors", () => {
    expect(() => compileExpression("")).toThrow(ExpressionError);
    expect(() => compileExpression("1 +")).toThrow(ExpressionError);
    expect(() => compileExpression("1 2")).toThrow(ExpressionError);
    expect(() => compileExpression("'unterminated")).toThrow(ExpressionError);
    try {
      compileExpression("1 +");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionError);
      expect((e as ExpressionError).phase).toBe("parse");
    }
  });

  it("throws useful evaluate errors", () => {
    expect(() => evaluateExpression("nope")).toThrow(/Unknown identifier/);
    expect(() => evaluateExpression("1 + 'a'")).toThrow(/requires numbers/);
    expect(() => evaluateExpression("node('x').P")).toThrow(
      /Unknown identifier/,
    );
    expect(() => evaluateExpression("5(1)")).toThrow(/Attempted to call/);
    expect(() => evaluateExpression("({}).__proto__")).toThrow(ExpressionError);
  });

  it("blocks dangerous property access", () => {
    const scope = { obj: { a: 1 } };
    expect(evaluateExpression("obj.a", scope)).toBe(1);
    expect(() => evaluateExpression("obj.constructor", scope)).toThrow(
      /not allowed/,
    );
    expect(() => evaluateExpression("obj.__proto__", scope)).toThrow(
      /not allowed/,
    );
    expect(() => evaluateExpression("obj.missing", scope)).toThrow(
      /Unknown property/,
    );
  });

  it("short-circuits && and || without evaluating the dead side", () => {
    // The right side would throw (unknown identifier / bad call) if evaluated.
    expect(evaluateExpression("0 && unknownIdent")).toBe(false);
    expect(evaluateExpression("0 && node('n1').P")).toBe(false);
    expect(evaluateExpression("1 || unknownIdent")).toBe(true);
    expect(evaluateExpression("'x' || missingFn(1)")).toBe(true);
    // Live sides still evaluate and results stay booleans.
    expect(evaluateExpression("1 && 2")).toBe(true);
    expect(evaluateExpression("2 && 0")).toBe(false);
    expect(evaluateExpression("0 || 0")).toBe(false);
    expect(evaluateExpression("0 || 3")).toBe(true);
    // Chains: the first deciding operand wins.
    expect(evaluateExpression("1 && 0 && unknownIdent")).toBe(false);
    expect(evaluateExpression("0 || 1 || unknownIdent")).toBe(true);
  });

  it("reads only own properties, not inherited Object/Function members", () => {
    const scope = { obj: { a: 1 }, f: () => 1 };
    expect(evaluateExpression("obj.a", scope)).toBe(1);
    expect(() => evaluateExpression("obj.toString", scope)).toThrow(
      /Unknown property/,
    );
    expect(() => evaluateExpression("obj.hasOwnProperty", scope)).toThrow(
      /Unknown property/,
    );
    expect(() => evaluateExpression("obj.valueOf", scope)).toThrow(
      /Unknown property/,
    );
    // Inherited Function members are unreachable too.
    expect(() => evaluateExpression("f.call", scope)).toThrow(
      /Unknown property/,
    );
    expect(() => evaluateExpression("f.apply", scope)).toThrow(
      /Unknown property/,
    );
    // An own property named like a prototype member still works.
    const ownScope = { obj: JSON.parse('{"toString": 7}') };
    expect(evaluateExpression("obj.toString", ownScope)).toBe(7);
  });
});

describe("defineComponent compiler", () => {
  const src = `
defineComponent({
  metadata: {
    name: 'softCheck',
    label: 'Soft check valve',
    params: [{ name: 'K', default: 12, min: 0 }],
  },
  pressureDrop(args) {
    return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * args.area * args.area);
  },
  heat(args) {
    return args.params.K * args.mdot;
  },
});
`;

  it("compiles and evaluates a defineComponent source", () => {
    const def = compileUserComponent(src, "lib/softCheck");
    expect(def.metadata.name).toBe("softCheck");
    expect(def.metadata.params).toHaveLength(1);
    const dp = def.pressureDrop({
      mdot: 0.5,
      rho: 1000,
      mu: 1e-3,
      t: 0,
      area: 0.01,
      params: { K: 12 },
    });
    expect(dp).toBeCloseTo((12 * 0.5 * 0.5) / (2 * 1000 * 0.01 * 0.01));
    const q = def.heat!({ mdot: 2, Tup: 300, cp: 4180, params: { K: 12 } });
    expect(q).toBe(24);
  });

  it("wraps syntax errors with source id and compile phase", () => {
    try {
      compileUserComponent("defineComponent({", "lib/broken");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UserCodeError);
      expect((e as UserCodeError).sourceId).toBe("lib/broken");
      expect((e as UserCodeError).phase).toBe("compile");
    }
  });

  it("rejects sources that do not define a valid component", () => {
    expect(() => compileUserComponent("const x = 1;", "lib/none")).toThrow(
      /defineComponent/,
    );
    expect(() =>
      compileUserComponent("defineComponent({})", "lib/nometa"),
    ).toThrow(/metadata\.name/);
    expect(() =>
      compileUserComponent(
        "defineComponent({ metadata: { name: 'x' } })",
        "lib/nopd",
      ),
    ).toThrow(/pressureDrop/);
    expect(() =>
      compileUserComponent(
        "defineComponent({ metadata: { name: 'x', params: [{ name: 'a' }] }, pressureDrop() { return 0; } })",
        "lib/badparam",
      ),
    ).toThrow(/finite numeric default/);
  });

  it("wraps define-time throws", () => {
    try {
      compileUserComponent("throw new Error('boom')", "lib/throws");
      expect.unreachable();
    } catch (e) {
      expect((e as UserCodeError).phase).toBe("define");
      expect((e as UserCodeError).message).toContain("boom");
    }
  });

  it("compiles inline pressure-drop bodies", () => {
    const f = compileInlinePressureDrop(
      "return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * args.area * args.area);",
      "inline/k",
    );
    const dp = f({
      mdot: -0.5,
      rho: 1000,
      mu: 1e-3,
      t: 0,
      area: 0.01,
      params: { K: 12 },
    });
    expect(dp).toBeCloseTo(-(12 * 0.25) / (2 * 1000 * 0.0001));
  });

  it("inline compiler rejects non-finite results", () => {
    const f = compileInlinePressureDrop("return 1 / 0;", "inline/inf");
    expect(() => f({ mdot: 1, rho: 1, mu: 1, t: 0, params: {} })).toThrow(
      /finite number/,
    );
    const g = compileInlinePressureDrop("return 'x';", "inline/str");
    expect(() => g({ mdot: 1, rho: 1, mu: 1, t: 0, params: {} })).toThrow(
      UserCodeError,
    );
  });

  it("checkUserCodeSyntax compiles but does not execute", () => {
    expect(
      checkUserCodeSyntax("defineComponent({})", "defineComponent"),
    ).toBeNull();
    expect(checkUserCodeSyntax("return args.mdot;", "inline")).toBeNull();
    expect(checkUserCodeSyntax("return 1 +", "inline")).toMatch(/Unexpected/);
    expect(checkUserCodeSyntax("", "inline")).toMatch(/non-empty/);
    expect(checkUserCodeSyntax(42, "inline")).toMatch(/non-empty/);
    // No-execution: a body that would throw at runtime still passes.
    expect(
      checkUserCodeSyntax("throw new Error('side effect')", "inline"),
    ).toBeNull();
  });
});
