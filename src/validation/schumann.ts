/**
 * Anzelius–Schumann closed form for transient conjugate heat transfer between
 * a fluid in plug flow and a wall (or packed bed) that stores heat.
 *
 * Physical problem (Anzelius 1926, Schumann 1929, restated for chilldown by
 * Cross, Majumdar, Bennett and Malla 2002): a fluid of constant properties
 * and constant mass flow enters a tube at temperature T_f0.  The wall starts
 * at T_w0 and exchanges heat with the fluid through a constant film
 * coefficient h.  There is no axial conduction in wall or fluid and no
 * fluid storage (the fluid transit time z/u is a pure delay).  With
 *
 *   ζ = h·P·z / (ṁ·c_f)                    (dimensionless distance)
 *   τ = h·P·(t − z/u) / (ρ_w·c_w·A_w)      (dimensionless time since the front)
 *
 * the coupled equations
 *
 *   ∂θ_f/∂ζ = −(θ_f − θ_w),    ∂θ_w/∂τ = θ_f − θ_w,
 *   θ = (T − T_f0)/(T_w0 − T_f0),   θ_f(ζ=0) = 0,   θ_w(τ=0) = 1
 *
 * have the solution
 *
 *   θ_w = J(τ, ζ),     θ_f = 1 − J(ζ, τ),
 *   J(a, b) = 1 − ∫₀ᵃ e^{−(b+ξ)} I₀(2√(bξ)) dξ.
 *
 * J is the Marshall–Pigford function and equals the Marcum Q-function
 * Q₁(√(2b), √(2a)), i.e. the survival function of a non-central chi-square
 * variable with two degrees of freedom, P(χ'²₂(λ = 2b) > 2a).
 *
 * Evaluation.  Q₁ is a Poisson mixture of regularised upper incomplete gamma
 * functions, and for integer shape those are Poisson distribution functions,
 * so with independent K ~ Poisson(b) and M ~ Poisson(a)
 *
 *   J(a, b) = P(M ≤ K) = Σ_k  p_k(b) · F_a(k),
 *   p_k(b) = e^{−b} b^k / k!,   F_a(k) = Σ_{m ≤ k} e^{−a} a^m / m!.
 *
 * Every term is positive, so the sum has no cancellation and keeps full
 * relative accuracy even where J is tiny (J ~ 1e−54 at a = 200, b = 10).
 * Each term is formed in log space (log-gamma by Stirling's series), so large
 * arguments do not overflow or underflow before the result itself does.  The
 * cost is O(max(b, √(ab)) + √b) per call, which is microseconds for the
 * arguments of a chilldown problem (ζ, τ ≲ 10) and still milliseconds at
 * 1e5.  Validated against a 80-digit decimal evaluation of the same series
 * and against scipy.stats.ncx2.sf (src/validation/__tests__/schumann.test.ts).
 */

/** ln Γ(x) for x > 0 (Stirling series with upward shift, error < 1e-15 relative). */
export function lnGamma(x: number): number {
  if (!(x > 0)) throw new RangeError(`lnGamma: x must be > 0, got ${x}`);
  let shift = 0;
  let y = x;
  // Shift to y >= 15, where the truncated Stirling series is exact to double precision.
  if (y < 15) {
    let prod = 1;
    while (y < 15) {
      prod *= y;
      y += 1;
    }
    shift = Math.log(prod);
  }
  const y2 = y * y;
  const series =
    1 / (12 * y) -
    1 / (360 * y * y2) +
    1 / (1260 * y * y2 * y2) -
    1 / (1680 * y * y2 * y2 * y2) +
    1 / (1188 * y * y2 * y2 * y2 * y2);
  return (
    (y - 0.5) * Math.log(y) - y + 0.5 * Math.log(2 * Math.PI) + series - shift
  );
}

/**
 * Marshall–Pigford J function, J(a, b) = Q₁(√(2b), √(2a)).
 *
 * Domain a ≥ 0, b ≥ 0.  Limits: J(0, b) = 1, J(a, 0) = e^{−a}, J → 0 as
 * a → ∞, J → 1 as b → ∞.  Returns a value in [0, 1].
 */
export function marshallPigfordJ(a: number, b: number): number {
  if (!(a >= 0) || !(b >= 0) || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new RangeError(
      `marshallPigfordJ: need finite a, b >= 0, got a=${a}, b=${b}`,
    );
  }
  if (a === 0) return 1;
  if (b === 0) return Math.exp(-a);

  const lnA = Math.log(a);
  const lnB = Math.log(b);
  const ab = a * b;
  // Hard cap on the summation index: the Poisson(b) bulk ends near
  // b + 10√b, and where a ≫ b the dominant term sits near √(ab).
  const kCap = Math.ceil(
    b +
      40 * Math.sqrt(b + 1) +
      100 +
      6 * Math.sqrt(ab) +
      40 * Math.pow(ab, 0.25),
  );

  let cdfA = 0; // F_a(k), running Poisson(a) distribution function
  let sum = 0;
  let prev = 0;
  for (let k = 0; k <= kCap; k++) {
    const lnFact = k < 2 ? 0 : lnGamma(k + 1);
    cdfA += Math.exp(-a + k * lnA - lnFact);
    const term = Math.exp(-b + k * lnB - lnFact) * cdfA;
    sum += term;
    // Past the Poisson(b) mode the terms fall off; stop once they are
    // negligible against the sum and decreasing (so we are past any
    // tilted peak near √(ab) as well).
    if (k > b && sum > 0 && term <= prev && term <= 1e-18 * sum) break;
    prev = term;
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * Dimensionless wall temperature θ_w = (T_w − T_f0)/(T_w0 − T_f0).
 * `tau` is the time since the fluid front reached the station; for tau ≤ 0
 * the wall has not yet seen the cold fluid and θ_w = 1.
 */
export function schumannWallTheta(zeta: number, tau: number): number {
  if (!(tau > 0)) return 1;
  return marshallPigfordJ(tau, zeta);
}

/**
 * Dimensionless fluid temperature θ_f = (T_f − T_f0)/(T_w0 − T_f0), with the
 * initial fluid temperature equal to the initial wall temperature
 * (θ_f = 1 ahead of the front, tau < 0).
 */
export function schumannFluidTheta(zeta: number, tau: number): number {
  if (tau < 0) return 1;
  return 1 - marshallPigfordJ(zeta, tau);
}

/** Dimensional parameters of the Anzelius–Schumann problem. */
export interface SchumannParams {
  /** a = hP/(ρ_w c_w A_w) [1/s], inverse wall time constant. */
  a: number;
  /** b = hP/(ṁ c_f) [1/m], fluid NTU per unit length. */
  b: number;
  /** Fluid velocity u [m/s]; the fluid transit time to z is z/u. */
  u: number;
  /** Fluid inlet temperature T_f0 [K]. */
  Tf0: number;
  /** Initial wall temperature T_w0 [K]. */
  Tw0: number;
}

/** Wall temperature [K] at axial position `z` [m] and time `t` [s]. */
export function schumannWallTemperature(
  p: SchumannParams,
  z: number,
  t: number,
): number {
  const tau = p.a * (t - z / p.u);
  return p.Tf0 + (p.Tw0 - p.Tf0) * schumannWallTheta(p.b * z, tau);
}

/** Fluid temperature [K] at axial position `z` [m] and time `t` [s]. */
export function schumannFluidTemperature(
  p: SchumannParams,
  z: number,
  t: number,
): number {
  const tau = p.a * (t - z / p.u);
  return p.Tf0 + (p.Tw0 - p.Tf0) * schumannFluidTheta(p.b * z, tau);
}
