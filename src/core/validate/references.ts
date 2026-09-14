/**
 * Referential integrity — the invariants the EDITOR maintains, checked on
 * their own so a document boundary can accept work in progress without
 * accepting a network the editor could never have produced.
 *
 * `validateNetwork` answers "can the solver run this?" and is the wrong
 * question for opening a file: a model with no boundary node yet, or a
 * transient without volumes, is an ordinary half-finished state that Save
 * wrote without complaint and must reopen. A branch whose endpoint does not
 * exist is different in kind — every editor operation preserves endpoint
 * existence (removing a node removes its incident branches), so the canvas
 * assumes it and a violation is not "unfinished", it is malformed.
 *
 * Kept deliberately small: element ids unique within their namespace, and
 * every reference to another element resolvable.
 */
import type { NetworkConfig } from "../schema";

export function validateReferences(config: NetworkConfig): string[] {
  const errors: string[] = [];

  const fluidIds = new Set<string>();
  for (const node of config.nodes) {
    if (fluidIds.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    fluidIds.add(node.id);
  }
  const thermalIds = new Set<string>(fluidIds);
  for (const solid of config.solidNodes ?? []) {
    if (thermalIds.has(solid.id)) errors.push(`Duplicate node id: ${solid.id}`);
    thermalIds.add(solid.id);
  }

  const branchIds = new Set<string>();
  for (const branch of config.branches) {
    if (branchIds.has(branch.id))
      errors.push(`Duplicate branch id: ${branch.id}`);
    branchIds.add(branch.id);
    for (const end of [branch.from, branch.to]) {
      if (!fluidIds.has(end))
        errors.push(`Branch ${branch.id} references missing node: ${end}`);
    }
  }

  const conductorIds = new Set<string>();
  for (const cond of config.conductors ?? []) {
    if (conductorIds.has(cond.id))
      errors.push(`Duplicate conductor id: ${cond.id}`);
    conductorIds.add(cond.id);
    for (const end of [cond.from, cond.to]) {
      if (!thermalIds.has(end))
        errors.push(`Conductor ${cond.id} references missing node: ${end}`);
    }
  }

  const groupIds = new Set<string>();
  for (const group of config.groups ?? []) {
    if (groupIds.has(group.id)) errors.push(`Duplicate group id: ${group.id}`);
    groupIds.add(group.id);
  }
  const checkGroup = (kind: string, id: string, group: string | undefined) => {
    if (group !== undefined && !groupIds.has(group))
      errors.push(`${kind} ${id} references missing group: ${group}`);
  };
  for (const node of config.nodes) checkGroup("Node", node.id, node.group);
  for (const solid of config.solidNodes ?? [])
    checkGroup("Node", solid.id, solid.group);
  for (const note of config.notes ?? [])
    checkGroup("Note", note.id, note.group);

  return errors;
}
