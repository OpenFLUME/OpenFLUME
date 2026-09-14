/**
 * Branch-component registry: one entry per member of the `component` union
 * in schema.ts, keyed by `type`.
 *
 * The mapped `ComponentRegistry` type is exhaustive in both directions — a
 * new union member without a registry entry, or an entry for a type the
 * schema does not have, is a compile error — so this is the place a new
 * component is plugged in, replacing the if/else chain the factory used to
 * carry. Each descriptor receives its OWN config variant fully narrowed;
 * the single cast that reconciles the discriminant with the descriptor
 * lives in `constructBranchComponent` and nowhere else.
 *
 * Today a descriptor knows how to construct the runtime component and
 * whether the branch carries fluid inertia. It is the seam for the other
 * per-type concerns that still live in parallel chains (semantic validation
 * in validate/branches.ts, formula-bindable fields in paramBindings.ts).
 */
import type { ResolvedNetworkConfig } from "../schema";
import type { BranchComponent } from "./branchComponent";
import type { ResolvedClosureParams } from "../closureParams";
import type { UserComponentDefinition } from "../usercode/sandbox";
import { Pipe } from "./pipe";
import { Orifice } from "./orifice";
import { FlowResistance } from "./flowResistance";
import { Valve } from "./valve";
import { CheckValve } from "./checkValve";
import { DynamicCheckValve } from "./dynamicCheckValve";
import { Pump } from "./pump";
import { Bend } from "./bend";
import { AreaChange } from "./areaChange";
import { FlowSource } from "./flowSource";
import { Regulator } from "./regulator";
import { ReliefValve } from "./reliefValve";
import { CavitatingVenturi } from "./cavitatingVenturi";
import { HeatedPipe } from "./heatedPipe";
import { DpTable } from "./dpTable";
import { CustomResistance } from "./customResistance";
import { UserDefinedComponent } from "./userDefinedComponent";

/** The `component` field of a branch AFTER formula resolution: every
 *  NumberOrExpression is a plain number. */
export type ResolvedBranchComponentConfig =
  ResolvedNetworkConfig["branches"][number]["component"];

export type ComponentType = ResolvedBranchComponentConfig["type"];
export type ComponentConfigOf<T extends ComponentType> = Extract<
  ResolvedBranchComponentConfig,
  { type: T }
>;

/** What a constructor may need beyond its own config. */
export interface ConstructEnv {
  branchId: string;
  closureParams: ResolvedClosureParams;
  /** Compiles a FRESH user-component definition for this branch (see
   *  componentFactory.ts for why per-branch compilation matters). */
  userDefinition: (name: string) => UserComponentDefinition;
}

export interface ComponentDescriptor<T extends ComponentType> {
  construct: (c: ComponentConfigOf<T>, env: ConstructEnv) => BranchComponent;
  /** True when the branch's ṁ is a dynamic state ((L/A)·dṁ/dt). */
  inertia?: (c: ComponentConfigOf<T>) => boolean | undefined;
}

export type ComponentRegistry = {
  [T in ComponentType]: ComponentDescriptor<T>;
};

export const COMPONENT_REGISTRY: ComponentRegistry = {
  pipe: {
    construct: (c, env) =>
      new Pipe(
        c.length,
        c.diameter,
        c.roughness,
        c.elevationChange ?? 0,
        env.closureParams.swameeJain,
        c.frictionFactor,
        c.diameterOut,
      ),
    inertia: (c) => c.inertia,
  },
  orifice: { construct: (c) => new Orifice(c.area, c.cd) },
  cavitatingVenturi: {
    construct: (c) =>
      new CavitatingVenturi(c.throatArea, c.cd, c.recoveryFactor ?? 0.0),
  },
  resistance: { construct: (c) => new FlowResistance(c.k, c.area) },
  valve: {
    construct: (c) => new Valve(c.area, c.cd, c.position, c.positionSchedule),
  },
  checkValve: { construct: (c) => new CheckValve(c.area, c.cd) },
  dynamicCheckValve: {
    construct: (c) =>
      new DynamicCheckValve(
        c.area,
        c.cd,
        c.mass,
        c.springRate,
        c.preload,
        c.damping,
        c.stroke,
        c.discArea,
        c.initialPosition ?? 0,
      ),
  },
  reliefValve: {
    construct: (c) =>
      new ReliefValve(c.crackPressure, c.fullOpenPressure, c.area, c.cd),
  },
  pump: { construct: (c) => new Pump(c.curve) },
  bend: {
    construct: (c, env) =>
      new Bend(
        c.diameter,
        c.angle,
        c.rOverD,
        c.roughness ?? 0,
        env.closureParams.swameeJain,
      ),
  },
  areaChange: { construct: (c) => new AreaChange(c.areaIn, c.areaOut) },
  flowSource: {
    construct: (c) => new FlowSource(c.massFlow, c.massFlowSchedule),
  },
  regulator: { construct: (c) => new Regulator(c.setPressure, c.maxCdA) },
  heatedPipe: {
    construct: (c, env) =>
      new HeatedPipe(
        c.length,
        c.diameter,
        c.roughness,
        c.elevationChange ?? 0,
        c.ua,
        c.wallTemperature,
        c.boilingModel,
        env.closureParams,
      ),
  },
  dpTable: {
    construct: (c) => new DpTable(c.points, c.extrapolate ?? "clamp"),
  },
  customResistance: {
    construct: (c) => new CustomResistance(c.k, c.area, c.diameter),
  },
  userComponent: {
    construct: (c, env) =>
      new UserDefinedComponent(env.userDefinition(c.component), {
        params: c.params,
        area: c.area,
        sourceId: `branch ${env.branchId} (${c.component})`,
      }),
  },
};

/** The one place the discriminant is reconciled with its descriptor. */
export function constructBranchComponent(
  c: ResolvedBranchComponentConfig,
  env: ConstructEnv,
): { component: BranchComponent; inertia?: boolean } {
  const descriptor = COMPONENT_REGISTRY[c.type] as
    ComponentDescriptor<ComponentType> | undefined;
  if (!descriptor) {
    // Never silently substitute a resistance for a component type this
    // solver build does not know (validate.ts reports unknown types
    // earlier; this is the solver-side guard).
    throw new Error(
      `Branch ${env.branchId}: unknown component type "${(c as { type: string }).type}"`,
    );
  }
  return {
    component: descriptor.construct(c, env),
    inertia: descriptor.inertia?.(c),
  };
}
