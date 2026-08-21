/**
 * convergenceDiary.ts — pure, lightweight convergence-diary domain core.
 *
 * A RunDiary is a bounded, deterministic, wall-clock-free log of what a
 * solve did, derived ONLY from evidence that already crosses the worker
 * boundary today:
 *
 *   - live:  the throttled ProgressPayload stream (workerClient.ts) plus the
 *            final SteadyResult / TransientResult (core/schema.ts);
 *   - offline: buildDiaryFromResult(config, result) synthesizes a
 *            final-evidence diary for results obtained without a live
 *            collector (sweep variants, promoted runs) — clearly labeled,
 *            with no fabricated progress milestones.
 *
 * Design constraints (POC):
 *   - NO inner-loop instrumentation: nothing here requires solver changes;
 *     steady events are gated on residual-decade crossings, transient events
 *     on end-time quartiles, so a throttled ~10 Hz progress stream yields a
 *     handful of events, never one per callback.
 *   - Hard bounded retention (DIARY_EVENT_CAP, default 200) with an explicit
 *     eviction policy that protects lifecycle anchors and warnings.
 *   - Deterministic: identical progress streams + result ⇒ identical diary
 *     (no Date.now, no Math.random, insertion-ordered keys).
 *   - No wall-clock fields anywhere; ordering is by a logical `seq` plus a
 *     solver coordinate (steady iteration / transient time+step).
 *   - Never emits NaN/Infinity and never throws on degenerate input:
 *     non-finite numbers are dropped from data (null) or omitted (summary).
 *
 * This module is pure: no DOM, no worker protocol, no store.  Formatting
 * helpers return plain strings/objects; wiring to Toolbar/Results UI is a
 * later integration step.
 */
import type { NetworkConfig, SteadyResult, TransientResult } from "../core";
import { formatSig } from "./format";
import { configHash, settingsSummary } from "./provenance";
import { isTransientResult } from "./runHistory";

/* ------------------------------------------------------------------ */
/* Constants / policy knobs                                            */
/* ------------------------------------------------------------------ */

/** Diary schema version. */
export const DIARY_VERSION = 1 as const;

/** Hard retention cap on retained events (default). */
export const DIARY_EVENT_CAP = 200;

/** Max characters in any event message / digest line. */
export const DIARY_MESSAGE_CAP = 240;

/** Max characters carried from an external (worker/user) message. */
export const EXTERNAL_MESSAGE_CAP = 120;

/**
 * Steady stall rule (progress-only, defensible): a stall warning is raised
 * when the best residual has not improved by at least STALL_IMPROVEMENT_FACTOR
 * over STALL_SAMPLE_THRESHOLD consecutive progress samples.  Progress samples
 * are the throttled ~10 Hz worker callbacks, NOT solver iterations — messages
 * say "progress samples" to stay honest.
 */
export const STALL_SAMPLE_THRESHOLD = 10;
export const STALL_IMPROVEMENT_FACTOR = 0.5;

/** Residual ≥ REBOUND_FACTOR × running best ⇒ rebound notice. */
export const REBOUND_FACTOR = 10;

/** Consecutive dt samples differing by ≥ this factor count as a large change. */
export const DT_LARGE_CHANGE_FACTOR = 4;

/**
 * Fixed-stepping per-step scaled-residual warning bar.  Reference: the
 * schema comment on TransientResult.stepResidualsScaled — genuinely
 * converged steps sit at ~1e-6…1e-4, stalled steps at ≥ 1e-2 (see also the
 * solver.ts convergence-flag comment: ~1000× separation between the two
 * regimes, so the bar is robust to exact placement).
 */
export const STEP_RESIDUAL_SCALED_WARN = 1e-2;

/** Sparse transient progress milestones: quartiles of endTime / totalSteps. */
export const TRANSIENT_MILESTONE_FRACTIONS = [0.25, 0.5, 0.75] as const;

/** Relative tolerance for the end-reached comparison (same value the sweep
 *  summary uses; the final adaptive step lands exactly on endTime, this only
 *  absorbs float accumulation in hand-built results). */
const END_TIME_REL_TOL = 1e-9;

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

export type DiaryMode = "steady" | "transient";

export type DiarySeverity = "info" | "notice" | "warning";

export type DiaryCategory =
  "lifecycle" | "convergence" | "timeStepping" | "stepControl";

/** Solver coordinate of an event — discriminated by run mode. */
export type DiaryCoordinate =
  | { kind: "steady"; iteration: number }
  | { kind: "transient"; time: number; step: number };

export type DiaryEventKind =
  /* lifecycle */
  | "runStart"
  | "runFinish"
  | "progressMilestone"
  | "finalEvidenceOnly"
  /* steady convergence */
  | "residualDecade"
  | "residualStall"
  | "residualRebound"
  | "residualNonFinite"
  /* transient time stepping / step control */
  | "dtObservation"
  | "rejectedSteps"
  | "dtMinHits"
  | "accuracyLimited"
  /* transient per-step convergence (fixed stepping) */
  | "stepResidualHigh";

export type DiaryOutcome =
  | "running"
  | "converged"
  | "notConverged"
  | "aborted"
  | "userTerminated"
  | "stoppedShort"
  | "cancelled"
  | "error";

/** Small structured payload attached to an event.  Numbers are guaranteed
 *  finite or null (never NaN/Infinity); strings are pre-sanitized. */
export type DiaryEventData = Record<string, number | string | boolean | null>;

export interface DiaryEvent {
  /** Logical sequence number: 0-based, gap-free and ordered over the
   *  retained events of a built diary (renumbered at snapshot/finalize time,
   *  so cap evictions never leave holes in a consumer-facing diary). */
  seq: number;
  kind: DiaryEventKind;
  category: DiaryCategory;
  severity: DiarySeverity;
  at: DiaryCoordinate;
  /** Plain text, control characters stripped, capped at DIARY_MESSAGE_CAP. */
  message: string;
  data?: DiaryEventData;
  /** > 1 when repeated same-kind occurrences were coalesced into this event. */
  count?: number;
}

export interface DiarySummary {
  outcome: DiaryOutcome;
  /** One-line human digest, e.g. "converged · 42 iter · res 3.2e-9". */
  digest: string;
  /** Retained events with severity 'warning'. */
  warningCount: number;
  /** Progress callbacks consumed before finalization. */
  progressUpdates: number;
  /** True for cancel/error finalization (evidence ends at last progress). */
  partial?: boolean;
  /* Steady final evidence (undefined when unavailable/non-finite). */
  iterations?: number;
  residual?: number;
  ptcActive?: boolean;
  ptcFinalDeltaTau?: number;
  ptcShrinks?: number;
  /* Transient final evidence. */
  steps?: number;
  rejectedSteps?: number;
  minDt?: number;
  maxDt?: number;
  dtAtMinCount?: number;
  accuracyLimited?: boolean;
  reachedEnd?: boolean;
  lastTime?: number;
}

export interface DiaryProvenance {
  modelName: string;
  /** FNV-1a/64 of the canonical config JSON (same label as run records). */
  configHash: string;
  /** Compact solver-settings summary ("tol=…; maxIter=…; …"). */
  settingsSummary: string;
  /** Real SHA-256 when the caller computed one (async); absent otherwise. */
  configSha256?: string;
}

export interface DiaryAccounting {
  /** Every event occurrence recorded (incl. later dropped or coalesced). */
  emitted: number;
  /** Occurrences evicted by the cap (or refused at intake). */
  dropped: number;
  /** Occurrences merged into an existing same-kind event. */
  coalesced: number;
  /** Retention cap in force.  Invariant: emitted = retained + dropped + coalesced. */
  cap: number;
}

export interface RunDiary {
  version: typeof DIARY_VERSION;
  mode: DiaryMode;
  provenance: DiaryProvenance;
  events: DiaryEvent[];
  summary: DiarySummary;
  accounting: DiaryAccounting;
}

/* ------------------------------------------------------------------ */
/* Progress input (structurally compatible with workerClient)          */
/* ------------------------------------------------------------------ */

/**
 * Minimal structural view of workerClient's ProgressPayload.  The diary must
 * stay importable without dragging in the worker protocol, so it declares
 * the fields it reads; the real SteadyProgress / TransientProgress are
 * assignable to these (verified by a compile-time test), including the
 * transient `partial` snapshot this module deliberately ignores.
 */
export interface DiarySteadyProgress {
  kind: "steady";
  iteration: number;
  residual: number;
}

export interface DiaryTransientProgress {
  kind: "transient";
  step: number;
  totalSteps?: number;
  time: number;
  endTime?: number;
  dt?: number;
}

export type DiaryProgress = DiarySteadyProgress | DiaryTransientProgress;

/* ------------------------------------------------------------------ */
/* Collector                                                           */
/* ------------------------------------------------------------------ */

export interface DiaryExtras {
  /** Real SHA-256 of the config (provenance.configSha256) when available. */
  configSha256?: string;
  /** Retention cap override (tests); defaults to DIARY_EVENT_CAP. */
  cap?: number;
  /**
   * 'finalResult' marks a diary synthesized without live progress: a
   * `finalEvidenceOnly` notice is recorded right after runStart.
   */
  origin?: "live" | "finalResult";
}

export interface DiaryCollector {
  readonly mode: DiaryMode;
  /** Consume one progress payload (ignored after finalization). */
  onProgress: (progress: DiaryProgress) => void;
  /** Synthesize the final outcome from a solve result.  First finalize wins. */
  finalizeFromResult: (result: SteadyResult | TransientResult) => RunDiary;
  /** Finalize from a user cancellation: latest progress only, labeled partial. */
  finalizeCancelled: () => RunDiary;
  /** Finalize from a worker/validation error: latest progress + the message. */
  finalizeError: (message: string) => RunDiary;
  /** Current diary without finalizing (outcome 'running'). */
  snapshot: () => RunDiary;
}

/* ------------------------------------------------------------------ */
/* Text / number hygiene                                               */
/* ------------------------------------------------------------------ */

/** Strip control characters, collapse whitespace, cap length. */
export function sanitizeDiaryText(
  raw: string,
  cap = DIARY_MESSAGE_CAP,
): string {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= cap) return cleaned;
  return `${cleaned.slice(0, Math.max(0, cap - 1))}…`;
}

/** Scientific-notation formatter for residuals; 'n/a' for non-finite. */
function fmtExp(v: number): string {
  return Number.isFinite(v) ? v.toExponential(2) : "n/a";
}

/** Significant-figures formatter (format.ts); 'n/a' for non-finite. */
function fmt(v: number): string {
  return Number.isFinite(v) ? formatSig(v) : "n/a";
}

/** v if finite, else undefined (for optional summary fields). */
function finite(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** v if finite, else null (for event data, where keys stay stable). */
function finiteOrNull(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sanitizeData(data: DiaryEventData): DiaryEventData {
  const out: DiaryEventData = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "number") out[k] = Number.isFinite(v) ? v : null;
    else if (typeof v === "string")
      out[k] = sanitizeDiaryText(v, EXTERNAL_MESSAGE_CAP);
    else out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Event vocabulary helpers                                            */
/* ------------------------------------------------------------------ */

/** Eviction tier: lifecycle anchors > warnings > notices > routine info. */
function tierOf(e: Pick<DiaryEvent, "kind" | "severity">): number {
  if (e.kind === "runStart" || e.kind === "runFinish") return 3;
  if (e.severity === "warning") return 2;
  if (e.severity === "notice") return 1;
  return 0;
}

/** Kinds whose consecutive repeats merge into one event with a counter. */
const COALESCIBLE: ReadonlySet<DiaryEventKind> = new Set([
  "residualStall",
  "residualRebound",
  "residualNonFinite",
  "dtObservation",
]);

function outcomeSeverity(o: DiaryOutcome): DiarySeverity {
  switch (o) {
    case "notConverged":
    case "aborted":
    case "stoppedShort":
    case "error":
      return "warning";
    case "userTerminated":
    case "cancelled":
      return "notice";
    default:
      return "info";
  }
}

function outcomeLabel(o: DiaryOutcome): string {
  switch (o) {
    case "converged":
      return "converged";
    case "notConverged":
      return "NOT converged";
    case "aborted":
      return "aborted";
    case "userTerminated":
      return "user-terminated";
    case "stoppedShort":
      return "stopped short";
    case "cancelled":
      return "cancelled";
    case "error":
      return "error";
    default:
      return "running";
  }
}

function coordinateText(at: DiaryCoordinate): string {
  return at.kind === "steady"
    ? `iter ${at.iteration}`
    : `t=${fmt(at.time)}s step ${at.step}`;
}

/** One-line digest from the outcome head plus the warning count. */
function digestOf(head: string, warnings: number): string {
  const s =
    warnings > 0
      ? `${head} · ${warnings} warning${warnings === 1 ? "" : "s"}`
      : head;
  return sanitizeDiaryText(s);
}

/* ------------------------------------------------------------------ */
/* Collector implementation                                            */
/* ------------------------------------------------------------------ */

export function createDiaryCollector(
  config: NetworkConfig,
  extras: DiaryExtras = {},
): DiaryCollector {
  const mode: DiaryMode = config.settings.mode;
  const cap = Math.max(2, Math.floor(extras.cap ?? DIARY_EVENT_CAP));
  const configEndTime = finite(config.settings.endTime);

  const provenance: DiaryProvenance = {
    modelName: config.meta.name,
    configHash: configHash(config),
    settingsSummary: settingsSummary(config),
    ...(extras.configSha256 ? { configSha256: extras.configSha256 } : {}),
  };

  let events: DiaryEvent[] = [];
  let seq = 0;
  let emitted = 0;
  let dropped = 0;
  let coalesced = 0;
  let progressUpdates = 0;
  let finalized = false;
  let summary: DiarySummary = {
    outcome: "running",
    digest: "running",
    warningCount: 0,
    progressUpdates: 0,
  };

  /* steady progress state */
  let bestResidual: number | undefined;
  let lowestDecade: number | undefined;
  let samplesSinceImprovement = 0;
  /* transient progress state */
  let milestoneIndex = 0;
  let lastDt: number | undefined;
  let dtMinSeen: number | undefined;
  let dtMaxSeen: number | undefined;
  let dtSamples = 0;
  let dtChanged = false;
  let largeDtChanges = 0;
  /* latest coordinate (cancel/error finalization) */
  let lastAt: DiaryCoordinate | undefined;

  const originAt: DiaryCoordinate =
    mode === "steady"
      ? { kind: "steady", iteration: 0 }
      : { kind: "transient", time: 0, step: 0 };

  function warningCount(): number {
    let n = 0;
    for (const e of events) if (e.severity === "warning") n++;
    return n;
  }

  function enforceCap(incoming: DiaryEvent): void {
    if (events.length <= cap) return;
    const incomingTier = tierOf(incoming);
    // Lowest droppable tier present (tier < 3; lifecycle anchors never evict).
    let minTier = Infinity;
    for (const e of events) {
      const t = tierOf(e);
      if (t < 3 && t < minTier) minTier = t;
    }
    // All anchors (only possible pathologically): refuse the incoming event.
    // Incoming is the least important event present: refuse it.
    if (minTier === Infinity || incomingTier < minTier) {
      events.pop();
      dropped++;
      return;
    }
    // Evict the OLDEST event of the lowest tier (recency wins within a tier).
    const idx = events.findIndex((e) => tierOf(e) === minTier);
    events.splice(idx, 1);
    dropped++;
  }

  interface EventSpec {
    kind: DiaryEventKind;
    category: DiaryCategory;
    severity: DiarySeverity;
    at: DiaryCoordinate;
    message: string;
    data?: DiaryEventData;
  }

  function push(spec: EventSpec): void {
    emitted++;
    const last = events[events.length - 1];
    if (last && last.kind === spec.kind && COALESCIBLE.has(spec.kind)) {
      coalesced++;
      last.at = spec.at;
      last.message = sanitizeDiaryText(spec.message);
      last.data = spec.data ? sanitizeData(spec.data) : undefined;
      last.count = (last.count ?? 1) + 1;
      return;
    }
    const ev: DiaryEvent = {
      seq: seq++,
      kind: spec.kind,
      category: spec.category,
      severity: spec.severity,
      at: spec.at,
      message: sanitizeDiaryText(spec.message),
      ...(spec.data ? { data: sanitizeData(spec.data) } : {}),
    };
    events.push(ev);
    enforceCap(ev);
  }

  function cloneEvent(e: DiaryEvent): DiaryEvent {
    return {
      ...e,
      at: { ...e.at },
      ...(e.data ? { data: { ...e.data } } : {}),
    };
  }

  function buildDiary(): RunDiary {
    return {
      version: DIARY_VERSION,
      mode,
      provenance: { ...provenance },
      events: events.map((e, i) => ({ ...cloneEvent(e), seq: i })),
      summary: { ...summary, warningCount: warningCount(), progressUpdates },
      accounting: { emitted, dropped, coalesced, cap },
    };
  }

  /* ---------------- steady progress ---------------- */

  function onSteadyProgress(p: DiarySteadyProgress): void {
    const iteration = Number.isFinite(p.iteration) ? p.iteration : 0;
    const at: DiaryCoordinate = { kind: "steady", iteration };
    lastAt = at;
    progressUpdates++;
    const r = p.residual;

    if (!Number.isFinite(r)) {
      push({
        kind: "residualNonFinite",
        category: "convergence",
        severity: "warning",
        at,
        message: `non-finite residual reported (iteration ${iteration})`,
        data: { iteration },
      });
      return;
    }

    // Residual-decade milestone: fires once per newly entered lower decade;
    // a multi-decade jump emits ONE event for the decade reached.
    if (r > 0) {
      const decade = Math.floor(Math.log10(r));
      if (lowestDecade === undefined) {
        lowestDecade = decade;
      } else if (decade < lowestDecade) {
        lowestDecade = decade;
        push({
          kind: "residualDecade",
          category: "convergence",
          severity: "info",
          at,
          message: `residual ${fmtExp(r)} entered decade 1e${decade}`,
          data: { residual: r, decade },
        });
      }
    }

    // Rebound: residual blew up to ≥ REBOUND_FACTOR × running best.
    if (
      bestResidual !== undefined &&
      bestResidual > 0 &&
      r >= bestResidual * REBOUND_FACTOR
    ) {
      push({
        kind: "residualRebound",
        category: "convergence",
        severity: "notice",
        at,
        message: `residual rebounded to ${fmtExp(r)} (${fmt(r / bestResidual)}× best ${fmtExp(bestResidual)})`,
        data: { residual: r, bestResidual, factor: r / bestResidual },
      });
    }

    // Stall tracking: reset the clock only on a ≥ 2× improvement of the best.
    if (bestResidual === undefined) {
      bestResidual = r;
      samplesSinceImprovement = 0;
    } else if (
      bestResidual > 0 &&
      r > 0 &&
      r <= bestResidual * STALL_IMPROVEMENT_FACTOR
    ) {
      bestResidual = r;
      samplesSinceImprovement = 0;
    } else {
      bestResidual = Math.min(bestResidual, r);
      samplesSinceImprovement++;
      if (
        bestResidual > 0 &&
        samplesSinceImprovement >= STALL_SAMPLE_THRESHOLD &&
        samplesSinceImprovement % STALL_SAMPLE_THRESHOLD === 0
      ) {
        push({
          kind: "residualStall",
          category: "convergence",
          severity: "warning",
          at,
          message: `residual stall: no ≥2× improvement over ${samplesSinceImprovement} progress samples (best ${fmtExp(bestResidual)})`,
          data: { bestResidual, samplesSinceImprovement },
        });
      }
    }
  }

  /* ---------------- transient progress ---------------- */

  function onTransientProgress(p: DiaryTransientProgress): void {
    const time = Number.isFinite(p.time) ? p.time : 0;
    const step = Number.isFinite(p.step) ? p.step : 0;
    const at: DiaryCoordinate = { kind: "transient", time, step };
    lastAt = at;
    progressUpdates++;

    // Sparse progress milestones: quartiles of endTime (preferred) or of
    // totalSteps when no usable end time is available.  A jump past several
    // quartiles emits one event per crossed quartile, in order.
    const end = finite(p.endTime) ?? configEndTime;
    if (end !== undefined && end > 0 && Number.isFinite(p.time)) {
      while (
        milestoneIndex < TRANSIENT_MILESTONE_FRACTIONS.length &&
        time >= TRANSIENT_MILESTONE_FRACTIONS[milestoneIndex] * end
      ) {
        const f = TRANSIENT_MILESTONE_FRACTIONS[milestoneIndex];
        push({
          kind: "progressMilestone",
          category: "lifecycle",
          severity: "info",
          at,
          message: `${Math.round(f * 100)}% of end time reached (t=${fmt(time)}s of ${fmt(end)}s)`,
          data: { fraction: f, time, endTime: end },
        });
        milestoneIndex++;
      }
    } else if (
      p.totalSteps !== undefined &&
      Number.isFinite(p.totalSteps) &&
      p.totalSteps > 0
    ) {
      while (
        milestoneIndex < TRANSIENT_MILESTONE_FRACTIONS.length &&
        step >= TRANSIENT_MILESTONE_FRACTIONS[milestoneIndex] * p.totalSteps
      ) {
        const f = TRANSIENT_MILESTONE_FRACTIONS[milestoneIndex];
        push({
          kind: "progressMilestone",
          category: "lifecycle",
          severity: "info",
          at,
          message: `${Math.round(f * 100)}% of steps reached (step ${step} of ${p.totalSteps})`,
          data: { fraction: f, step, totalSteps: p.totalSteps },
        });
        milestoneIndex++;
      }
    }

    // dt observation: starts on the FIRST observed dt change (fixed stepping
    // with constant dt produces none), then coalesces into one running event.
    const dt = p.dt;
    if (dt !== undefined && Number.isFinite(dt) && dt > 0) {
      if (lastDt === undefined) {
        dtMinSeen = dt;
        dtMaxSeen = dt;
      } else if (dt !== lastDt) {
        dtChanged = true;
        if (dtMinSeen === undefined || dt < dtMinSeen) dtMinSeen = dt;
        if (dtMaxSeen === undefined || dt > dtMaxSeen) dtMaxSeen = dt;
        const ratio = dt > lastDt ? dt / lastDt : lastDt / dt;
        if (ratio >= DT_LARGE_CHANGE_FACTOR) largeDtChanges++;
      }
      lastDt = dt;
      dtSamples++;
      if (dtChanged) {
        push({
          kind: "dtObservation",
          category: "timeStepping",
          severity: "info",
          at,
          message:
            `dt range ${fmt(dtMinSeen!)}…${fmt(dtMaxSeen!)}s over ${dtSamples} samples` +
            (largeDtChanges > 0
              ? ` · ${largeDtChanges} large changes (≥${DT_LARGE_CHANGE_FACTOR}×)`
              : ""),
          data: {
            minDt: dtMinSeen!,
            maxDt: dtMaxSeen!,
            samples: dtSamples,
            largeChanges: largeDtChanges,
          },
        });
      }
    }
  }

  /* ---------------- final synthesis ---------------- */

  function steadyOutcome(r: SteadyResult): DiaryOutcome {
    if (r.userTerminated === true) return "userTerminated";
    if (r.aborted === true) return "aborted";
    return r.converged ? "converged" : "notConverged";
  }

  function transientOutcome(
    r: TransientResult,
    reachedEnd: boolean,
  ): DiaryOutcome {
    if (r.userTerminated === true) return "userTerminated";
    if (r.aborted === true) return "stoppedShort";
    if (!reachedEnd) return "stoppedShort";
    return r.converged ? "converged" : "notConverged";
  }

  function computeReachedEnd(r: TransientResult): boolean {
    const times = Array.isArray(r.times) ? r.times : [];
    if (r.userTerminated === true || r.aborted === true) return false;
    const lastTime = times.length > 0 ? times[times.length - 1] : undefined;
    if (configEndTime !== undefined) {
      if (lastTime === undefined || !Number.isFinite(lastTime)) return false;
      return (
        lastTime >=
        configEndTime - END_TIME_REL_TOL * Math.max(1, Math.abs(configEndTime))
      );
    }
    // No expected end time: infer from trajectory presence (mirrors the
    // sweep summary's fallback).
    return times.length > 0;
  }

  function finishSteady(result: SteadyResult): void {
    const outcome = steadyOutcome(result);
    const iterations = finite(result.iterations);
    const residual = finite(result.residual);
    const at: DiaryCoordinate =
      lastAt?.kind === "steady"
        ? lastAt
        : { kind: "steady", iteration: iterations ?? 0 };

    const ptcActive = result.ptcDeltaTau !== undefined;
    let ptcFinalDeltaTau: number | undefined;
    if (ptcActive) {
      const d = result.ptcDeltaTau!;
      const last = Array.isArray(d) ? d[d.length - 1] : d;
      ptcFinalDeltaTau = finite(last);
    }
    const ptcShrinks = ptcActive ? finite(result.ptcShrinks) : undefined;

    const parts = [outcomeLabel(outcome), `${iterations ?? "?"} iter`];
    if (residual !== undefined) parts.push(`res ${fmtExp(residual)}`);
    if (ptcActive) {
      parts.push(
        `PTC Δτ=${ptcFinalDeltaTau !== undefined ? fmt(ptcFinalDeltaTau) : "n/a"}`,
      );
      parts.push(`${ptcShrinks ?? 0} shrinks`);
    }
    if (
      outcome === "userTerminated" &&
      typeof result.terminationReason === "string"
    ) {
      parts.push(
        `“${sanitizeDiaryText(result.terminationReason, EXTERNAL_MESSAGE_CAP)}”`,
      );
    }
    const head = parts.join(" · ");

    push({
      kind: "runFinish",
      category: "lifecycle",
      severity: outcomeSeverity(outcome),
      at,
      message: `run finished — ${head}`,
      data: {
        outcome,
        converged: result.converged === true,
        iterations: finiteOrNull(iterations),
        residual: finiteOrNull(residual),
        ptcActive,
        ptcFinalDeltaTau: finiteOrNull(ptcFinalDeltaTau),
        ptcShrinks: finiteOrNull(ptcShrinks),
        ...(typeof result.terminationReason === "string"
          ? { terminationReason: result.terminationReason }
          : {}),
      },
    });

    const warnings = warningCount();
    summary = {
      outcome,
      digest: digestOf(head, warnings),
      warningCount: warnings,
      progressUpdates,
      ...(iterations !== undefined ? { iterations } : {}),
      ...(residual !== undefined ? { residual } : {}),
      ...(ptcActive
        ? {
            ptcActive,
            ...(ptcFinalDeltaTau !== undefined ? { ptcFinalDeltaTau } : {}),
            ptcShrinks: ptcShrinks ?? 0,
          }
        : {}),
    };
  }

  function finishTransient(result: TransientResult): void {
    const times = Array.isArray(result.times) ? result.times : [];
    const lastTime =
      times.length > 0 ? finite(times[times.length - 1]) : undefined;
    const reachedEnd = computeReachedEnd(result);
    const outcome = transientOutcome(result, reachedEnd);
    const stats = result.stats;

    const steps =
      finite(stats?.steps) ?? (times.length > 0 ? times.length - 1 : 0);
    const rejectedSteps = finite(stats?.rejectedSteps);
    const minDt = finite(stats?.minDt) ?? (dtChanged ? dtMinSeen : undefined);
    const maxDt = finite(stats?.maxDt) ?? (dtChanged ? dtMaxSeen : undefined);
    const dtAtMinCount = finite(stats?.dtAtMinCount);
    const accuracyLimited = stats?.accuracyLimited === true;

    const at: DiaryCoordinate =
      lastAt?.kind === "transient"
        ? lastAt
        : { kind: "transient", time: lastTime ?? 0, step: steps };

    if (rejectedSteps !== undefined && rejectedSteps > 0) {
      const attempts = steps + rejectedSteps;
      push({
        kind: "rejectedSteps",
        category: "stepControl",
        severity: "notice",
        at,
        message:
          `adaptive step control rejected ${rejectedSteps} of ${attempts} attempted steps` +
          (attempts > 0 ? ` (${fmt((rejectedSteps / attempts) * 100)}%)` : ""),
        data: {
          rejectedSteps,
          steps,
          ratio: attempts > 0 ? rejectedSteps / attempts : null,
        },
      });
    }
    if (dtAtMinCount !== undefined && dtAtMinCount > 0) {
      push({
        kind: "dtMinHits",
        category: "stepControl",
        severity: "warning",
        at,
        message: `step size hit dtMin=${minDt !== undefined ? fmt(minDt) : "?"}s on ${dtAtMinCount} step${dtAtMinCount === 1 ? "" : "s"}`,
        data: { dtAtMinCount, minDt: finiteOrNull(minDt) },
      });
    }
    if (accuracyLimited) {
      push({
        kind: "accuracyLimited",
        category: "stepControl",
        severity: "warning",
        at,
        message:
          "accuracy limited: step(s) accepted at dtMin despite error estimate above tolerance",
        data: { dtAtMinCount: finiteOrNull(dtAtMinCount) },
      });
    }
    // Fixed-stepping per-step honesty: stepResidualsScaled is present only
    // for fixed stepping; values above STEP_RESIDUAL_SCALED_WARN mark steps
    // whose inner Newton iteration stalled (schema.ts comment).
    const scaled = Array.isArray(result.stepResidualsScaled)
      ? result.stepResidualsScaled
      : [];
    if (scaled.length > 0) {
      let high = 0;
      let worst: number | undefined;
      let total = 0;
      for (const v of scaled) {
        if (!Number.isFinite(v)) continue;
        total++;
        if (v > STEP_RESIDUAL_SCALED_WARN) {
          high++;
          if (worst === undefined || v > worst) worst = v;
        }
      }
      if (high > 0) {
        push({
          kind: "stepResidualHigh",
          category: "convergence",
          severity: "warning",
          at,
          message: `${high} of ${total} steps ended with scaled residual above ${STEP_RESIDUAL_SCALED_WARN} (max ${fmtExp(worst!)}) — step not genuinely converged`,
          data: {
            count: high,
            total,
            max: worst!,
            threshold: STEP_RESIDUAL_SCALED_WARN,
          },
        });
      }
    }

    const parts = [outcomeLabel(outcome), `${steps} steps`];
    if (rejectedSteps !== undefined && rejectedSteps > 0)
      parts.push(`${rejectedSteps} rejected`);
    if (minDt !== undefined && maxDt !== undefined)
      parts.push(`dt ${fmt(minDt)}…${fmt(maxDt)}s`);
    if (reachedEnd) parts.push(`reached t=${fmt(configEndTime ?? lastTime!)}s`);
    else if (lastTime !== undefined)
      parts.push(
        `stopped at t=${fmt(lastTime)}s${configEndTime !== undefined ? ` of ${fmt(configEndTime)}s` : ""}`,
      );
    if (
      outcome === "userTerminated" &&
      typeof result.terminationReason === "string"
    ) {
      parts.push(
        `“${sanitizeDiaryText(result.terminationReason, EXTERNAL_MESSAGE_CAP)}”`,
      );
    }
    const head = parts.join(" · ");

    push({
      kind: "runFinish",
      category: "lifecycle",
      severity: outcomeSeverity(outcome),
      at,
      message: `run finished — ${head}`,
      data: {
        outcome,
        converged: result.converged === true,
        reachedEnd,
        steps,
        rejectedSteps: finiteOrNull(rejectedSteps),
        minDt: finiteOrNull(minDt),
        maxDt: finiteOrNull(maxDt),
        dtAtMinCount: finiteOrNull(dtAtMinCount),
        accuracyLimited,
        lastTime: finiteOrNull(lastTime),
        endTime: finiteOrNull(configEndTime),
        ...(typeof result.terminationReason === "string"
          ? { terminationReason: result.terminationReason }
          : {}),
      },
    });

    const warnings = warningCount();
    summary = {
      outcome,
      digest: digestOf(head, warnings),
      warningCount: warnings,
      progressUpdates,
      steps,
      ...(rejectedSteps !== undefined ? { rejectedSteps } : {}),
      ...(minDt !== undefined ? { minDt } : {}),
      ...(maxDt !== undefined ? { maxDt } : {}),
      ...(dtAtMinCount !== undefined ? { dtAtMinCount } : {}),
      ...(accuracyLimited ? { accuracyLimited } : {}),
      reachedEnd,
      ...(lastTime !== undefined ? { lastTime } : {}),
    };
  }

  function finishPartial(
    outcome: "cancelled" | "error",
    detail?: string,
  ): RunDiary {
    if (finalized) return buildDiary();
    finalized = true;
    const at = lastAt ?? originAt;
    const head =
      `${outcomeLabel(outcome)} — partial diary · ${progressUpdates} progress update${progressUpdates === 1 ? "" : "s"}` +
      (detail ? ` · ${detail}` : "");
    push({
      kind: "runFinish",
      category: "lifecycle",
      severity: outcomeSeverity(outcome),
      at,
      message: `run ${head}`,
      data: {
        outcome,
        partial: true,
        progressUpdates,
        ...(detail ? { detail } : {}),
      },
    });
    const warnings = warningCount();
    summary = {
      outcome,
      digest: digestOf(head, warnings),
      warningCount: warnings,
      progressUpdates,
      partial: true,
    };
    return buildDiary();
  }

  /* ---------------- lifecycle ---------------- */

  // Start event (always recorded, always survives the cap).
  if (mode === "steady") {
    push({
      kind: "runStart",
      category: "lifecycle",
      severity: "info",
      at: originAt,
      message: `steady run started · tol=${fmtExp(config.settings.tolerance)} · maxIter=${config.settings.maxIterations}`,
      data: {
        tolerance: finiteOrNull(config.settings.tolerance),
        maxIterations: finiteOrNull(config.settings.maxIterations),
        ...(config.settings.steadySolver
          ? { steadySolver: config.settings.steadySolver }
          : {}),
      },
    });
  } else {
    push({
      kind: "runStart",
      category: "lifecycle",
      severity: "info",
      at: originAt,
      message:
        `transient run started · end=${configEndTime !== undefined ? fmt(configEndTime) : "?"}s · stepping=${config.settings.timeStepping ?? "fixed"}` +
        (finite(config.settings.dt) !== undefined
          ? ` · dt=${fmt(config.settings.dt!)}s`
          : ""),
      data: {
        endTime: finiteOrNull(configEndTime),
        stepping: config.settings.timeStepping ?? "fixed",
        dt: finiteOrNull(config.settings.dt),
        tolerance: finiteOrNull(config.settings.tolerance),
      },
    });
  }
  if (extras.origin === "finalResult") {
    push({
      kind: "finalEvidenceOnly",
      category: "lifecycle",
      severity: "notice",
      at: originAt,
      message:
        "diary synthesized from the final result — no live progress milestones were captured",
    });
  }

  return {
    mode,

    onProgress(progress: DiaryProgress): void {
      if (finalized) return;
      if (progress.kind === "steady") onSteadyProgress(progress);
      else onTransientProgress(progress);
    },

    finalizeFromResult(result: SteadyResult | TransientResult): RunDiary {
      if (finalized) return buildDiary();
      finalized = true;
      // Dispatch on the result's own shape (the evidence); degenerate
      // mode/shape mismatches are field-sanitized rather than fatal.
      if (isTransientResult(result)) finishTransient(result);
      else finishSteady(result);
      return buildDiary();
    },

    finalizeCancelled(): RunDiary {
      return finishPartial("cancelled");
    },

    finalizeError(message: string): RunDiary {
      const detail =
        typeof message === "string" && message.length > 0
          ? sanitizeDiaryText(message, EXTERNAL_MESSAGE_CAP)
          : "unknown error";
      return finishPartial("error", detail);
    },

    snapshot(): RunDiary {
      return buildDiary();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Offline diary: final-evidence synthesis from a bare result          */
/* ------------------------------------------------------------------ */

/**
 * Build a diary for a result obtained WITHOUT a live collector (sweep
 * variant, promoted run record).  Deterministic: runStart + a
 * `finalEvidenceOnly` notice + final synthesis.  No progress milestones are
 * fabricated — none were observed.
 */
export function buildDiaryFromResult(
  config: NetworkConfig,
  result: SteadyResult | TransientResult,
  extras: DiaryExtras = {},
): RunDiary {
  const collector = createDiaryCollector(config, {
    ...extras,
    origin: "finalResult",
  });
  return collector.finalizeFromResult(result);
}

/* ------------------------------------------------------------------ */
/* Formatting helpers (pure strings/objects; no DOM)                   */
/* ------------------------------------------------------------------ */

export interface DiaryJsonEvent {
  seq: number;
  kind: DiaryEventKind;
  category: DiaryCategory;
  severity: DiarySeverity;
  at: DiaryCoordinate;
  message: string;
  count?: number;
  data?: DiaryEventData;
}

/** Structured, JSON-safe export payload with explicit (stable) key order. */
export interface DiaryJsonPayload {
  version: typeof DIARY_VERSION;
  mode: DiaryMode;
  outcome: DiaryOutcome;
  digest: string;
  warningCount: number;
  provenance: DiaryProvenance;
  summary: DiarySummary;
  accounting: DiaryAccounting;
  events: DiaryJsonEvent[];
}

export function diaryToJson(diary: RunDiary): DiaryJsonPayload {
  return {
    version: diary.version,
    mode: diary.mode,
    outcome: diary.summary.outcome,
    digest: diary.summary.digest,
    warningCount: diary.summary.warningCount,
    provenance: { ...diary.provenance },
    summary: { ...diary.summary },
    accounting: { ...diary.accounting },
    events: diary.events.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      category: e.category,
      severity: e.severity,
      at: { ...e.at },
      message: e.message,
      ...(e.count !== undefined ? { count: e.count } : {}),
      ...(e.data ? { data: { ...e.data } } : {}),
    })),
  };
}

/** Human-readable plain-text rendering (one event per line). */
export function diaryToText(diary: RunDiary): string {
  const lines: string[] = [];
  const s = diary.summary;
  lines.push(
    `convergence diary v${diary.version} · mode=${diary.mode} · outcome=${s.outcome} · warnings=${s.warningCount}`,
  );
  const p = diary.provenance;
  lines.push(
    `model=${p.modelName} · ${p.settingsSummary} · hash=${p.configHash}` +
      (p.configSha256 ? ` · sha256=${p.configSha256}` : ""),
  );
  for (const e of diary.events) {
    lines.push(
      `#${e.seq} [${e.severity}/${e.category}] ${coordinateText(e.at)} — ${e.message}` +
        (e.count !== undefined && e.count > 1 ? ` (×${e.count})` : ""),
    );
  }
  const a = diary.accounting;
  lines.push(`digest: ${s.digest}`);
  lines.push(
    `events=${diary.events.length} emitted=${a.emitted} dropped=${a.dropped} coalesced=${a.coalesced} cap=${a.cap}`,
  );
  return lines.join("\n");
}
