/**
 * AnalysisDisclosure — reusable controlled disclosure card for the Analysis
 * view (ResultsPanel sections: diary, details, channel data, …).
 *
 * The parent owns the open state (open/onToggle) so several disclosures can
 * be coordinated — e.g. a run-strip button that opens a section and then
 * focuses it.  The focus convention is exposed through stable ids/testids
 * (see analysisDisclosureIds in analysisShell.ts):
 *
 *   const ids = analysisDisclosureIds('solver-diary');
 *   onToggle(true);                                   // mount the content
 *   requestAnimationFrame(() =>
 *     document.getElementById(ids.contentId)?.focus() // tabIndex -1 target
 *   );
 *
 * Accessibility: the header is a real <button> with aria-expanded and
 * aria-controls; the content is a role="region" labelled by the header.
 * Content unmounts while closed unless keepMounted is requested (then it is
 * hidden instead, preserving inner state such as scroll position).
 *
 * Purely presentational: title/badge/meta are React nodes; all text renders
 * as React text only — no HTML injection surface.
 */
import React from "react";
import { analysisDisclosureIds } from "../analysisShell";

export interface AnalysisDisclosureProps {
  /** Unique-on-page instance id; derives the header/content ids + testids. */
  id: string;
  title: React.ReactNode;
  /** Optional pill/count rendered right after the title. */
  badge?: React.ReactNode;
  /** Optional secondary text, right-aligned in the header. */
  meta?: React.ReactNode;
  open: boolean;
  /** Called with the NEXT open state when the header is activated. */
  onToggle: (open: boolean) => void;
  /** Keep the content mounted (but hidden) while closed. */
  keepMounted?: boolean;
  children?: React.ReactNode;
}

export default function AnalysisDisclosure({
  id,
  title,
  badge = null,
  meta = null,
  open,
  onToggle,
  keepMounted = false,
  children,
}: AnalysisDisclosureProps) {
  const ids = analysisDisclosureIds(id);
  return (
    <section className="card analysis-disclosure" data-testid={id}>
      {/* Heading-wrapped button: disclosures participate in the page heading
          hierarchy (Analysis h1 → section h2) while the button keeps the
          aria-expanded/aria-controls disclosure semantics. */}
      <h2 className="analysis-disclosure__heading">
        <button
          type="button"
          id={ids.headerId}
          data-testid={ids.toggleTestId}
          className="analysis-disclosure__header"
          aria-expanded={open}
          aria-controls={ids.contentId}
          onClick={() => onToggle(!open)}
        >
          <span className="analysis-disclosure__chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="analysis-disclosure__title">{title}</span>
          {badge != null && (
            <span className="analysis-disclosure__badge">{badge}</span>
          )}
          {meta != null && (
            <span className="analysis-disclosure__meta">{meta}</span>
          )}
        </button>
      </h2>
      {(open || keepMounted) && (
        <div
          id={ids.contentId}
          data-testid={ids.contentTestId}
          className="analysis-disclosure__content"
          role="region"
          aria-labelledby={ids.headerId}
          tabIndex={-1}
          hidden={!open}
        >
          {children}
        </div>
      )}
    </section>
  );
}
