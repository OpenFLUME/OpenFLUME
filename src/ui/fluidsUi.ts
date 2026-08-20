import type { FluidSpec, NetworkConfig } from "../core";

/** Short display label for a fluid spec (model / preset / CoolProp name). */
export function fluidSpecLabel(spec: FluidSpec): string {
  if (spec.model === "realFluid") {
    const name = spec.params?.fluidName;
    return typeof name === "string" && name.length > 0 ? name : "realFluid";
  }
  if (spec.preset) return spec.preset;
  return spec.model;
}

export function namedFluidNames(config: NetworkConfig): string[] {
  return config.fluids ? Object.keys(config.fluids) : [];
}

export function defaultFluidLabel(config: NetworkConfig): string {
  return `Default (${fluidSpecLabel(config.fluid)})`;
}

/** First unused `fluid2`, `fluid3`, … name. */
export function nextNamedFluidName(config: NetworkConfig): string {
  const taken = new Set(namedFluidNames(config));
  let i = 2;
  while (taken.has(`fluid${i}`)) i += 1;
  return `fluid${i}`;
}

/** Results-panel summary: default plus named fluids actually assigned. */
export function fluidsSummary(config: NetworkConfig): string {
  const names = namedFluidNames(config);
  if (names.length === 0) return fluidSpecLabel(config.fluid);
  const used = new Set<string>();
  for (const node of config.nodes) {
    if (node.fluid) used.add(node.fluid);
  }
  const extras = names.filter((n) => used.has(n));
  const parts = [fluidSpecLabel(config.fluid), ...extras];
  return parts.join(", ");
}
