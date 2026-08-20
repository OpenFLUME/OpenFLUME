export type {
  NetworkConfig,
  SteadyResult,
  TransientResult,
  SolidNode,
} from "../core";

/** One entity of a canvas multi-selection: nodes (elements) and
 *  branches/conductors (ties) — the four bulk-editable kinds. */
export type MultiSelectionItem =
  | { kind: "node"; id: string }
  | { kind: "branch"; id: string }
  | { kind: "solidNode"; id: string }
  | { kind: "conductor"; id: string };

export type Selection =
  | { kind: "node"; id: string }
  | { kind: "branch"; id: string }
  | { kind: "group"; id: string }
  | { kind: "solidNode"; id: string }
  | { kind: "conductor"; id: string }
  | { kind: "note"; id: string }
  | { kind: "multi"; items: MultiSelectionItem[] }
  | { kind: "none" };
