/**
 * Dense linear-algebra helpers for the solver's small Newton systems
 * (network sizes are tens of unknowns, so O(n³) Gaussian elimination is
 * the right tool — no sparse machinery needed).
 */

/** Solve A·x = b by Gaussian elimination with partial pivoting.  A pivot
 *  smaller than 1e-14 is replaced by 1e-14 (regularisation) instead of
 *  failing, so a structurally singular row yields a huge-but-finite step
 *  that the caller's line search / trust region then rejects. */
export function solveDense(A: number[][], b: number[]): number[] {
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

/** Euclidean norm ‖v‖₂. */
export function norm2(arr: number[]): number {
  let s = 0;
  for (const v of arr) s += v * v;
  return Math.sqrt(s);
}

/** Dot product aᵀ·b. */
export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Matrix-vector product J·v. */
export function matVec(J: number[][], v: number[]): number[] {
  const m = J.length;
  const out = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let s = 0;
    const row = J[i];
    for (let k = 0; k < v.length; k++) s += row[k] * v[k];
    out[i] = s;
  }
  return out;
}

/** Transposed matrix-vector product Jᵀ·v. */
export function matVecTrans(J: number[][], v: number[]): number[] {
  const n = J[0].length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < J.length; i++) {
    const vi = v[i];
    const row = J[i];
    for (let k = 0; k < n; k++) out[k] += row[k] * vi;
  }
  return out;
}
