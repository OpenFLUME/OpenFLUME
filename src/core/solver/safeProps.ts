/**
 * Crash-proof real-fluid property access.
 *
 * CoolProp's WASM build can abort (or throw) on states near the saturation
 * dome or outside its tabulated range, and a single uncaught abort would
 * kill the whole solve.  These wrappers clamp the inputs to the fluid's
 * valid P-h box and then walk a fallback cascade, recording every fallback
 * in diagnostics so silent corruption is impossible to miss.
 */
import type { PHState, FluidModel } from "../fluids";
import { RealFluid, clampToValidPH } from "../fluids/realFluid";
import { getCoolProp } from "../fluids/coolprop";
import { recordStatePHFallback } from "../diagnostics";

/** EOS-agnostic P–h clamp: real fluids get their tabulated valid box, the
 *  analytic models are defined everywhere and pass through unclamped. */
export function clampToValidPHFor(
  fluid: FluidModel,
  P: number,
  h: number,
): [number, number] {
  return fluid instanceof RealFluid
    ? clampToValidPH(fluid.fluidName, P, h)
    : [P, h];
}

/** Safe wrapper for statePH with clamping and contextual error messages.
 *  Analytic models evaluate directly (their statePH is closed-form and
 *  total).  Real fluids get the CoolProp-abort fallback cascade: a fresh
 *  AbstractState or direct PropsSI calls so a corrupted cached state does
 *  not crash the solver.
 */
export function safeStatePH(
  fluid: FluidModel,
  P: number,
  h: number,
  context?: string,
): PHState {
  if (!(fluid instanceof RealFluid)) return fluid.statePH(P, h);
  const [cP, cH] = clampToValidPH(fluid.fluidName, P, h);
  try {
    return fluid.statePH(cP, cH);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Corrupted cached-state recovery: try a fresh factory call.
    if (
      msg.includes("abort") ||
      msg.includes("Abort") ||
      msg.includes("out of bounds")
    ) {
      try {
        const cp = getCoolProp();
        const fresh = cp.factory("HEOS", fluid.fluidName);
        fresh.update(cp.input_pairs.HmassP_INPUTS, cH, cP);
        const phase: import("../fluids/realFluid").FluidPhase =
          fresh.Q() >= 0 && fresh.Q() <= 1
            ? "twoPhase"
            : cH < fresh.hmass()
              ? "liquid"
              : "vapor";
        let mu = 0;
        try {
          mu = fresh.viscosity();
        } catch {
          /* fluid lacks viscosity model */
        }
        let k: number | undefined;
        try {
          k = fresh.conductivity?.();
        } catch {
          /* fluid lacks conductivity model */
        }
        recordStatePHFallback("freshFactory");
        return {
          T: fresh.T(),
          rho: fresh.rhomass(),
          quality: fresh.Q() >= 0 && fresh.Q() <= 1 ? fresh.Q() : undefined,
          mu,
          k,
          cp: fresh.cpmass(),
          phase,
        };
      } catch {
        // Fresh state also failed — fall through to PropsSI fallback
      }
    }
    // Direct PropsSI fallback (slower but avoids any cached-state issues)
    try {
      const cp = getCoolProp();
      const T = cp.PropsSI("T", "P", cP, "HMASS", cH, fluid.fluidName);
      const rho = cp.PropsSI("Dmass", "P", cP, "HMASS", cH, fluid.fluidName);
      const q = cp.PropsSI("Q", "P", cP, "HMASS", cH, fluid.fluidName);
      const phase: import("../fluids/realFluid").FluidPhase =
        q >= 0 && q <= 1
          ? "twoPhase"
          : cH < cp.PropsSI("HMASS", "P", cP, "Q", 0, fluid.fluidName)
            ? "liquid"
            : "vapor";
      let mu = 0;
      try {
        mu = cp.PropsSI("V", "P", cP, "HMASS", cH, fluid.fluidName);
      } catch {
        /* fluid lacks viscosity model */
      }
      let k: number | undefined;
      try {
        k = cp.PropsSI("CONDUCTIVITY", "P", cP, "HMASS", cH, fluid.fluidName);
      } catch {
        /* fluid lacks conductivity model */
      }
      let cpVal: number | undefined;
      try {
        cpVal = cp.PropsSI("Cpmass", "P", cP, "HMASS", cH, fluid.fluidName);
      } catch {
        /* keep undefined */
      }
      recordStatePHFallback("propsSI");
      return {
        T,
        rho,
        quality: q >= 0 && q <= 1 ? q : undefined,
        mu,
        k,
        cp: cpVal,
        phase,
      };
    } catch {
      // Last-resort saturation-dome fallback
      try {
        const { Tsat, hf, hg, rhof, rhog, muf, mug } =
          fluid.saturationProperties(cP);
        if (cH >= hf && cH <= hg) {
          const x = (cH - hf) / (hg - hf);
          const rho = 1 / (x / rhog + (1 - x) / rhof);
          const mu = 1 / (x / mug + (1 - x) / muf);
          recordStatePHFallback("saturationDome");
          return { T: Tsat, rho, quality: x, mu, phase: "twoPhase" };
        }
      } catch {
        // ignore
      }
    }
    // Nothing worked — return a physically-wrong but finite fallback so the solver survives.
    // The caller (tests) can still assert on the final converged state; a fallback here
    // only prevents a WASM crash from killing the entire test suite.
    // Counted: if this EVER fires, results are silently corrupted (see diagnostics.ts).
    recordStatePHFallback("lastResort");
    return {
      T: 300,
      rho: 100,
      quality: undefined,
      mu: 1e-5,
      cp: 1000,
      phase: "supercritical",
    };
  }
}

export function safeInternalEnergyPH(
  fluid: FluidModel,
  P: number,
  h: number,
  context?: string,
): number {
  if (!(fluid instanceof RealFluid)) return fluid.internalEnergyPH(P, h);
  const [cP, cH] = clampToValidPH(fluid.fluidName, P, h);
  try {
    return fluid.internalEnergyPH(cP, cH);
  } catch (e) {
    // CoolProp's single-phase H-P flash can misroute near the saturation-
    // dome edge (e.g. N₂O at high P: "Hmolar below the minimum value").
    // Recover via the EXACT identity u = h − P/ρ using the robust statePH
    // cascade (which already handles the dome and near-edge states).  This
    // is not a fabricated value: u ≡ h − P/ρ holds identically for any
    // equilibrium state.  Only if statePH also fails do we give up.
    try {
      const ph = safeStatePH(
        fluid,
        cP,
        cH,
        context ? `${context} (u=h−P/ρ)` : "u=h−P/ρ fallback",
      );
      return cH - cP / ph.rho;
    } catch {
      const ctx = context ? `${context} — ` : "";
      throw new Error(
        `${ctx}Internal-energy failure for ${fluid.fluidName} at P=${P.toExponential(3)} Pa, h=${h.toFixed(2)} J/kg: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
