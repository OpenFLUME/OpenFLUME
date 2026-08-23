/**
 * e2e/analysis.ts — shared helpers for the redesigned Analysis workspace.
 *
 * The Analysis view keeps secondary sections (run details, final/result
 * tables, solver diary, run history) inside closed AnalysisDisclosure cards;
 * the plots panel — whose title doubles as the run selector — is the
 * always-visible surface (charts live in its plot tabs, not in a
 * disclosure).  Specs that exercise disclosure
 * content expand the owning section first via openAnalysisSection — a
 * semantic action (click the labelled header button, assert aria-expanded)
 * rather than a selector workaround.
 */
import { expect, type Page } from "@playwright/test";

/** Disclosure keys, matching the AnalysisDisclosure ids in ResultsPanel. */
export type AnalysisSectionKey = "summary" | "final" | "diary" | "runs";

/**
 * Expand an Analysis disclosure (no-op when already open).  Waits for the
 * toggle, clicks it only while closed, and asserts the expanded state so a
 * missing section fails loudly here instead of at a downstream selector.
 */
export async function openAnalysisSection(
  page: Page,
  key: AnalysisSectionKey,
): Promise<void> {
  const toggle = page.locator(`[data-testid="${key}-toggle"]`);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}
