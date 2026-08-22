/**
 * solveDense — Gaussian elimination with partial pivoting and the
 * near-singular pivot regularisation (a pivot below 1e-14 in magnitude is
 * replaced by ±1e-14, keeping its sign so the returned step direction is
 * not flipped for descent-direction consumers).
 */

import { describe, it, expect } from "vitest";
import { solveDense, norm2, dot, matVec, matVecTrans } from "../solver/linalg";

describe("solveDense", () => {
  it("solves a well-conditioned system exactly", () => {
    // A·x = b with x = [1, -2, 3]
    const A = [
      [4, 1, 0],
      [1, 3, -1],
      [0, -1, 2],
    ];
    const x = [1, -2, 3];
    const b = matVec(A, x);
    const got = solveDense(A, b);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(x[i], 10);
  });

  it("pivots rows: a zero diagonal in a nonsingular matrix is handled", () => {
    const A = [
      [0, 2],
      [3, 1],
    ];
    const b = [4, 5]; // x = [1, 2]
    const got = solveDense(A, b);
    expect(got[0]).toBeCloseTo(1, 10);
    expect(got[1]).toBeCloseTo(2, 10);
  });

  it("returns a huge-but-finite step for a structurally singular row", () => {
    const A = [
      [1, 0],
      [0, 0],
    ];
    const b = [1, 1];
    const got = solveDense(A, b);
    expect(got.every(Number.isFinite)).toBe(true);
    expect(Math.abs(got[1])).toBeGreaterThan(1e10);
  });

  it("preserves the pivot sign under regularisation", () => {
    // A tiny NEGATIVE pivot must yield a negative solution component: the
    // exact solution of -1e-20·x = 1 is x = -1e20, and the regularised
    // step must point the same way (previously it was flipped to +1e14).
    const neg = solveDense([[-1e-20]], [1]);
    expect(neg[0]).toBeLessThan(0);
    const pos = solveDense([[1e-20]], [1]);
    expect(pos[0]).toBeGreaterThan(0);
  });

  it("does not mutate its inputs", () => {
    const A = [
      [2, 1],
      [1, 3],
    ];
    const b = [3, 4];
    solveDense(A, b);
    expect(A).toEqual([
      [2, 1],
      [1, 3],
    ]);
    expect(b).toEqual([3, 4]);
  });
});

describe("vector helpers", () => {
  it("norm2, dot, matVec, matVecTrans agree with hand values", () => {
    expect(norm2([3, 4])).toBeCloseTo(5, 12);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(
      matVec(
        [
          [1, 2],
          [3, 4],
        ],
        [1, 1],
      ),
    ).toEqual([3, 7]);
    expect(
      matVecTrans(
        [
          [1, 2],
          [3, 4],
        ],
        [1, 1],
      ),
    ).toEqual([4, 6]);
  });
});
