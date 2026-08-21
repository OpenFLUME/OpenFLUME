/**
 * Branch-component factory (extracted from solver.ts buildSolverContext).
 *
 * Responsibilities, all in ONE place:
 *
 *   1. CENTRAL library preflight: every userComponent branch references a
 *      componentLibrary entry; all referenced entries are resolved up front
 *      so a missing/typo'd reference fails loudly BEFORE any branch is
 *      constructed (validate.ts reports the same error earlier; this is the
 *      solver-side guard).
 *   2. PER-BRANCH instantiation: the definition backing each userComponent
 *      branch is compiled FRESH for that branch.  A defineComponent body may
 *      close over mutable state (e.g. a call counter); compiling once and
 *      sharing the definition across branches would couple otherwise
 *      independent branches through that hidden state.  Per-branch
 *      compilation gives every branch an isolated closure — see the purity
 *      contract on UserDefinedComponent (components/index.ts).
 *   3. Unknown component types throw — never silently substitute a
 *      resistance for a component type this solver build does not know.
 *
 * Numerical behaviour is unchanged: the same component classes are
 * constructed with the same arguments as the former inline code.
 */

import type { NetworkConfig, ResolvedNetworkConfig } from "./schema";
import type { BranchComponent } from "./components";
import {
  Pipe,
  Orifice,
  FlowResistance,
  Valve,
  CheckValve,
  DynamicCheckValve,
  Pump,
  Bend,
  AreaChange,
  FlowSource,
  Regulator,
  ReliefValve,
  OrificeCompressible,
  CavitatingVenturi,
  HeatedPipe,
  DpTable,
  CustomResistance,
  UserDefinedComponent,
} from "./components";
import {
  compileUserComponent,
  compileInlinePressureDrop,
} from "./usercode/sandbox";
import type { UserComponentDefinition } from "./usercode/sandbox";
import type { ResolvedClosureParams } from "./closureParams";

export interface BuiltBranch {
  id: string;
  from: string;
  to: string;
  component: BranchComponent;
  inertia?: boolean;
}

/**
 * Central preflight: verify that every userComponent branch references an
 * existing componentLibrary entry, BEFORE any branch (or user code) is
 * instantiated.  Throws on the first missing reference, naming the branch.
 */
function preflightLibraryReferences(config: NetworkConfig): void {
  for (const b of config.branches) {
    const c = b.component;
    if (
      c.type === "userComponent" &&
      (!config.componentLibrary ||
        !Object.hasOwn(config.componentLibrary, c.component))
    ) {
      throw new Error(
        `Branch ${b.id}: unknown componentLibrary entry "${c.component}"`,
      );
    }
  }
}

/**
 * Compile a FRESH definition instance for ONE branch.  Compilation executes
 * the defineComponent body (usercode/sandbox.ts), so one compile per branch
 * is what isolates per-branch closure state; library sources are never
 * shared as live definition objects between branches.
 */
function instantiateUserDefinition(
  config: NetworkConfig,
  name: string,
): UserComponentDefinition {
  // Presence was verified by preflightLibraryReferences.
  const entry = config.componentLibrary![name]!;
  const sourceId = `componentLibrary/${name}`;
  return entry.format === "inline"
    ? {
        metadata: { name },
        pressureDrop: compileInlinePressureDrop(entry.code, sourceId),
      }
    : compileUserComponent(entry.code, sourceId);
}

/** Instantiate the BranchComponent for every configured branch (in order). */
export function buildBranchComponents(
  config: ResolvedNetworkConfig,
  closureParams: ResolvedClosureParams,
): BuiltBranch[] {
  preflightLibraryReferences(config);

  return config.branches.map((b) => {
    let comp: BranchComponent;
    const c = b.component;
    let inertia: boolean | undefined;
    if (c.type === "pipe") {
      comp = new Pipe(
        c.length,
        c.diameter,
        c.roughness,
        c.elevationChange ?? 0,
        closureParams.swameeJain,
        c.frictionFactor,
        c.diameterOut,
      );
      inertia = c.inertia;
    } else if (c.type === "orifice") comp = new Orifice(c.area, c.cd);
    else if (c.type === "orificeCompressible")
      comp = new OrificeCompressible(c.area, c.cd);
    else if (c.type === "cavitatingVenturi")
      comp = new CavitatingVenturi(c.throatArea, c.cd, c.recoveryFactor ?? 0.0);
    else if (c.type === "resistance") comp = new FlowResistance(c.k, c.area);
    else if (c.type === "valve")
      comp = new Valve(c.area, c.cd, c.position, c.positionSchedule);
    else if (c.type === "checkValve") comp = new CheckValve(c.area, c.cd);
    else if (c.type === "dynamicCheckValve")
      comp = new DynamicCheckValve(
        c.area,
        c.cd,
        c.mass,
        c.springRate,
        c.preload,
        c.damping,
        c.stroke,
        c.discArea,
        c.initialPosition ?? 0,
      );
    else if (c.type === "reliefValve")
      comp = new ReliefValve(c.crackPressure, c.fullOpenPressure, c.area, c.cd);
    else if (c.type === "pump") comp = new Pump(c.curve);
    else if (c.type === "bend")
      comp = new Bend(
        c.diameter,
        c.angle,
        c.rOverD,
        c.roughness ?? 0,
        closureParams.swameeJain,
      );
    else if (c.type === "areaChange")
      comp = new AreaChange(c.areaIn, c.areaOut);
    else if (c.type === "flowSource")
      comp = new FlowSource(c.massFlow, c.massFlowSchedule);
    else if (c.type === "regulator")
      comp = new Regulator(c.setPressure, c.maxCdA);
    else if (c.type === "heatedPipe")
      comp = new HeatedPipe(
        c.length,
        c.diameter,
        c.roughness,
        c.elevationChange ?? 0,
        c.ua,
        c.wallTemperature,
        c.boilingModel,
        closureParams,
      );
    else if (c.type === "dpTable")
      comp = new DpTable(c.points, c.extrapolate ?? "clamp");
    else if (c.type === "customResistance")
      comp = new CustomResistance(c.k, c.area, c.diameter);
    else if (c.type === "userComponent") {
      comp = new UserDefinedComponent(
        instantiateUserDefinition(config, c.component),
        {
          params: c.params,
          area: c.area,
          sourceId: `branch ${b.id} (${c.component})`,
        },
      );
    } else {
      // Never silently substitute a resistance for a component type this
      // solver build does not know (validate.ts reports unknown types
      // earlier; this is the solver-side guard).
      throw new Error(
        `Branch ${b.id}: unknown component type "${(c as { type: string }).type}"`,
      );
    }
    return { id: b.id, from: b.from, to: b.to, component: comp, inertia };
  });
}
