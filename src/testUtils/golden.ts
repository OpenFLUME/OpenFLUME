/**
 * Golden-trace comparison that survives the floating-point differences
 * between CPU architectures.
 *
 * The bit-identity goldens in the suite were recorded on CI's x86 runner.
 * On arm64 (Apple Silicon) V8 contracts some multiply–add sequences into
 * fused instructions, and a handful of trace values land one ULP away
 * (`…148738` vs `…14874`). `toEqual` therefore fails on every arm64
 * checkout for a difference that has no numerical meaning.
 *
 * A real behavioural change — a different closure, a re-ordered update, a
 * changed default — moves these traces by 1e-9 relative or far more. The
 * bound here is 16 ULP (relative 2^-48 ≈ 3.6e-15), five orders of magnitude
 * below anything a change of substance produces, so the goldens keep their
 * purpose while passing on both architectures. Never widen this to hide a
 * genuine drift; regenerate the golden and say why instead.
 */
import { expect } from "vitest";

const GOLDEN_REL_ULPS = 16;
const GOLDEN_REL_TOL = GOLDEN_REL_ULPS * Number.EPSILON;

export function expectGoldenTrace(
  actual: readonly number[],
  golden: readonly number[],
): void {
  expect(actual.length).toBe(golden.length);
  for (let i = 0; i < golden.length; i++) {
    const g = golden[i];
    const a = actual[i];
    const tol = Math.max(Math.abs(g), Number.MIN_VALUE) * GOLDEN_REL_TOL;
    if (Math.abs(a - g) > tol) {
      // Fall through to toEqual for vitest's aligned diff output.
      expect(actual).toEqual(golden);
    }
  }
}
