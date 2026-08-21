/** Small, self-contained stiff ODE integrator for node-local chemistry.
 *
 *  Uses BDF1 (backward Euler, 1st-order) with adaptive sub-stepping and a
 *  dense Newton solve per sub-step.  The system is only Ns×Ns per node — tiny.
 *
 *  NOTE: BDF1 is weaker than a Rosenbrock or BDF2+ method.  1st-order accuracy
 *  means many small sub-steps are needed for tight tolerances, which matters
 *  for future real-chemistry networks.  Upgrading the integrator is a known
 *  future improvement path (documented in README).
 *
 *  Algorithm:
 *    G(y) = y - yprev - dt·f(t, y) = 0
 *    J_G  = I - dt·J_f
 *    Newton: y_{k+1} = y_k - J_G^{-1}·G(y_k)
 *
 *  Step-doubling error estimate:
 *    y1  = one step of size dt
 *    y2  = two steps of size dt/2
 *    err = |y2 - y1| / (atol + rtol·|y2|)
 *    accept if err ≤ 1, shrink dt and retry otherwise.
 */

function solveDense(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    let maxVal = Math.abs(M[i][i]);
    for (let k = i + 1; k < n; k++) {
      const v = Math.abs(M[k][i]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = k;
      }
    }
    if (maxVal < 1e-14) {
      M[i][i] = 1e-14;
    } else {
      [M[i], M[maxRow]] = [M[maxRow], M[i]];
    }

    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) {
        M[k][j] -= factor * M[i][j];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }
  return x;
}

/** Compute a dense FD Jacobian of f at (t, y). */
function fdJacobian(
  f: (t: number, y: number[]) => number[],
  t: number,
  y: number[],
  fVal: number[],
): number[][] {
  const n = y.length;
  const J: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let k = 0; k < n; k++) {
    const h = Math.max(1e-8, Math.abs(y[k]) * 1e-6);
    const yPert = [...y];
    yPert[k] += h;
    const fPert = f(t, yPert);
    for (let i = 0; i < n; i++) {
      J[i][k] = (fPert[i] - fVal[i]) / h;
    }
  }
  return J;
}

/** Integrate dy/dt = f(t, y) from t0 to tf with BDF1 + adaptive stepping. */
export function integrateBDF1(
  f: (t: number, y: number[]) => number[],
  y0: number[],
  t0: number,
  tf: number,
  options?: {
    atol?: number;
    rtol?: number;
    dtMin?: number;
    dtMax?: number;
    maxSteps?: number;
  },
): { y: number[]; nSteps: number; nRejected: number } {
  const atol = options?.atol ?? 1e-8;
  const rtol = options?.rtol ?? 1e-6;
  const dtMin = options?.dtMin ?? 1e-12;
  const dtMax = options?.dtMax ?? tf - t0;
  const maxSteps = options?.maxSteps ?? 10000;

  let y = [...y0];
  let t = t0;
  let dt = Math.min(dtMax, Math.max(dtMin, tf - t0));
  let nSteps = 0;
  let nRejected = 0;

  const n = y0.length;

  while (t < tf) {
    if (nSteps >= maxSteps) {
      throw new Error(
        `BDF1 exceeded maxSteps (${maxSteps}) at t=${t} dt=${dt}`,
      );
    }
    dt = Math.min(dt, tf - t);

    // One full step of size dt
    const y1 = bdf1Step(f, t, y, dt, n, atol);

    // Two steps of size dt/2
    const yMid = bdf1Step(f, t, y, dt / 2, n, atol);
    const y2 = bdf1Step(f, t + dt / 2, yMid, dt / 2, n, atol);

    // Error estimate
    let err = 0;
    for (let i = 0; i < n; i++) {
      const scale = atol + rtol * Math.max(Math.abs(y1[i]), Math.abs(y2[i]));
      err = Math.max(err, Math.abs(y2[i] - y1[i]) / scale);
    }

    if (err <= 1) {
      // Accept y2 (more accurate)
      y = y2;
      t += dt;
      nSteps += 2;
      // Grow step slightly
      let dtNew =
        dt *
        Math.min(5, Math.max(0.2, 0.9 * Math.sqrt(1 / Math.max(err, 1e-10))));
      dt = Math.min(dtMax, Math.max(dtMin, dtNew));
    } else {
      nRejected++;
      let dtNew = dt * Math.min(0.5, Math.max(0.1, 0.9 * Math.sqrt(1 / err)));
      if (dtNew < dtMin) {
        // Accept at minimum step to avoid infinite loop
        y = y2;
        t += dt;
        nSteps += 2;
        dt = dtMin;
      } else {
        dt = Math.max(dtMin, dtNew);
        continue;
      }
    }
  }

  return { y, nSteps, nRejected };
}

/** Single BDF1 step: solve y - yPrev - dt·f(t+dt, y) = 0 via Newton. */
function bdf1Step(
  f: (t: number, y: number[]) => number[],
  t: number,
  yPrev: number[],
  dt: number,
  n: number,
  tol: number,
): number[] {
  let y = [...yPrev];
  const tNew = t + dt;

  for (let iter = 0; iter < 20; iter++) {
    const fVal = f(tNew, y);
    const G = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      G[i] = y[i] - yPrev[i] - dt * fVal[i];
    }

    const Jf = fdJacobian(f, tNew, y, fVal);
    const JG: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0) - dt * Jf[i][j]),
    );

    const dy = solveDense(JG, G);
    let maxDy = 0;
    for (let i = 0; i < n; i++) {
      y[i] -= dy[i];
      maxDy = Math.max(maxDy, Math.abs(dy[i]) / Math.max(1, Math.abs(y[i])));
    }

    if (maxDy < tol) break;
  }

  return y;
}
