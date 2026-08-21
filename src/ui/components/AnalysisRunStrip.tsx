/**
 * AnalysisRunStrip — compact sticky header strip for the Analysis view.
 *
 * One glanceable line answering "what am I looking at?": the displayed
 * run's name (or "Latest run" for a live/unrecorded result), solve mode,
 * outcome/convergence pill, stale/partial flags, and the pinned baseline —
 * plus quick jumps (Runs / Solver diary / Details) and an optional native
 * <select> for switching historical runs without rendering the full
 * history list.
 *
 * Deliberately store-free: every prop is derived by the parent from the
 * current/displayed run state, and all wording/tone decisions flow through
 * the pure view model in analysisShell.ts.  Works for zero history, a live
 * running run (no record yet), and cancelled/error partials.
 *
 * The whole state is also summarized in a visually hidden role="status"
 * line so screen readers announce the same facts the pills show visually.
 */
import { runStripView, type RunStripState } from "../analysisShell";

/** One historical run offered by the switcher select. */
export interface RunStripRunOption {
  id: string;
  name: string;
  /** Optional right-side hint, e.g. "14:02:11 · steady · converged". */
  meta?: string;
}

export interface AnalysisRunStripProps extends RunStripState {
  /** Historical runs for the switcher; the select renders only when non-empty. */
  runs?: readonly RunStripRunOption[];
  /** Selected record id; null = the latest (possibly live) run. */
  selectedRunId?: string | null;
  /** Switch displayed run (null selects the latest run). */
  onSelectRun?: (id: string | null) => void;
  /** Jump to the full run-history list. */
  onShowRuns?: () => void;
  /** Open + focus the Solver diary section. */
  onShowDiary?: () => void;
  /** Open + focus the run-details section. */
  onShowDetails?: () => void;
}

/** Value standing in for "latest run" in the native select (ids never empty). */
const LATEST_VALUE = "";

export default function AnalysisRunStrip(props: AnalysisRunStripProps) {
  const {
    runs,
    selectedRunId = null,
    onSelectRun,
    onShowRuns,
    onShowDiary,
    onShowDetails,
  } = props;
  const vm = runStripView(props);
  const selectedKnown =
    selectedRunId != null && (runs ?? []).some((r) => r.id === selectedRunId);

  return (
    <div
      data-testid="run-strip"
      className="run-strip"
      role="region"
      aria-label="Current run"
    >
      <span
        className="visually-hidden"
        role="status"
        data-testid="run-strip-status"
      >
        {vm.statusText}
      </span>
      <div className="run-strip__lead">
        <span className="run-strip__title" data-testid="run-strip-title">
          {vm.title}
        </span>
        {vm.modeText && (
          <span className="run-strip__mode" data-testid="run-strip-mode">
            {vm.modeText}
          </span>
        )}
        {vm.outcomeText && (
          <span
            className={`pill pill--${vm.outcomeTone}`}
            data-testid="run-strip-outcome"
          >
            {vm.outcomeText}
          </span>
        )}
        {vm.detailText && (
          <span className="run-strip__detail" data-testid="run-strip-detail">
            {vm.detailText}
          </span>
        )}
        {vm.stale && (
          <span
            className="pill pill--warn"
            data-testid="run-strip-stale"
            title="Results are from an earlier model state. Rerun before using these values for a design decision."
          >
            stale
          </span>
        )}
        {vm.partial && (
          <span
            className="pill pill--muted"
            data-testid="run-strip-partial"
            title="The run was cancelled or errored — evidence ends at the last progress update"
          >
            partial
          </span>
        )}
        {vm.baselineText && (
          <span className="pill pill--info" data-testid="run-strip-baseline">
            {vm.baselineText}
          </span>
        )}
      </div>
      <div className="run-strip__actions">
        {onSelectRun && runs && runs.length > 0 && (
          <label className="run-strip__field">
            <span className="run-strip__field-label">Run</span>
            <select
              className="select run-strip__select"
              data-testid="run-strip-select"
              aria-label="Switch displayed run"
              value={selectedKnown ? selectedRunId : LATEST_VALUE}
              onChange={(e) =>
                onSelectRun(
                  e.target.value === LATEST_VALUE ? null : e.target.value,
                )
              }
            >
              <option value={LATEST_VALUE}>Latest run</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.meta ? `${r.name} · ${r.meta}` : r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {onShowRuns && (
          <button
            type="button"
            data-testid="run-strip-runs"
            className="btn btn--ghost btn--sm"
            title="Show the full run history list"
            onClick={onShowRuns}
          >
            Runs
            {vm.runsBadge && (
              <span
                className="run-strip__badge"
                data-testid="run-strip-runs-badge"
              >
                {vm.runsBadge}
              </span>
            )}
          </button>
        )}
        {onShowDiary && (
          <button
            type="button"
            data-testid="run-strip-diary"
            className="btn btn--ghost btn--sm"
            title="Open the solver diary for the displayed run"
            onClick={onShowDiary}
          >
            Solver diary
            {vm.diaryBadge && (
              <span
                className={`run-strip__badge${vm.diaryBadgeWarn ? " run-strip__badge--warn" : ""}`}
                data-testid="run-strip-diary-badge"
              >
                {vm.diaryBadge}
              </span>
            )}
          </button>
        )}
        {onShowDetails && (
          <button
            type="button"
            data-testid="run-strip-details"
            className="btn btn--ghost btn--sm"
            title="Open the run details section"
            onClick={onShowDetails}
          >
            Details
          </button>
        )}
      </div>
    </div>
  );
}
