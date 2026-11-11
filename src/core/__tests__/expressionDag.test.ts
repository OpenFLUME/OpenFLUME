/**
 * Shared-subexpression (hash-consed DAG) evaluation behind
 * compileExpression (usercode/expression.ts).
 *
 * Pins, without timing:
 *   • bit-identical results to the reference tree walk (evaluateAst) —
 *     values, booleans/strings, and thrown errors — over generated
 *     expressions with heavy repetition;
 *   • the work bound that makes large generated correlations fast: each
 *     distinct identifier is read from the scope ONCE per evaluation, however
 *     often it occurs (the 1 MB chilldown h-expression has ~100× repetition);
 *   • memoization never crosses a scope-provided (possibly side-effecting)
 *     call, never crosses evaluations, and short-circuiting is preserved.
 */
import { describe, expect, it } from "vitest";
import {
  compileExpression,
  evaluateAst,
  ExpressionError,
  type ExprScope,
} from "../usercode/expression";

/** Scope whose identifier reads are counted (getters are own properties,
 *  so the evaluator's hasOwnProperty check sees them). */
function countingScope(values: Record<string, number>): {
  scope: ExprScope;
  reads: Map<string, number>;
} {
  const reads = new Map<string, number>();
  const scope: ExprScope = {};
  for (const [k, v] of Object.entries(values)) {
    Object.defineProperty(scope, k, {
      enumerable: true,
      get: () => {
        reads.set(k, (reads.get(k) ?? 0) + 1);
        return v;
      },
    });
  }
  return { scope, reads };
}

/** Horner polynomial in the normalised log-pressure, like the fitted
 *  saturation curves inside the generated chilldown correlations. */
function horner(coeffs: number[]): string {
  const xi = "((log(clamp(P, 80000.0, 1500000.0)) - 12.75) / 1.46)";
  let s = String(coeffs[0]);
  for (let i = 1; i < coeffs.length; i++) s = `((${s} * ${xi}) + ${coeffs[i]})`;
  return s;
}

function generated(): string {
  const rhoSat = `exp(${horner([0.0017, 0.0028, 0.0016, 0.004, 0.0119, 1.39, 2.67])})`;
  const tSat = `(1.0 / ${horner([9.4e-7, 3.6e-6, 9.7e-6, -1.2e-5, 0.0119])})`;
  const liquid =
    `((Tw - ${tSat}) > 24 ? (0.023 * (max((G * D) / mu, 1e-6) ^ 0.8) * k / D) * ` +
    `exp(${horner([0.027, -0.013, -0.079, 0.038])}) : ` +
    `(3.66 + clamp(((G * D / mu) - 2000) / 2000, 0, 1) * (Tw - ${tSat})) * k / D)`;
  return `((rho < (${rhoSat} * 0.9998)) ? (3.66 * k / D) : ${liquid}) + 0 * ${tSat}`;
}

function outcome(f: () => unknown): unknown {
  try {
    return f();
  } catch (e) {
    return e instanceof ExpressionError ? `ERR:${e.message}` : e;
  }
}

describe("compileExpression shared-subexpression evaluation", () => {
  it("is bit-identical to the reference tree walk", () => {
    const src = generated();
    const ce = compileExpression(src);
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 500; i++) {
      const scope: ExprScope = {
        P: 1e5 + rnd() * 5e5,
        rho: rnd() < 0.4 ? 2 + rnd() * 20 : 600 + rnd() * 200,
        Tw: 78 + rnd() * 220,
        G: rnd() * 200,
        D: 0.0102,
        mu: 1e-5 + rnd() * 2e-4,
        k: 0.01 + rnd() * 0.12,
      };
      const a = ce.evaluateNumber(scope);
      const b = evaluateAst(ce.ast, scope);
      expect(Object.is(a, b)).toBe(true);
    }
  });

  it("matches the tree walk on mixed-type, short-circuit and error cases", () => {
    const cases: Array<[string, ExprScope]> = [
      ["(x > 1 && y) || (x > 1 && y)", { x: 2, y: 0 }],
      ["x > 1 ? 'a' : 'b'", { x: 0 }],
      ["(x == 'n') + 0", { x: "n" }],
      ["x > 0 || missing", { x: 1 }], // short-circuit: never reads `missing`
      ["x > 0 ? 1 : missing", { x: 1 }],
      ["(missing + 1) * (missing + 1)", { x: 1 }],
      ["(o.a + o.a) * o.b", { o: { a: 2, b: 3 } }],
      ["o.constructor", { o: {} }],
      ["pi(1) + 1", {}],
      ["-(x ^ 2) + -x ^ 2 + !x", { x: 3 }],
      ["min(x, x, 2) + max(x, x) + smoothstep(0, 1, x)", { x: 0.25 }],
      ["(1/0) - (1/0)", {}],
    ];
    for (const [src, scope] of cases) {
      const ce = compileExpression(src);
      expect(outcome(() => ce.evaluate(scope))).toEqual(
        outcome(() => {
          const v = evaluateAst(ce.ast, scope);
          if (
            typeof v !== "number" &&
            typeof v !== "string" &&
            typeof v !== "boolean"
          )
            throw new Error("non-value");
          return v;
        }),
      );
    }
  });

  it("reads each distinct identifier once per evaluation", () => {
    const ce = compileExpression(generated());
    const { scope, reads } = countingScope({
      P: 3.7e5,
      rho: 700,
      Tw: 250,
      G: 55,
      D: 0.0102,
      mu: 1.5e-4,
      k: 0.13,
    });
    const v = ce.evaluateNumber(scope);
    expect(Object.is(v, evaluateAst(ce.ast, { ...scope }))).toBe(true);
    // The tree walk reads P dozens of times (once per Horner term).
    reads.clear();
    ce.evaluateNumber(scope);
    for (const [name, n] of reads) expect([name, n]).toEqual([name, 1]);
    expect(reads.get("P")).toBe(1);
    // A second evaluation re-reads (memo is per evaluation, not global).
    reads.clear();
    ce.evaluateNumber(scope);
    expect(reads.get("P")).toBe(1);
  });

  it("never reuses a memoized value across a scope-provided call", () => {
    let x = 1;
    const scope: ExprScope = {
      bump: () => {
        x += 10;
        return 0;
      },
    };
    Object.defineProperty(scope, "x", { enumerable: true, get: () => x });
    const src = "(x + 1) + bump() + (x + 1)";
    const ce = compileExpression(src);
    expect(ce.evaluateNumber(scope)).toBe(2 + 0 + 12);
    x = 1;
    expect(evaluateAst(ce.ast, scope)).toBe(2 + 0 + 12);
    // Impure calls themselves are re-invoked every time they occur.
    let calls = 0;
    const s2: ExprScope = { f: () => ++calls };
    compileExpression("f() + f() + f()").evaluateNumber(s2);
    expect(calls).toBe(3);
  });

  it("is reentrancy-safe", () => {
    const inner = compileExpression("(y + 1) * (y + 1)");
    const outer = compileExpression("(y + 1) * g() + (y + 1)");
    const scope: ExprScope = {
      y: 2,
      g: () => inner.evaluateNumber({ y: 5 }),
    };
    expect(outer.evaluateNumber(scope)).toBe(3 * 36 + 3);
    // Same compiled object re-entered from its own scope function.
    let depth = 0;
    const self = compileExpression("(z + 1) + h() + (z + 1)");
    const s3: ExprScope = {
      z: 1,
      h: () =>
        depth++ === 0 ? self.evaluateNumber({ z: 100, h: () => 0 }) : 0,
    };
    expect(self.evaluateNumber(s3)).toBe(2 + 202 + 2);
  });
});
