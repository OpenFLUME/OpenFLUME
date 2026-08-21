import { describe } from "vitest";

/**
 * Opt-in slow tests.
 *
 * The honest-convergence cascade (d4fb22c) does genuine Newton work where
 * the solver previously false-converged, so full parameter sweeps and
 * high-N studies now cost minutes each.  Those live behind this gate so
 * the default `npm test` stays within the CI budget (~3 min), while
 * remaining exactly one command away:
 *
 *   npm run test:slow        # runs EVERYTHING, including slow suites
 *   RUN_SLOW=1 npx vitest run src/ui/tests/chilldownTwoPhase.test.ts
 *
 * See docs/testing-slow.md for what the default run does NOT cover.
 */
export const describeSlow = (typeof process !== "undefined" &&
process.env?.RUN_SLOW === "1"
  ? describe
  : describe.skip) as unknown as typeof describe;
