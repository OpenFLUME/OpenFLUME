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
 *   3. Construction itself is table-driven: components/registry.ts holds one
 *      exhaustively-typed descriptor per component type, so adding a type
 *      to the schema union without a constructor is a compile error and an
 *      unknown type at runtime throws — never a silently substituted
 *      resistance.
 */

import type { NetworkConfig, ResolvedNetworkConfig } from "./schema";
import type { BranchComponent } from "./components";
import { constructBranchComponent } from "./components/registry";
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
    const { component, inertia } = constructBranchComponent(b.component, {
      branchId: b.id,
      closureParams,
      userDefinition: (name) => instantiateUserDefinition(config, name),
    });
    return { id: b.id, from: b.from, to: b.to, component, inertia };
  });
}
