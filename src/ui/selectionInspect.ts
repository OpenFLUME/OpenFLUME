import type {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "./types";
import {
  listChannels,
  type ChannelDescriptor,
  type ChannelEntityKind,
} from "./channels";

type InspectableSelectionKind = ChannelEntityKind;

export function hasInspectableResult(
  result: SteadyResult | TransientResult | null | undefined,
): boolean {
  if (!result?.converged) return false;
  return "times" in result ? result.times.length >= 2 : true;
}

function inferredItems(
  config: NetworkConfig,
  ids: readonly string[],
): Array<{ kind: InspectableSelectionKind; id: string }> {
  const items: Array<{ kind: InspectableSelectionKind; id: string }> = [];
  for (const id of ids) {
    if (config.nodes.some((node) => node.id === id))
      items.push({ kind: "node", id });
    if (config.branches.some((branch) => branch.id === id))
      items.push({ kind: "branch", id });
    if (config.solidNodes?.some((node) => node.id === id))
      items.push({ kind: "solidNode", id });
    if (config.conductors?.some((conductor) => conductor.id === id))
      items.push({ kind: "conductor", id });
  }
  return items;
}

/** All result channels belonging to the current canvas selection. */
export function channelsForSelection(
  config: NetworkConfig,
  result: SteadyResult | TransientResult | null | undefined,
  selection: Selection,
  canvasSelection: readonly string[] = [],
): ChannelDescriptor[] {
  if (!result) return [];

  const items =
    selection.kind === "multi"
      ? selection.items
      : selection.kind === "node" ||
          selection.kind === "branch" ||
          selection.kind === "solidNode" ||
          selection.kind === "conductor"
        ? [{ kind: selection.kind, id: selection.id }]
        : inferredItems(config, canvasSelection);

  const selected = new Set(items.map((item) => `${item.kind}\0${item.id}`));
  return listChannels(config, result).filter((descriptor) =>
    selected.has(`${descriptor.channel.entity}\0${descriptor.channel.id}`),
  );
}
