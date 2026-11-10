/**
 * External-transport real fluids.
 *
 * Some CoolProp HEOS fluids (for example R21, the Shuttle radiator coolant)
 * ship density, specific heat and enthalpy but no viscosity or thermal
 * conductivity.  By default validation rejects them (fluidSpec.ts) because a
 * solve would silently use zero transport.  A network that never needs the
 * fluid's own viscosity or conductivity — imposed-flow (flowSource) branches
 * and a custom convection expression that carries its own mu(T) and k(T) —
 * can opt in with `fluid.params.transport = "external"`.
 *
 * Opting in is a promise, so this pass enforces it.  On a fluid with external
 * transport every branch component must be one that never reads viscosity,
 * and every convection conductor must either use a literal h or the `custom`
 * model with an expression that does not read the built-in `mu`, `k`, `Pr` or
 * `Re` (those identifiers are zero or absent for a fluid without a transport
 * model, and an expression reading them would silently fall back to the
 * conductor's fallback h).
 */
import type { ResolvedNetworkConfig } from "../schema";
import { resolveFluidSpec } from "../fluidAssignment";
import { parseExpression, type ExprNode } from "../usercode/expression";

/** Value of `fluid.params.transport` that declares user-supplied transport. */
export const EXTERNAL_TRANSPORT = "external";

/**
 * Branch component types whose closures depend on density and flow only, never
 * on viscosity (checked against src/core/components).  Everything else is
 * rejected on an external-transport fluid, including any component type added
 * later until it is reviewed and listed here.
 */
export const VISCOSITY_FREE_COMPONENTS: ReadonlySet<string> = new Set([
  "flowSource",
  "orifice",
  "resistance",
  "valve",
  "checkValve",
  "dynamicCheckValve",
  "reliefValve",
  "pump",
  "areaChange",
  "regulator",
  "cavitatingVenturi",
  "dpTable",
]);

/** Scope identifiers that carry the fluid's built-in transport. */
const BUILTIN_TRANSPORT_IDENTIFIERS = ["mu", "k", "Pr", "Re"] as const;

function identifiers(node: ExprNode, out: Set<string>): void {
  switch (node.type) {
    case "ident":
      out.add(node.name);
      return;
    case "unary":
      identifiers(node.arg, out);
      return;
    case "binary":
      identifiers(node.left, out);
      identifiers(node.right, out);
      return;
    case "cond":
      identifiers(node.cond, out);
      identifiers(node.then, out);
      identifiers(node.else, out);
      return;
    case "call":
      // The callee is a builtin or scope function name, not a quantity.
      if (node.callee.type !== "ident") identifiers(node.callee, out);
      for (const a of node.args) identifiers(a, out);
      return;
    case "prop":
      identifiers(node.object, out);
      return;
    default:
      return;
  }
}

export function validateExternalTransport(
  config: ResolvedNetworkConfig,
): string[] {
  const isExternal = (node: { fluid?: string }): boolean => {
    const spec = resolveFluidSpec(config, node);
    return (
      spec.model === "realFluid" &&
      spec.params?.transport === EXTERNAL_TRANSPORT
    );
  };
  if (!config.nodes.some(isExternal)) return [];

  const errors: string[] = [];
  const nodeById = new Map(config.nodes.map((n) => [n.id, n]));

  for (const b of config.branches) {
    const from = nodeById.get(b.from);
    if (!from || !isExternal(from)) continue;
    const type = (b.component as { type: string }).type;
    if (!VISCOSITY_FREE_COMPONENTS.has(type)) {
      errors.push(
        `Branch ${b.id}: component "${type}" needs the fluid viscosity, but the fluid has params.transport = "${EXTERNAL_TRANSPORT}" ` +
          `(no built-in transport). Use a flowSource (or another viscosity-free component) or pick a fluid with a transport model.`,
      );
    }
  }

  for (const c of config.conductors ?? []) {
    if (c.type.kind !== "convection") continue;
    const fluidEnd = [nodeById.get(c.from), nodeById.get(c.to)].find(
      (n) => n !== undefined && isExternal(n),
    );
    if (!fluidEnd) continue;
    const corr = c.type.correlation;
    if (!corr) continue; // literal h needs no transport
    if (corr.model !== "custom") {
      errors.push(
        `Conductor ${c.id}: convection model "${corr.model}" needs the fluid viscosity and conductivity, but fluid node ${fluidEnd.id} ` +
          `has params.transport = "${EXTERNAL_TRANSPORT}". Use the "custom" model with your own mu(T) and k(T), or a literal h.`,
      );
      continue;
    }
    let found: string[] = [];
    try {
      const ids = new Set<string>();
      identifiers(parseExpression(corr.expression ?? ""), ids);
      found = BUILTIN_TRANSPORT_IDENTIFIERS.filter((n) => ids.has(n));
    } catch {
      // Parse errors are reported by the conductor validator.
    }
    if (found.length > 0) {
      errors.push(
        `Conductor ${c.id}: the custom h expression reads ${found.join(", ")}, which is not available for fluid node ${fluidEnd.id} ` +
          `(params.transport = "${EXTERNAL_TRANSPORT}" means no built-in viscosity or conductivity). Compute them in the expression ` +
          `from Tf and params.`,
      );
    }
  }
  return errors;
}
