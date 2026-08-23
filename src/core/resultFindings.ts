/**
 * resultFindings.ts — deterministic reading of a solved result.
 *
 * The companion to modelAdvisor.ts: that one inspects a model before it runs,
 * this one inspects the answer afterwards. Both are pure rules with stated
 * reasons — no heuristics that cannot be explained, no scoring, nothing that
 * changes between runs of the same numbers.
 *
 * A finding is something a reviewer would circle: the loss that dominates the
 * system, a branch flowing backwards, a near-sonic component, mass that does
 * not balance at a junction. Each carries the elements it is about, so the UI
 * can click straight to them, exactly as the readiness checks do.
 *
 * Convergence and staleness are deliberately NOT findings: those are run
 * metadata and the toolbar and run strip already report them.
 */
import type { NetworkConfig, SteadyResult, TransientResult } from "./schema";

export type FindingSeverity = "info" | "warn" | "error";

export interface FindingTarget {
  kind: "node" | "branch" | "solidNode" | "conductor";
  id: string;
}

export interface ResultFinding {
  id: string;
  severity: FindingSeverity;
  /** Short headline, e.g. "Dominant loss". */
  label: string;
  /** One line naming the numbers behind it. */
  detail: string;
  targets: FindingTarget[];
}

/** Mach at or above this is transonic enough to warrant a look. */
const NEAR_SONIC = 0.8;
/** A junction imbalance beyond this fraction of its throughput is suspect. */
const IMBALANCE_FRACTION = 0.01;
/**
 * "Dominant" needs both tests: at least half the total loss AND at least
 * twice the runner-up. An even 50/50 split across two components clears the
 * share bar while being the very opposite of dominant.
 */
const DOMINANT_SHARE = 0.5;
const DOMINANT_MARGIN = 2;
const EPS = 1e-12;

function isTransient(
  result: SteadyResult | TransientResult,
): result is TransientResult {
  return Array.isArray((result as TransientResult).times);
}

/** Steady scalar, or the last finite sample of a transient history. */
function scalarOf(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const v = value[i];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

function fmt(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6))
    return value.toExponential(digits - 1);
  return String(Number(value.toPrecision(digits)));
}

/**
 * Findings for one solved result, most severe first and stable within a
 * severity. `config` supplies labels and topology; the result supplies the
 * numbers. Never throws: a malformed result yields no findings rather than
 * breaking the view that shows them.
 */
export function assessResult(
  config: NetworkConfig | null | undefined,
  result: SteadyResult | TransientResult | null | undefined,
): ResultFinding[] {
  const findings: ResultFinding[] = [];
  try {
    if (!config || !result) return [];
    const branches = Array.isArray(config.branches) ? config.branches : [];
    const nodes = Array.isArray(config.nodes) ? config.nodes : [];
    const branchResults = (result.branches ?? {}) as Record<string, unknown>;
    const at = (id: string, field: string): number | undefined => {
      const rec = branchResults[id];
      if (typeof rec !== "object" || rec === null) return undefined;
      return scalarOf((rec as Record<string, unknown>)[field]);
    };
    const labelOf = (id: string): string => {
      const branch = branches.find((b) => b.id === id);
      const label = branch?.label;
      return typeof label === "string" && label.length > 0 ? label : id;
    };
    const transient = isTransient(result);
    const when = transient ? " at the final step" : "";

    // ── Solver advisories, verbatim: the solver knows things we do not ──
    // Only the steady result declares `warnings` (the transonic second-law
    // audit); reading it defensively keeps one code path for both modes.
    const advisories = (result as { warnings?: unknown }).warnings;
    for (const [i, warning] of (Array.isArray(advisories)
      ? (advisories as string[])
      : []
    ).entries()) {
      findings.push({
        id: `solver-warning-${i}`,
        severity: "warn",
        label: "Solver advisory",
        detail: warning,
        targets: [],
      });
    }

    // ── Reverse flow ───────────────────────────────────────────────────
    const reversed = branches
      .filter((b) => (at(b.id, "mdot") ?? 0) < -EPS)
      .map((b) => b.id);
    if (reversed.length > 0) {
      findings.push({
        id: "reverse-flow",
        severity: "info",
        label: "Reverse flow",
        detail: `${reversed.length} branch${
          reversed.length === 1 ? "" : "es"
        } flow${reversed.length === 1 ? "s" : ""} against the drawn direction${when}: ${reversed
          .slice(0, 4)
          .map(labelOf)
          .join(
            ", ",
          )}${reversed.length > 4 ? "…" : ""}. Legitimate in a loop; a surprise elsewhere.`,
        targets: reversed.map((id) => ({ kind: "branch" as const, id })),
      });
    }

    // ── Near-sonic components ──────────────────────────────────────────
    const sonic = branches
      .map((b) => ({ id: b.id, mach: at(b.id, "mach") }))
      .filter((b): b is { id: string; mach: number } =>
        b.mach !== undefined ? Math.abs(b.mach) >= NEAR_SONIC : false,
      )
      .sort((a, b) => Math.abs(b.mach) - Math.abs(a.mach));
    if (sonic.length > 0) {
      const worst = sonic[0]!;
      findings.push({
        id: "near-sonic",
        severity: Math.abs(worst.mach) >= 1 ? "warn" : "info",
        label: Math.abs(worst.mach) >= 1 ? "Sonic flow" : "Near-sonic flow",
        detail: `${labelOf(worst.id)} reaches Mach ${fmt(Math.abs(worst.mach), 3)}${when}${
          sonic.length > 1
            ? ` (${sonic.length} branches at or above ${NEAR_SONIC})`
            : ""
        }. Compressible effects dominate here.`,
        targets: sonic.map((s) => ({ kind: "branch" as const, id: s.id })),
      });
    }

    // ── Dominant loss ──────────────────────────────────────────────────
    const losses = branches
      .map((b) => ({ id: b.id, dP: Math.abs(at(b.id, "dP") ?? 0) }))
      .filter((b) => b.dP > EPS)
      .sort((a, b) => b.dP - a.dP);
    const totalLoss = losses.reduce((sum, l) => sum + l.dP, 0);
    if (losses.length > 1 && totalLoss > EPS) {
      const top = losses[0]!;
      const runnerUp = losses[1]!;
      const share = top.dP / totalLoss;
      if (share >= DOMINANT_SHARE && top.dP >= DOMINANT_MARGIN * runnerUp.dP) {
        findings.push({
          id: "dominant-loss",
          severity: "info",
          label: "Dominant loss",
          detail: `${labelOf(top.id)} takes ${Math.round(
            share * 100,
          )}% of the network's total pressure drop (${fmt(top.dP)} Pa of ${fmt(
            totalLoss,
          )} Pa). Size this component first.`,
          targets: [{ kind: "branch", id: top.id }],
        });
      }
    }

    // ── Mass imbalance at internal nodes (steady only) ──────────────────
    // In steady state every internal node must conserve mass exactly; a
    // residual there means the solve settled short, not that the physics is
    // interesting. Transient nodes legitimately accumulate.
    if (!transient) {
      const worst: Array<{ id: string; net: number; through: number }> = [];
      for (const node of nodes) {
        if (node.type !== "internal") continue;
        let net = 0;
        let through = 0;
        for (const branch of branches) {
          const mdot = at(branch.id, "mdot");
          if (mdot === undefined) continue;
          if (branch.to === node.id) {
            net += mdot;
            through += Math.abs(mdot);
          }
          if (branch.from === node.id) {
            net -= mdot;
            through += Math.abs(mdot);
          }
        }
        if (through <= EPS) continue;
        if (Math.abs(net) / through > IMBALANCE_FRACTION)
          worst.push({ id: node.id, net, through });
      }
      worst.sort(
        (a, b) => Math.abs(b.net / b.through) - Math.abs(a.net / a.through),
      );
      if (worst.length > 0) {
        const top = worst[0]!;
        findings.push({
          id: "mass-imbalance",
          severity: "error",
          label: "Mass does not balance",
          detail: `${top.id} carries a net ${fmt(top.net)} kg/s against ${fmt(
            top.through,
          )} kg/s through it (${Math.round(
            (Math.abs(top.net) / top.through) * 100,
          )}%). Tighten the tolerance or check the boundary conditions before trusting these numbers.`,
          targets: worst.map((w) => ({ kind: "node" as const, id: w.id })),
        });
      }
    }

    const rank: Record<FindingSeverity, number> = {
      error: 0,
      warn: 1,
      info: 2,
    };
    return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  } catch {
    return findings;
  }
}
