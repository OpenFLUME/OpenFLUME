/**
 * runDiscard.ts — confirmation copy for discarding results.
 *
 * Discarding is permanent: it is outside the undo history and it clears the
 * browser-storage mirror, so a reload will not bring the runs back. Both
 * places that offer it (the project outline's Results section and the Results tab's
 * run history) ask first, and they ask with the same words — hence one module
 * rather than the same sentence written twice.
 */
import type { ConfirmRequest } from "./components/ConfirmDialog";

/** Confirmation for discarding a single named run. */
export function confirmDiscardRun(
  name: string,
  onAccept: () => void,
): ConfirmRequest {
  return {
    title: "Discard this run?",
    message: `“${name}” and its results will be deleted. This cannot be undone. The model itself is untouched.`,
    acceptLabel: "Discard run",
    onAccept,
  };
}

/** Confirmation for discarding the whole run list. */
export function confirmDiscardAllRuns(
  count: number,
  onAccept: () => void,
): ConfirmRequest {
  return {
    title: "Discard all results?",
    message: `This deletes all ${count} recorded run${
      count === 1 ? "" : "s"
    } and cannot be undone. The model itself is untouched. Use Save first if you want to keep the results.`,
    acceptLabel: "Discard all",
    onAccept,
  };
}
