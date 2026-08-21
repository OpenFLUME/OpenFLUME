/**
 * Forward-mode automatic differentiation with dual numbers.
 *
 * A Dual number is a scalar value paired with its derivative with respect to a
 * single seeded input:  { v: value, d: derivative }.
 *
 * Conventions for non-differentiable points:
 *   - `abs(0)`: derivative = 0   (subgradient 0)
 *   - `min(a,b)` at a==b: derivative = (da + db)/2   (average subgradient)
 *   - `max(a,b)` at a==b: derivative = (da + db)/2   (average subgradient)
 *
 * These are standard convex-analysis subgradients that avoid favouring either
 * side and keep the derivative finite at the kink.
 */
export interface Dual {
  /** The primal value. */
  v: number;
  /** The derivative with respect to the seeded input. */
  d: number;
}

export function constant(x: number): Dual {
  return { v: x, d: 0 };
}

export function variable(x: number): Dual {
  return { v: x, d: 1 };
}

function getV(a: number | Dual): number {
  return typeof a === "number" ? a : a.v;
}

function getD(a: number | Dual): number {
  return typeof a === "number" ? 0 : a.d;
}

export function toDual(x: number | Dual): Dual {
  return typeof x === "number" ? constant(x) : x;
}

export function add(a: number | Dual, b: number | Dual): Dual {
  return { v: getV(a) + getV(b), d: getD(a) + getD(b) };
}

export function sub(a: number | Dual, b: number | Dual): Dual {
  return { v: getV(a) - getV(b), d: getD(a) - getD(b) };
}

export function neg(a: number | Dual): Dual {
  return { v: -getV(a), d: -getD(a) };
}

export function mul(a: number | Dual, b: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  const bv = getV(b),
    bd = getD(b);
  return { v: av * bv, d: ad * bv + av * bd };
}

export function div(a: number | Dual, b: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  const bv = getV(b),
    bd = getD(b);
  if (bv === 0) {
    // Avoid divide-by-zero; return an indicative fallback so the caller can
    // decide how to handle it (Newton will backtrack if the step is poor).
    return { v: av >= 0 ? Infinity : -Infinity, d: 0 };
  }
  return { v: av / bv, d: (ad * bv - av * bd) / (bv * bv) };
}

export function pow(a: number | Dual, b: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  const bv = getV(b),
    bd = getD(b);
  const v = Math.pow(av, bv);
  if (!isFinite(v) || av <= 0) {
    // Fallback for domain edge; derivative 0 lets the solver continue
    return { v: isFinite(v) ? v : 0, d: 0 };
  }
  // d/da(a^b) = b*a^(b-1), d/db(a^b) = a^b * ln(a)
  const d = bd * v * Math.log(av) + ad * bv * Math.pow(av, bv - 1);
  return { v, d };
}

export function sqrt(a: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  if (av <= 0) {
    return { v: 0, d: 0 };
  }
  const v = Math.sqrt(av);
  return { v, d: ad / (2 * v) };
}

export function abs(a: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  if (av > 0) return { v: av, d: ad };
  if (av < 0) return { v: -av, d: -ad };
  // Convention at 0: subgradient 0
  return { v: 0, d: 0 };
}

export function exp(a: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  const v = Math.exp(av);
  return { v, d: ad * v };
}

export function log(a: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  if (av <= 0) return { v: -Infinity, d: 0 };
  return { v: Math.log(av), d: ad / av };
}

export function log10(a: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  if (av <= 0) return { v: -Infinity, d: 0 };
  const ln10 = Math.log(10);
  return { v: Math.log(av) / ln10, d: ad / (av * ln10) };
}

export function min(a: number | Dual, b: number | Dual): Dual {
  const av = getV(a),
    bv = getV(b);
  if (av < bv) return { v: av, d: getD(a) };
  if (av > bv) return { v: bv, d: getD(b) };
  // Tie: average subgradient
  return { v: av, d: (getD(a) + getD(b)) / 2 };
}

export function max(a: number | Dual, b: number | Dual): Dual {
  const av = getV(a),
    bv = getV(b);
  if (av > bv) return { v: av, d: getD(a) };
  if (av < bv) return { v: bv, d: getD(b) };
  // Tie: average subgradient
  return { v: av, d: (getD(a) + getD(b)) / 2 };
}

/** Hyperbolic tangent — smooth, fully differentiable. */
export function tanh(a: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  const v = Math.tanh(av);
  return { v, d: ad * (1 - v * v) };
}

/** Square: x^2, cheaper than pow(x,2). */
export function sqr(a: number | Dual): Dual {
  const av = getV(a),
    ad = getD(a);
  return { v: av * av, d: 2 * av * ad };
}

/** Extract the primal value. */
export function value(a: number | Dual): number {
  return getV(a);
}

/** Extract the derivative. */
export function derivative(a: number | Dual): number {
  return getD(a);
}
