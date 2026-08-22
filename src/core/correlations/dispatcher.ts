/**
 * The convection h dispatcher: picks the correlation model configured on a
 * conductor, evaluates it, and applies the shared fallback-floor clamp +
 * under-relaxation every model path goes through.
 */
import { RealFluid, clampToValidPH } from "../fluids/realFluid";
import {
  recordHFloorClamp,
  recordDarrHartwigValidityClamp,
  recordDarrHartwigPropertyFailure,
  recordDarrHartwigMissingWallTemp,
  recordTtWfEvent,
} from "../diagnostics";
import { DEFAULT_CLOSURE_PARAMS } from "../closureParams";
import { fluidFrontGate } from "../fluidFront";
import { TTWF_INITIAL_STATE } from "../ttWf";
import type {
  CorrelationConductor,
  CorrelationCtx,
  CorrelationState,
} from "./types";
import { FALLBACK_H_FLOOR, H_RELAX } from "./types";
import { massFluxAtNode, conductorFluid } from "./massFlux";
import { dittusBoelterH } from "./dittusBoelter";
import { miropolskiiH } from "./miropolskii";
import { darrHartwigHeatFlux } from "./darrHartwigWrapper";
import { ttWfQuenchFrontZ, evaluateTtWfConductor } from "./ttWfWrapper";
import { evaluateCustomCorrelationH } from "./customCorrelation";

/** Evaluate the state-dependent heat-transfer coefficient for a convection conductor.
 *  Returns the constant h if no correlation is configured.
 */
export function evaluateConvectionH(
  cond: CorrelationConductor,
  ctx: CorrelationCtx,
  state: CorrelationState,
  prevH?: number,
  t?: number,
): number {
  if (!cond.type.correlation) {
    return cond.type.h ?? FALLBACK_H_FLOOR;
  }
  const corr = cond.type.correlation;

  const fluidNodeId = ctx.nodeMap.has(cond.from) ? cond.from : cond.to;
  // Named models: validate.ts requires a positive diameter, so the
  // (optionally-typed) field is always set on those paths.  'custom'
  // carries its own optional geometry (evaluateCustomCorrelationH) and
  // never reads D/flowArea/G here — the assertion is compile-time only.
  const D = corr.diameter!;
  const flowArea = corr.flowArea ?? (Math.PI / 4) * D * D;
  const closure = ctx.closureParams ?? DEFAULT_CLOSURE_PARAMS;

  const G = massFluxAtNode(fluidNodeId, ctx.branches, state.mdots) / flowArea;

  let hRaw: number;

  if (corr.model === "custom") {
    // User h expression (safe expression language — schema.ts documents the
    // scope).  Same cadence as the named models: evaluated HERE, at h-map
    // refresh; the result flows through the shared floor clamp +
    // under-relaxation below, and failures/non-finite values come back as
    // the fallback floor (never a throw into the solver).
    hRaw = evaluateCustomCorrelationH(cond, corr, ctx, state, fluidNodeId, t);
  } else if (corr.model === "dittusBoelter") {
    const cf = conductorFluid(ctx, fluidNodeId);
    if (!(cf instanceof RealFluid)) {
      // Analytic models do not carry thermal conductivity; use fallback floor
      hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
    } else {
      const fluid = cf;
      const P = state.nodeP.get(fluidNodeId) ?? 1e5;
      const hNode = state.nodeH?.get(fluidNodeId);
      if (hNode !== undefined) {
        const [cP, cH] = clampToValidPH(fluid.fluidName, P, hNode);
        const ph = fluid.statePH(cP, cH);
        const mu = ph.mu;
        const k = ph.k ?? 0;
        const cp = ph.cp ?? 0;
        if (mu > 0 && k > 0 && cp > 0) {
          hRaw = dittusBoelterH(G, D, mu, k, cp, closure.dittusBoelter);
        } else {
          hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
        }
      } else {
        const T = state.nodeT.get(fluidNodeId) ?? 300;
        const mu = fluid.viscosity(P, T);
        const k = fluid.statePH(P, fluid.enthalpyPT(P, T)).k ?? 0;
        const cp = fluid.cp(P, T);
        if (mu > 0 && k > 0 && cp > 0) {
          hRaw = dittusBoelterH(G, D, mu, k, cp, closure.dittusBoelter);
        } else {
          hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
        }
      }
    }
  } else if (corr.model === "miropolskii") {
    const cf = conductorFluid(ctx, fluidNodeId);
    if (!(cf instanceof RealFluid)) {
      hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
    } else {
      const fluid = cf;
      const P = state.nodeP.get(fluidNodeId) ?? 1e5;
      const hNode = state.nodeH?.get(fluidNodeId);
      if (hNode !== undefined) {
        hRaw = miropolskiiH(G, D, fluid, P, hNode, flowArea, closure);
      } else {
        const T = state.nodeT.get(fluidNodeId) ?? 300;
        const hVal = fluid.enthalpyPT(P, T);
        hRaw = miropolskiiH(G, D, fluid, P, hVal, flowArea, closure);
      }
    }
  } else if (corr.model === "ttWf") {
    // ttWf — PROPOSED TT-WF chilldown closure (../ttWf.ts).
    // PHASE 2: integrated.  Reads the frozen
    // ACCEPTED fWet/latch from ctx.ttWf and evaluates the flux map with
    // dt = 0 — the proposed state is DISCARDED (nothing outlives the call);
    // the state advances only via updateTtWfStates at accepted step
    // boundaries.  Returns h_eff = q_bar/(T_w − T_node), guarded (same
    // secant contract as darrHartwig).
    const cf = conductorFluid(ctx, fluidNodeId);
    if (!(cf instanceof RealFluid)) {
      hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
    } else {
      const shared = ctx.ttWf;
      const fluid = cf;
      if (shared === undefined) {
        // No shared state (context built without ttWf plumbing): loud
        // fallback, never the silent darrHartwig fall-through.
        recordTtWfEvent("invalidInputCount");
        hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
      } else {
        const wallNodeId = fluidNodeId === cond.from ? cond.to : cond.from;
        const Tw = state.solidT?.get(wallNodeId);
        if (Tw === undefined) {
          // The model's regime map is wall-temperature driven; without a
          // solid endpoint temperature it cannot evaluate — documented
          // fallback (same as darrHartwig's missing-wall path).
          recordDarrHartwigMissingWallTemp();
          hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
        } else {
          const accepted = shared.state.get(cond.id) ?? TTWF_INITIAL_STATE;
          const outcome = evaluateTtWfConductor(
            ctx,
            cond,
            state,
            fluid,
            shared,
            accepted,
            ttWfQuenchFrontZ(shared),
            0,
          );
          if (!outcome.ok) {
            recordTtWfEvent("invalidInputCount");
            hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
          } else {
            // D-H validity guards pass through to the shared D-H counters
            // (per-evaluation, exactly as the darrHartwig branch).
            for (const c of outcome.result.clamps)
              recordDarrHartwigValidityClamp(c);
            hRaw = outcome.result.hEff;
            // FLUID-FRONT DRY-SIDE GATE (opt-in: correlation.fluidFront;
            // docs/fluid-front-transport.md).  Scales ONLY the
            // (1−fWet)·q_Dry term of the area average by
            // g = smoothstep(a) at the ACCEPTED frozen front fraction of the
            // conductor's fluid node; the wet term, the front evolution
            // (commit path — not here), and all validity guards are
            // untouched.  qBar'/qBar rescales BOTH q and h_eff consistently
            // (same reference T_w − T_node), so no re-evaluation of the
            // guarded secant is needed.  A closed gate (a = 0 ⇒ g = 0 with
            // fWet < 1 or qDry = 0) returns h = 0 BEFORE the floor/relax —
            // "closed" means zero dry-side heat exchange, not ~FALLBACK_H_
            // FLOOR leakage.  A PARTIALLY open gate (0 < s < 1) returns the
            // gated h with the shared under-relaxation but WITHOUT the
            // fallback-h floor clamp: the floor guards correlation
            // FAILURES, while a gate-suppressed h below the floor is the
            // closure working as designed (a nearly-closed gate must not be
            // floored back up to ~5 W/m²K of pre-front leakage).
            if (
              cond.type.correlation.fluidFront === true &&
              ctx.fluidFront !== undefined
            ) {
              const r = outcome.result;
              // The conductor's fluid node may be a BOUNDARY node (e.g.
              // conv0 → the cryogenic inlet f0 in the chilldown builder).
              // Boundary nodes carry no transported state — their front
              // fraction IS the configured boundary value (fluidFrontInlet,
              // default 0): a cryogenic-inlet-attached conductor sees
              // a = 1 (fully open gate from t = 0), an ordinary warm
              // boundary sees a = 0 (closed).  Without this consult a
              // boundary-attached gated conductor would read a = 0 forever.
              const a =
                ctx.fluidFront.a.get(fluidNodeId) ??
                ctx.fluidFront.boundary.get(fluidNodeId) ??
                0;
              const g = fluidFrontGate(a);
              if (g !== 1) {
                const f = accepted.fWet;
                const qBarGated = (1 - f) * g * r.qDry + f * r.qWet;
                if (r.qBar !== 0 && Number.isFinite(qBarGated)) {
                  const s = qBarGated / r.qBar;
                  if (s === 0) {
                    return 0;
                  }
                  if (s !== 1) {
                    let hGated = r.hEff * s;
                    if (prevH !== undefined && isFinite(prevH)) {
                      hGated = prevH + H_RELAX * (hGated - prevH);
                    }
                    return hGated;
                  }
                }
              }
            }
          }
        }
      }
    }
  } else if (corr.model === "darrHartwig") {
    // darrHartwig — Darr–Hartwig 2020 LH2 set (../darrHartwig.ts; integration
    // contract documented there).  Returns h_eff = q″/(T_w − T_node), guarded.
    const cf = conductorFluid(ctx, fluidNodeId);
    if (!(cf instanceof RealFluid)) {
      hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
    } else {
      const fluid = cf;
      const P = state.nodeP.get(fluidNodeId) ?? 1e5;
      const hNodeRaw = state.nodeH?.get(fluidNodeId);
      const Tnode = state.nodeT.get(fluidNodeId) ?? 300;
      const wallNodeId = fluidNodeId === cond.from ? cond.to : cond.from;
      const Tw = state.solidT?.get(wallNodeId);
      if (Tw === undefined) {
        // The model's regime map is wall-temperature driven; without a solid
        // endpoint temperature it cannot evaluate — documented fallback.
        recordDarrHartwigMissingWallTemp();
        hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
      } else {
        const hNode =
          hNodeRaw !== undefined
            ? clampToValidPH(fluid.fluidName, P, hNodeRaw)[1]
            : fluid.enthalpyPT(P, Tnode);
        // Quench-front distance L (SPEC §3.4): z_qf = most-downstream axial
        // position whose frozen step-level latch is rewetted; L = z − z_qf,
        // else L = z before any rewet.  Floor + counter live in the core.
        const z = cond.type.correlation.axialPosition ?? 0;
        let zQf = -Infinity;
        const shared = ctx.darrHartwig;
        if (shared) {
          for (const [id, entry] of shared.latch) {
            if (!entry.rewetLatched) continue;
            const zp = shared.axialPosition.get(id);
            if (zp !== undefined && zp > zQf) zQf = zp;
          }
        }
        const L = zQf > -Infinity ? z - zQf : z;
        const latched = shared?.latch.get(cond.id)?.rewetLatched ?? false;
        const outcome = darrHartwigHeatFlux(fluid, {
          P,
          hNode,
          Tnode,
          Tw,
          G,
          D,
          L,
          inletLiquidReynolds: cond.type.correlation.inletLiquidReynolds,
          latched,
        });
        if (!outcome.ok) {
          recordDarrHartwigPropertyFailure();
          hRaw = cond.type.h ?? FALLBACK_H_FLOOR;
        } else {
          for (const c of outcome.result.clamps)
            recordDarrHartwigValidityClamp(c);
          hRaw = outcome.result.hEff;
        }
      }
    }
  } else {
    // The schema union is closed today, but keep the dispatch explicit so a
    // model added to the schema without a branch here fails loudly instead
    // of silently evaluating as Darr–Hartwig (same pattern as
    // combustion/model.ts).
    throw new Error(
      `evaluateConvectionH: unknown correlation model "${(corr as { model: string }).model}" on conductor ${cond.id}`,
    );
  }

  // Apply explicit floor (fallback or user-supplied).  When the clamp binds
  // the correlation's gradient w.r.t. its coefficients is exactly zero, so
  // count bindings for calibration pre-flight diagnostics (see diagnostics.ts).
  const floor = cond.type.h ?? FALLBACK_H_FLOOR;
  if (hRaw < floor) {
    recordHFloorClamp();
    hRaw = floor;
  }

  // Under-relax across outer iterations for stability
  if (prevH !== undefined && isFinite(prevH)) {
    hRaw = prevH + H_RELAX * (hRaw - prevH);
  }

  return hRaw;
}
