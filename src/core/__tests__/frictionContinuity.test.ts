/**
 * Friction-factor continuity & correctness tests (Darcy f vs Reynolds number).
 *
 * Regression guard for a confirmed C0 discontinuity: the laminar→turbulent
 * transition blend used to overwrite f = 64/Re with a blend anchored at the
 * CONSTANT flam = 64/2300, producing a ~13 % jump in f at Re = 2000 (Pipe)
 * and a ~7 % jump at Re = 2300 (Bend).  The blend also froze the turbulent
 * end at its Re = 4000 value, so the dual-number derivative through the
 * transition was wrong as well.
 *
 * The fixed correlation:
 *   Re < 2300           → f = 64/Re (Hagen–Poiseuille, exact)
 *   Re ≥ 4000           → Swamee–Jain (Colebrook approximation)
 *   2300 ≤ Re < 4000    → smoothstep blend of 64/Re and Swamee–Jain, both
 *                         evaluated at the actual Re.  The smoothstep has zero
 *                         endpoint slope, so f is C0 AND C1 at both edges.
 *
 * Everything here is exercised through the public component surfaces
 * (Pipe.pressureDrop / Pipe.pressureDropDual, Bend via the same private
 * frictionFactor path components2.test.ts uses) so the tests fail against
 * the pre-fix implementation.
 */
import { describe, it, expect } from "vitest";
import { Pipe, Bend } from "../components";
import { variable } from "../dual";

// The transition edges are part of the physics contract (classical critical
// Reynolds numbers); hardcoded so this file runs unchanged against old code.
const RE_LAM = 2300; // laminar cutoff = blend lower edge
const RE_TURB = 4000; // blend upper edge = turbulent onset

const RHO = 998;
const MU = 1e-3;

/** Extract the Darcy friction factor implicit in Pipe.pressureDrop. */
function pipeF(pipe: Pipe, Re: number): number {
  const D = pipe.diameter;
  const A = pipe.area;
  const v = (Re * MU) / (RHO * D);
  const mdot = RHO * A * v;
  const dP = pipe.pressureDrop(mdot, RHO, MU);
  return (dP * 2 * D) / (pipe.length * RHO * v * v);
}

function bendF(bend: Bend, Re: number): number {
  // Same private accessor pattern as components2.test.ts
  return bend["frictionFactor"](Re) as number;
}

/** Swamee–Jain explicit approximation (the correlation's turbulent branch). */
function swameeJain(Re: number, epsOverD: number): number {
  const rhs = epsOverD / 3.7 + 5.74 / Math.pow(Re, 0.9);
  return 0.25 / Math.pow(Math.log10(rhs), 2);
}

/** Iterative solution of the implicit Colebrook equation (reference truth). */
function colebrook(Re: number, epsOverD: number): number {
  let f = 0.02;
  for (let i = 0; i < 200; i++) {
    const inv = -2 * Math.log10(epsOverD / 3.7 + 2.51 / (Re * Math.sqrt(f)));
    f = 1 / (inv * inv);
  }
  return f;
}

/**
 * Upper bound on |df/dRe| at the left point of a sample interval.
 *  - Laminar: |df/dRe| = 64/Re², and since 64/Re is convex the secant slope
 *    over an interval is bounded by the tangent at its left end.
 *  - Transition/turbulent: measured worst |df/dRe| ≈ 1.3e-5 (in the blend
 *    just above Re = 2300); a 2.5e-5 bound gives ~2× margin while still
 *    catching the old 2.4e-3 jump secant.
 */
function slopeBound(reLeft: number): number {
  return Math.max(64 / (reLeft * reLeft), 2.5e-5);
}

/** Build the Re sample grid: 500 log-spaced 100→1e7 plus a dense linear
 *  sweep (2000 points) across 1500→5000 covering the whole transition. */
function reGrid(): number[] {
  const grid: number[] = [];
  const nLog = 500;
  const logMin = Math.log10(100);
  const logMax = Math.log10(1e7);
  for (let i = 0; i < nLog; i++) {
    grid.push(Math.pow(10, logMin + ((logMax - logMin) * i) / (nLog - 1)));
  }
  const nLin = 2000;
  for (let i = 0; i <= nLin; i++) {
    grid.push(1500 + (3500 * i) / nLin);
  }
  grid.sort((a, b) => a - b);
  return grid;
}

describe("Darcy friction factor continuity (Pipe)", () => {
  const pipe = new Pipe(10, 0.05, 1e-5); // L, D, roughness — elevation 0

  it("C0: no jump between adjacent samples over 100 ≤ Re ≤ 1e7", () => {
    const grid = reGrid();
    let prevF = pipeF(pipe, grid[0]);
    let prevRe = grid[0];
    let worst = { ratio: 0, re: 0 };
    for (let i = 1; i < grid.length; i++) {
      const Re = grid[i];
      const f = pipeF(pipe, Re);
      const dRe = Re - prevRe;
      const allowed = slopeBound(prevRe) * dRe + 1e-9;
      const jump = Math.abs(f - prevF);
      if (jump / allowed > worst.ratio)
        worst = { ratio: jump / allowed, re: prevRe };
      expect(
        jump,
        `f jump ${jump} at Re=${prevRe.toFixed(1)}→${Re.toFixed(1)} exceeds continuity bound ${allowed}`,
      ).toBeLessThanOrEqual(allowed);
      prevF = f;
      prevRe = Re;
    }
    console.log(
      `Pipe worst continuity ratio (jump/allowed): ${worst.ratio.toFixed(3)} near Re=${worst.re.toFixed(1)}`,
    );
  });

  it("C1: one-sided derivatives agree at both transition edges (no kink, no spike)", () => {
    for (const E of [RE_LAM, RE_TURB]) {
      const h = E * 1e-6;
      const dLeft = (pipeF(pipe, E) - pipeF(pipe, E - h)) / h;
      const dRight = (pipeF(pipe, E + h) - pipeF(pipe, E)) / h;
      const scale = Math.max(Math.abs(dLeft), Math.abs(dRight));
      expect(
        Math.abs(dLeft - dRight),
        `derivative kink at Re=${E}: left=${dLeft}, right=${dRight}`,
      ).toBeLessThanOrEqual(1e-10 + 0.01 * scale);
      // Documented "no pathological derivative" bound for the whole domain
      expect(scale).toBeLessThan(2.5e-5);
    }
  });

  it("laminar branch matches 64/Re exactly", () => {
    for (const Re of [50, 100, 500, 1000, 2000, 2299]) {
      const f = pipeF(pipe, Re);
      const exact = 64 / Re;
      expect(Math.abs(f - exact) / exact, `Re=${Re}`).toBeLessThan(1e-9);
    }
    // Exactly at the laminar cutoff the value must be 64/Re (not 64/2300 frozen)
    const fEdge = pipeF(pipe, RE_LAM);
    expect(Math.abs(fEdge - 64 / RE_LAM) / (64 / RE_LAM)).toBeLessThan(1e-9);
  });

  it("turbulent branch matches Colebrook within 3% at several (Re, ε/D) points", () => {
    for (const [roughD, epsOverD] of [
      [0, 0],
      [5e-6, 1e-4],
      [5e-5, 1e-3],
    ] as Array<[number, number]>) {
      const p = new Pipe(10, 0.05, roughD);
      for (const Re of [4000, 1e4, 1e5, 1e6, 1e7]) {
        const f = pipeF(p, Re);
        const fC = colebrook(Re, epsOverD);
        expect(
          Math.abs(f - fC) / fC,
          `Re=${Re}, ε/D=${epsOverD}: f=${f} vs Colebrook ${fC}`,
        ).toBeLessThan(0.03);
      }
    }
  });

  it("dual derivative matches central FD through the transition (~1e-6 relative)", () => {
    for (const Re of [1800, 2290, 2600, 3300, 3990, 4100, 1e4]) {
      const D = pipe.diameter;
      const A = pipe.area;
      const v = (Re * MU) / (RHO * D);
      const mdot = RHO * A * v;
      const h = mdot * 1e-6;
      const fd =
        (pipe.pressureDrop(mdot + h, RHO, MU) -
          pipe.pressureDrop(mdot - h, RHO, MU)) /
        (2 * h);
      const dual = pipe.pressureDropDual!(variable(mdot), RHO, MU);
      // Primal must agree with the scalar path too
      expect(Math.abs(dual.v - pipe.pressureDrop(mdot, RHO, MU))).toBeLessThan(
        1e-9,
      );
      const relErr = Math.abs(dual.d - fd) / Math.max(Math.abs(fd), 1e-12);
      expect(relErr, `Re=${Re}: dual.d=${dual.d} vs FD=${fd}`).toBeLessThan(
        1e-6,
      );
    }
  });
});

describe("Darcy friction factor continuity (Bend)", () => {
  const bend = new Bend(0.05, 90, 2, 1e-5);

  it("C0: no jump between adjacent samples over 100 ≤ Re ≤ 1e7", () => {
    const grid = reGrid();
    let prevF = bendF(bend, grid[0]);
    let prevRe = grid[0];
    for (let i = 1; i < grid.length; i++) {
      const Re = grid[i];
      const f = bendF(bend, Re);
      const dRe = Re - prevRe;
      const allowed = slopeBound(prevRe) * dRe + 1e-9;
      expect(
        Math.abs(f - prevF),
        `f jump at Re=${prevRe.toFixed(1)}→${Re.toFixed(1)}`,
      ).toBeLessThanOrEqual(allowed);
      prevF = f;
      prevRe = Re;
    }
  });

  it("matches Pipe correlation exactly (shared implementation)", () => {
    const pipe = new Pipe(10, 0.05, 1e-5);
    for (const Re of [100, 1000, 2000, 2300, 2600, 3300, 4000, 1e5, 1e7]) {
      expect(Math.abs(bendF(bend, Re) - pipeF(pipe, Re))).toBeLessThan(1e-12);
    }
  });

  it("laminar limit is 64/Re; blend edges match branch values (C0)", () => {
    expect(Math.abs(bendF(bend, 2299) - 64 / 2299) / (64 / 2299)).toBeLessThan(
      1e-9,
    );
    // Just above the lower edge, the blend must START at 64/Re, not 64/2300
    const fEdge = bendF(bend, RE_LAM + 1e-6);
    expect(Math.abs(fEdge - 64 / RE_LAM) / (64 / RE_LAM)).toBeLessThan(1e-6);
    // Upper edge matches Swamee–Jain at Re = 4000
    const fTop = bendF(bend, RE_TURB);
    expect(Math.abs(fTop - swameeJain(RE_TURB, 1e-5 / 0.05))).toBeLessThan(
      1e-12,
    );
  });

  it("dual derivative matches central FD through the transition (~1e-6 relative)", () => {
    for (const Re of [1800, 2290, 2600, 3300, 3990, 4100, 1e4]) {
      const D = bend.diameter;
      const A = bend.area;
      const v = (Re * MU) / (RHO * D);
      const mdot = RHO * A * v;
      const h = mdot * 1e-6;
      const fd =
        (bend.pressureDrop(mdot + h, RHO, MU) -
          bend.pressureDrop(mdot - h, RHO, MU)) /
        (2 * h);
      const dual = bend.pressureDropDual!(variable(mdot), RHO, MU);
      expect(Math.abs(dual.v - bend.pressureDrop(mdot, RHO, MU))).toBeLessThan(
        1e-9,
      );
      const relErr = Math.abs(dual.d - fd) / Math.max(Math.abs(fd), 1e-12);
      expect(relErr, `Re=${Re}: dual.d=${dual.d} vs FD=${fd}`).toBeLessThan(
        1e-6,
      );
    }
  });
});
