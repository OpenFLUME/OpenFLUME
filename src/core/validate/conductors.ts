/**
 * Thermal-conductor validation: id uniqueness, endpoint reference/type
 * checks (via core/topology.ts), and per-kind checks — conduction (k),
 * convection (h or a correlation, including the darrHartwig/ttWf/custom
 * model-specific requirements), and radiation.
 */
import type { ResolvedNetworkConfig } from "../schema";
import type { TopologyModel } from "../topology";
import { classifyEndpoint } from "../topology";
import { validateSolidPropertySpec, isTimeTableSpec } from "../solidProperties";
import { resolveFluidSpec } from "../fluidAssignment";
import { checkExpression } from "./expressions";

export function validateConductors(
  config: ResolvedNetworkConfig,
  topology: TopologyModel,
): string[] {
  const errors: string[] = [];
  const conductorIds = new Set<string>();
  for (const cond of config.conductors ?? []) {
    if (conductorIds.has(cond.id)) {
      errors.push(`Duplicate conductor id: ${cond.id}`);
    }
    conductorIds.add(cond.id);

    const fromClass = classifyEndpoint(topology, cond.from);
    const toClass = classifyEndpoint(topology, cond.to);
    if (fromClass === "missing") {
      errors.push(`Conductor ${cond.id} references missing node: ${cond.from}`);
    }
    if (toClass === "missing") {
      errors.push(`Conductor ${cond.id} references missing node: ${cond.to}`);
    }
    if (cond.from === cond.to) {
      errors.push(`Conductor ${cond.id} must connect two different nodes`);
    }

    const fromFluid = fromClass === "fluid";
    const toFluid = toClass === "fluid";

    if (cond.type.kind === "conduction") {
      if (typeof cond.type.k === "number") {
        if (cond.type.k <= 0)
          errors.push(`Conductor ${cond.id} k must be positive`);
      } else {
        errors.push(
          ...validateSolidPropertySpec(
            cond.type.k,
            "k",
            `Conductor ${cond.id}`,
          ),
        );
        // Time-varying k has no steady meaning — reject it explicitly (never
        // silently evaluate at t = 0).
        if (
          config.settings.mode !== "transient" &&
          isTimeTableSpec(cond.type.k)
        ) {
          errors.push(
            `Conductor ${cond.id}: k timeTable is only supported in transient mode (a time-varying property has no steady-state meaning)`,
          );
        }
      }
      if (cond.type.area <= 0)
        errors.push(`Conductor ${cond.id} area must be positive`);
      if (cond.type.length <= 0)
        errors.push(`Conductor ${cond.id} length must be positive`);
      if (fromFluid || toFluid) {
        errors.push(
          `Conductor ${cond.id} conduction endpoints must be solid or ambient nodes`,
        );
      }
    } else if (cond.type.kind === "convection") {
      const fluidNode = fromFluid
        ? config.nodes.find((n) => n.id === cond.from)
        : toFluid
          ? config.nodes.find((n) => n.id === cond.to)
          : undefined;
      const convFluidModel = fluidNode
        ? resolveFluidSpec(config, fluidNode).model
        : config.fluid.model;
      const hasCorr = cond.type.correlation !== undefined;
      if (hasCorr) {
        const corr = cond.type.correlation!;
        if (corr.model === "custom") {
          // Custom h expression (core/correlations.ts): the safe expression
          // language only — parseable here via the shared checkExpression
          // convention.  No realFluid requirement: generic expressions
          // (G/D/area/Tf/Tw/P/t + params) work on any fluid model, and we
          // deliberately do NO static identifier inference — an expression
          // that needs a fluid property the model does not carry (e.g. k on
          // incompressible) fails over to the fallback h at runtime.
          const exprErr = checkExpression(
            corr.expression,
            `Conductor ${cond.id} custom correlation expression`,
          );
          if (exprErr) errors.push(exprErr);
          // diameter/flowArea are OPTIONAL for custom but positive when set.
          if (corr.diameter !== undefined && !(corr.diameter > 0)) {
            errors.push(
              `Conductor ${cond.id} correlation diameter must be positive`,
            );
          }
          if (corr.flowArea !== undefined && !(corr.flowArea > 0)) {
            errors.push(
              `Conductor ${cond.id} correlation flowArea must be positive`,
            );
          }
          if (corr.params !== undefined) {
            if (
              typeof corr.params !== "object" ||
              corr.params === null ||
              Array.isArray(corr.params)
            ) {
              errors.push(
                `Conductor ${cond.id} custom correlation params must be an object mapping names to finite numbers`,
              );
            } else {
              for (const [key, value] of Object.entries(corr.params)) {
                if (typeof value !== "number" || !Number.isFinite(value)) {
                  errors.push(
                    `Conductor ${cond.id} custom correlation param "${key}" must be a finite number`,
                  );
                }
              }
            }
          }
        } else {
          if (convFluidModel !== "realFluid") {
            errors.push(
              `Conductor ${cond.id} correlation requires realFluid fluid model`,
            );
          }
          if (corr.diameter === undefined || corr.diameter <= 0) {
            errors.push(
              `Conductor ${cond.id} correlation diameter must be positive`,
            );
          }
          if (corr.flowArea !== undefined && corr.flowArea <= 0) {
            errors.push(
              `Conductor ${cond.id} correlation flowArea must be positive`,
            );
          }
          if (corr.expression !== undefined) {
            errors.push(
              `Conductor ${cond.id} correlation expression is only supported for the custom model`,
            );
          }
          if (corr.params !== undefined) {
            errors.push(
              `Conductor ${cond.id} correlation params are only supported for the custom model`,
            );
          }
        }
        if (corr.model === "darrHartwig") {
          // The quench-front distance L = z − z_qf (SPEC §3.4) needs the
          // conductor's axial coordinate — no defensible default exists.
          if (corr.axialPosition === undefined || !(corr.axialPosition >= 0)) {
            errors.push(
              `Conductor ${cond.id} darrHartwig correlation requires axialPosition >= 0 (m from pipe inlet)`,
            );
          }
          if (
            corr.inletLiquidReynolds !== undefined &&
            !(corr.inletLiquidReynolds > 0)
          ) {
            errors.push(
              `Conductor ${cond.id} darrHartwig inletLiquidReynolds must be positive if provided`,
            );
          }
        }
        if (corr.model === "ttWf") {
          // TT-WF: a 1-D network segment
          // with an identifiable axial direction, a wall thermal mass, and
          // a local P,h,G,Tw.  The wetted-fraction state advances once per
          // ACCEPTED transient step, so the model is only defined in
          // transient mode.
          if (config.settings.mode !== "transient") {
            errors.push(
              `Conductor ${cond.id} ttWf correlation requires transient mode (the wetted-fraction state advances per accepted step)`,
            );
          }
          if (corr.axialPosition === undefined || !(corr.axialPosition >= 0)) {
            errors.push(
              `Conductor ${cond.id} ttWf correlation requires axialPosition >= 0 (m from pipe inlet)`,
            );
          }
          if (corr.segmentLength === undefined || !(corr.segmentLength > 0)) {
            errors.push(
              `Conductor ${cond.id} ttWf correlation requires segmentLength > 0 (axial segment length Δz, m)`,
            );
          }
          if (
            corr.inletLiquidReynolds !== undefined &&
            !(corr.inletLiquidReynolds > 0)
          ) {
            errors.push(
              `Conductor ${cond.id} ttWf inletLiquidReynolds must be positive if provided`,
            );
          }
          // Globally-fixed PHYSICAL parameters with pre-registered hard
          // bounds (design §"Candidate Parameters").  Solver numerics
          // (blend widths, smooth-min eps, quality floor) are NOT exposed.
          if (corr.frontEnergyFactor !== undefined) {
            const v = corr.frontEnergyFactor;
            if (!(
              typeof v === "number" &&
              Number.isFinite(v) &&
              v >= 0.25 &&
              v <= 4
            )) {
              errors.push(
                `Conductor ${cond.id} ttWf frontEnergyFactor (C_q) must be in [0.25, 4] (got ${v})`,
              );
            }
          }
          if (corr.rewetHysteresisOffsetK !== undefined) {
            const v = corr.rewetHysteresisOffsetK;
            if (!(
              typeof v === "number" &&
              Number.isFinite(v) &&
              v >= 0 &&
              v <= 5
            )) {
              errors.push(
                `Conductor ${cond.id} ttWf rewetHysteresisOffsetK (ΔT_h) must be in [0, 5] K (got ${v})`,
              );
            }
          }
          // Wall thermal mass: the non-fluid endpoint must be a solid node
          // (ambient nodes are infinite reservoirs — no wall energy E'_q to
          // limit a front).  In transient mode solid nodes already require
          // mass > 0 and cp (checked above).
          const wallId = fromFluid ? cond.to : cond.from;
          const wallNode = (config.solidNodes ?? []).find(
            (s) => s.id === wallId,
          );
          if (!wallNode || wallNode.type !== "solid") {
            errors.push(
              `Conductor ${cond.id} ttWf correlation requires a solid (non-ambient) wall endpoint with thermal mass`,
            );
          }
        }
        // Fluid-front transport gate (docs/fluid-front-transport.md): the
        // transported front fraction is a TT-WF-model state — the flag is
        // meaningless on any other correlation model.
        const ffFlag = (corr as { fluidFront?: boolean }).fluidFront;
        if (ffFlag !== undefined && corr.model !== "ttWf") {
          errors.push(
            `Conductor ${cond.id}: fluidFront gate is only supported for the ttWf correlation model`,
          );
        }
        if (ffFlag !== undefined && typeof ffFlag !== "boolean") {
          errors.push(`Conductor ${cond.id}: fluidFront must be a boolean`);
        }
        if (cond.type.h !== undefined && cond.type.h <= 0) {
          errors.push(
            `Conductor ${cond.id} h (fallback floor) must be positive if provided`,
          );
        }
      } else {
        if (cond.type.h === undefined || cond.type.h <= 0) {
          errors.push(`Conductor ${cond.id} h must be positive`);
        }
      }
      if (cond.type.area <= 0)
        errors.push(`Conductor ${cond.id} area must be positive`);
      const fluidCount = (fromFluid ? 1 : 0) + (toFluid ? 1 : 0);
      if (fluidCount !== 1) {
        errors.push(
          `Conductor ${cond.id} convection must have exactly one fluid endpoint`,
        );
      }
    } else if (cond.type.kind === "radiation") {
      if (cond.type.emissivity <= 0 || cond.type.emissivity > 1)
        errors.push(`Conductor ${cond.id} emissivity must be in (0,1]`);
      if (cond.type.area <= 0)
        errors.push(`Conductor ${cond.id} area must be positive`);
      if (cond.type.viewFactor <= 0 || cond.type.viewFactor > 1)
        errors.push(`Conductor ${cond.id} viewFactor must be in (0,1]`);
      if (fromFluid || toFluid) {
        errors.push(
          `Conductor ${cond.id} radiation endpoints must be solid or ambient nodes`,
        );
      }
    } else {
      errors.push(
        `Conductor ${cond.id} has unknown kind: ${JSON.stringify((cond.type as { kind?: unknown }).kind)}`,
      );
    }
  }

  return errors;
}
