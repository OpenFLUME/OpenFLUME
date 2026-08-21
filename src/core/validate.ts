/**
 * Network configuration validation — public entry point.
 *
 * The implementation lives in ./validate/, one module per concern, run in
 * this order by `validateResolvedNetwork` below (later sections depend on
 * id sets built by earlier ones — nodes/solidNodes/branches feed the
 * topology model and the reference checks in conductors/controllers):
 *
 *   validate/fluidSpec.ts        Default + named fluid model/catalogue checks
 *   validate/nodes.ts            Fluid-node ids, groups, boundary completeness
 *   validate/solidNodes.ts       Solid/ambient node ids and transient reqs
 *   validate/species.ts          Species/chemistry array + reaction checks
 *   validate/transientSettings.ts  settings.dt / settings.adaptive / endTime
 *   validate/branches.ts         Branch endpoints + per-component-type ranges
 *   validate/conductors.ts       Conductor endpoints + per-kind checks
 *                                 (conduction/convection/radiation, including
 *                                 the darrHartwig/ttWf/custom correlation models)
 *   validate/logic.ts            Register + LogicRule expression checks
 *   validate/controllers.ts      PID/register controller reference/range checks
 *   validate/junctions.ts        Reacting-junction reference/type/fluid checks
 *   validate/componentLibrary.ts Declarative component-library syntax checks
 *   validate/expressions.ts      Shared checkExpression() parse-only helper
 *
 * Every validator returns `string[]` (empty = no errors from that section);
 * this file only threads the id sets between them and concatenates.
 */
import type { NetworkConfig, ResolvedNetworkConfig } from "./schema";
import { validateClosureParams } from "./closureParams";
import { createTopologyModel } from "./topology";
import { resolveNetworkParameters } from "./paramBindings";
import { validateFluids } from "./validate/fluidSpec";
import { validateNodes } from "./validate/nodes";
import { validateSolidNodes } from "./validate/solidNodes";
import { validateSpecies } from "./validate/species";
import { validateTransientSettings } from "./validate/transientSettings";
import { validateBranches } from "./validate/branches";
import { validateConductors } from "./validate/conductors";
import { validateRegistersAndLogic } from "./validate/logic";
import { validateControllers } from "./validate/controllers";
import { validateJunctions } from "./validate/junctions";
import { validateComponentLibrary } from "./validate/componentLibrary";

/**
 * Semantically validate a decoded network configuration.
 *
 * Checks boundary-condition completeness (every boundary node anchors
 * pressure and temperature), id uniqueness across fluid/solid nodes,
 * branches, conductors, and groups, reference integrity (branch/conductor
 * endpoints, node groups, species names, component-library and controller
 * targets), per-component parameter ranges, schedule ordering, mode-specific
 * requirements (node volumes and solid masses in transient mode), and
 * fluid-model/feature compatibility (e.g. species requires `idealGas`,
 * `cavitatingVenturi` requires `realFluid`).
 *
 * The input must already be structurally sound — pass untrusted data through
 * {@link decodeNetworkConfig} first so structural problems surface as thrown
 * ConfigDecodeErrors at the boundary instead of crashing this walk.
 *
 * Formula bindings (core/paramBindings.ts, NumberOrExpression fields) are
 * resolved FIRST: any formula error is returned as-is and no semantic checks
 * run, otherwise all checks below run against the resolved numeric clone —
 * so range/reference errors always describe the numbers the solver would
 * see.  Resolution never calls back into this function (no recursion).
 *
 * @param config - Structurally decoded network configuration
 * @returns Human-readable error strings; an empty array means the network
 *   is valid and ready to solve
 */
export function validateNetwork(config: NetworkConfig): string[] {
  const resolution = resolveNetworkParameters(config);
  if (!resolution.ok) return resolution.errors;
  return validateResolvedNetwork(resolution.config);
}

/**
 * Semantic validation of a config whose formula bindings are already
 * resolved (all NumberOrExpression fields are plain numbers).
 */
function validateResolvedNetwork(config: ResolvedNetworkConfig): string[] {
  const errors: string[] = [];

  if (!config.nodes || config.nodes.length === 0) {
    errors.push("No nodes defined");
    return errors;
  }

  errors.push(...validateFluids(config));

  const {
    errors: nodeErrors,
    nodeIds,
    boundaryIds,
    groupIds,
  } = validateNodes(config);
  errors.push(...nodeErrors);

  const { errors: solidErrors, solidNodeIds } = validateSolidNodes(
    config,
    nodeIds,
    groupIds,
  );
  errors.push(...solidErrors);

  // Endpoint classification is single-sourced in core/topology.ts (shared
  // with the UI connection rules): fluid-node ids vs thermal-node ids.
  const topology = createTopologyModel(nodeIds, solidNodeIds);

  if (boundaryIds.size === 0) {
    errors.push("No boundary nodes defined");
  }

  errors.push(...validateSpecies(config));
  errors.push(...validateTransientSettings(config));

  const { errors: branchErrors, branchIds } = validateBranches(
    config,
    topology,
  );
  errors.push(...branchErrors);

  errors.push(...validateConductors(config, topology));

  errors.push(...validateRegistersAndLogic(config));

  const allNodeIds = new Set<string>([...nodeIds, ...solidNodeIds]);
  errors.push(
    ...validateControllers(config, {
      nodeIds,
      boundaryIds,
      branchIds,
      allNodeIds,
    }),
  );

  errors.push(
    ...validateJunctions(config, { nodeIds, boundaryIds, branchIds }),
  );

  errors.push(...validateComponentLibrary(config));

  if (config.closureParams !== undefined) {
    errors.push(...validateClosureParams(config.closureParams));
  }

  return errors;
}
