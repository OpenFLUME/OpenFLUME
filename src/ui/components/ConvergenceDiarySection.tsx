/**
 * ConvergenceDiarySection.tsx — the "Solver diary" inspection section of
 * the Analysis view (wired in by ResultsPanel).
 *
 * Renders a RunDiary (convergenceDiary.ts): outcome pill + digest header,
 * severity/progress meta with retention accounting, an ordered event
 * timeline (collapsed to the first DIARY_COLLAPSED_COUNT events with a
 * Show all / Show fewer toggle), and JSON / plain-text downloads whose
 * payloads carry the diary provenance (config hash, settings summary) plus
 * the owning run record's name/id when one exists.
 *
 * Purely presentational: the diary and the export run context arrive via
 * props; all formatting lives in diaryPresentation.ts.  Event messages and
 * run names render as React text only — no HTML injection surface.
 */
import React from "react";
import type { RunDiary } from "../convergenceDiary";
import {
  buildDiaryJsonExport,
  buildDiaryTextExport,
  diaryAccountingText,
  diaryCoordinateLabel,
  diaryExportFilename,
  diaryMetaText,
  diaryOutcomeText,
  diaryOutcomeTone,
  diaryTimelineSlice,
} from "../diaryPresentation";

/** Blob + anchor download (same convention as ResultsPanel/RunHistoryPanel). */
function downloadBlob(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function ConvergenceDiarySection({
  diary,
  runName = null,
  runId = null,
}: {
  diary: RunDiary;
  /** Display name of the run record that owns this diary (export context). */
  runName?: string | null;
  /** Id of the owning run record (export context). */
  runId?: string | null;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const { visible, total, hiddenCount, collapsedCount } = diaryTimelineSlice(
    diary.events,
    expanded,
  );
  const context = { runId, runName };
  const accounting = diaryAccountingText(diary);
  const outcome = diary.summary.outcome;

  const downloadJson = () =>
    downloadBlob(
      JSON.stringify(buildDiaryJsonExport(diary, context), null, 2),
      diaryExportFilename(diary, "json", context),
      "application/json",
    );
  const downloadText = () =>
    downloadBlob(
      buildDiaryTextExport(diary, context),
      diaryExportFilename(diary, "txt", context),
      "text/plain;charset=utf-8",
    );

  return (
    <section
      data-testid="solver-diary"
      className="card solver-diary"
      aria-labelledby="solver-diary-title"
      aria-describedby="solver-diary-digest"
      tabIndex={-1}
    >
      <div className="solver-diary__head">
        {/* h3: the enclosing AnalysisDisclosure header is the section h2. */}
        <h3 id="solver-diary-title" className="solver-diary__title">
          Solver diary
        </h3>
        <span
          className={`pill pill--${diaryOutcomeTone(outcome)}`}
          data-testid="solver-diary-outcome"
        >
          {diaryOutcomeText(outcome)}
        </span>
        <span
          id="solver-diary-digest"
          data-testid="solver-diary-digest"
          className="solver-diary__digest"
        >
          {diary.summary.digest}
        </span>
      </div>
      <div className="solver-diary__meta" data-testid="solver-diary-meta">
        <span>{diaryMetaText(diary)}</span>
        {accounting && (
          <span data-testid="solver-diary-accounting">{accounting}</span>
        )}
        {diary.summary.partial && (
          <span data-testid="solver-diary-partial">
            partial — evidence ends at the last progress update
          </span>
        )}
      </div>
      {total === 0 ? (
        <p className="solver-diary__empty" data-testid="solver-diary-empty">
          No diary events were recorded.
        </p>
      ) : (
        // list-style is removed in CSS for the compact row layout; role="list"
        // keeps the ordered-list semantics exposed to assistive technology.
        <ol
          className="solver-diary__list"
          id="solver-diary-events"
          data-testid="solver-diary-events"
          role="list"
        >
          {visible.map((e) => (
            <li
              key={e.seq}
              className="solver-diary__event"
              data-testid="solver-diary-event"
            >
              <span className="solver-diary__coord">
                {diaryCoordinateLabel(e.at)}
              </span>
              <span
                className={`solver-diary__sev solver-diary__sev--${e.severity}`}
              >
                {e.severity}
              </span>
              <span className="solver-diary__message">
                {e.message}
                {e.count !== undefined && e.count > 1 && (
                  <span
                    className="solver-diary__count"
                    title={`Occurred ${e.count} times — consecutive repeats are folded into this one entry`}
                  >
                    {`×${e.count}`}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="solver-diary__foot">
        {total > collapsedCount && (
          <button
            type="button"
            data-testid="solver-diary-toggle"
            className="btn btn--ghost btn--sm"
            aria-expanded={expanded}
            aria-controls="solver-diary-events"
            title={
              expanded
                ? `Collapse to the first ${collapsedCount} events`
                : "Show the full event timeline"
            }
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Show fewer" : `Show all ${total} events`}
          </button>
        )}
        {!expanded && hiddenCount > 0 && (
          <span
            className="solver-diary__hidden"
            data-testid="solver-diary-hidden"
          >
            {`${hiddenCount} hidden`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="solver-diary-download-json"
          className="btn btn--ghost btn--sm"
          title="Download the solver diary as JSON (versioned payload with provenance)"
          onClick={downloadJson}
        >
          Download JSON
        </button>
        <button
          type="button"
          data-testid="solver-diary-download-text"
          className="btn btn--ghost btn--sm"
          title="Download the solver diary as plain text"
          onClick={downloadText}
        >
          Download text
        </button>
      </div>
    </section>
  );
}
