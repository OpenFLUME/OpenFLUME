/**
 * Match validation-error text to a concrete element id so clicking an issue
 * selects the offender. validate.ts emits plain strings like
 * "Boundary node N1 missing pressure" — best-effort word-boundary match.
 * Shared by the toolbar issues popover and the readiness checklist.
 */
import type { NetworkConfig, Selection } from "./types";

export function matchSelectionFromError(
  message: string,
  config: NetworkConfig,
): Selection | null {
  const candidates: { id: string; kind: Selection["kind"] }[] = [
    ...config.nodes.map((n) => ({ id: n.id, kind: "node" as const })),
    ...config.branches.map((b) => ({ id: b.id, kind: "branch" as const })),
    ...(config.solidNodes ?? []).map((n) => ({
      id: n.id,
      kind: "solidNode" as const,
    })),
    ...(config.conductors ?? []).map((c) => ({
      id: c.id,
      kind: "conductor" as const,
    })),
    ...(config.groups ?? []).map((g) => ({ id: g.id, kind: "group" as const })),
  ];
  let best: { index: number; sel: Selection } | null = null;
  for (const c of candidates) {
    const re = new RegExp(
      `\\b${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    );
    const m = re.exec(message);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, sel: { kind: c.kind, id: c.id } as Selection };
    }
  }
  return best?.sel ?? null;
}
