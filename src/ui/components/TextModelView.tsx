/**
 * TextModelView — the model source editor (Stage 5).
 *
 * A full-workspace text projection of the canonical config, wired to the
 * store's AST-as-source primitives (`modelText` / `textDraft` /
 * `textDiagnostics` / `setModelText` / `revertModelText`).
 *
 * Editing policy:
 *  - keystrokes land in a LOCAL buffer only — no store calls, no history
 *    entries, one native textarea undo history;
 *  - Apply (or Cmd/Ctrl+Enter) commits via `setModelText`: a valid text
 *    wholesale-replaces the config as exactly ONE undoable entry and the
 *    buffer collapses to the reserialized canonical form; an invalid text is
 *    retained (store draft + diagnostics) and the config is untouched — the
 *    solver never sees it;
 *  - Revert discards the local/invalid draft and restores the canonical
 *    `modelText`.
 *
 * Selection sync (both directions suppressed while the buffer is dirty):
 *  - store selection (diagram / inspector / issues) → the entity's record
 *    line is highlighted and scrolled into view;
 *  - caret on a clean entity record line → store selection follows (no
 *    config/history churn — `setSelection` only), with echo suppression so
 *    the two directions never fight.
 */
import React from "react";
import { useStore } from "../store";
import { serializeTextWithLineMap } from "../../substrate/textProjection";
import type { Selection } from "../types";
import {
  TEXT_LINE_HEIGHT,
  entityAtLine,
  lineForOffset,
  lineEndOffset,
  lineStartOffsets,
  offsetForLine,
  revealTargetForSelection,
  selectionForCaretLine,
} from "../textModelSync";

/** Human-readable kind names for the caret status readout ('multi' never
 *  appears here: the text view maps carets to single entities only). */
const KIND_LABELS: Record<
  Exclude<Selection["kind"], "none" | "multi">,
  string
> = {
  node: "node",
  branch: "branch",
  solidNode: "solid node",
  conductor: "conductor",
  group: "subnetwork",
  note: "note",
};

/** Highlight `line` (1-based) in the textarea and scroll it into view. */
function revealLine(
  ta: HTMLTextAreaElement,
  text: string,
  offsets: number[],
  line: number,
): void {
  const start = offsetForLine(offsets, line);
  const end = lineEndOffset(text, offsets, line);
  try {
    ta.setSelectionRange(start, end);
  } catch {
    // Non-browser environments without full selection support.
  }
  ta.scrollTop = Math.max(0, (line - 3) * TEXT_LINE_HEIGHT);
}

export default function TextModelView(): React.ReactElement {
  const config = useStore((s) => s.config);
  const modelText = useStore((s) => s.modelText);
  const textDraft = useStore((s) => s.textDraft);
  const diagnostics = useStore((s) => s.textDiagnostics);
  const selection = useStore((s) => s.selection);
  const setModelText = useStore((s) => s.setModelText);
  const revertModelText = useStore((s) => s.revertModelText);
  const setSelection = useStore((s) => s.setSelection);

  // Local editing buffer, initialized from the store draft (which retains a
  // pending invalid edit across view switches).
  const [text, setText] = React.useState(() => useStore.getState().textDraft);
  const [announce, setAnnounce] = React.useState("");
  const [caretLine, setCaretLine] = React.useState<number | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  /** Store draft the local buffer was last synced to — lets external config
   *  edits resync the buffer without clobbering unapplied local edits. */
  const syncedDraftRef = React.useRef(useStore.getState().textDraft);
  /** Selection we last pushed from caret movement (echo suppression). */
  const caretEchoRef = React.useRef<Selection | null>(null);

  // External draft refresh: every config mutation reserializes the store
  // draft. Adopt it only when the local buffer carries no unapplied edits.
  React.useEffect(() => {
    if (textDraft === syncedDraftRef.current) return;
    const prev = syncedDraftRef.current;
    syncedDraftRef.current = textDraft;
    setText((local) => (local === prev ? textDraft : local));
  }, [textDraft]);

  /** Local buffer matches the store draft (no unapplied keystrokes). */
  const applied = text === textDraft;
  /** Local buffer differs from the canonical applied model. */
  const dirty = text !== modelText;
  /** The store draft is a retained invalid edit. */
  const invalid = diagnostics.length > 0;
  /** Line↔entity mapping is only trustworthy against canonical text. */
  const canonical = text === modelText;

  const { lineMap } = React.useMemo(
    () => serializeTextWithLineMap(config),
    [config],
  );
  const offsets = React.useMemo(() => lineStartOffsets(text), [text]);

  const canApply = !applied;
  const canRevert = dirty;

  const apply = () => {
    const ok = setModelText(text);
    const after = useStore.getState();
    // Success collapses the buffer to the canonical serialization (a
    // formatting-only edit snaps back); failure keeps the typed text (the
    // store draft already equals it).
    syncedDraftRef.current = after.textDraft;
    setText(after.textDraft);
    const n = after.textDiagnostics.length;
    setAnnounce(
      ok
        ? "Applied — model updated."
        : `${n} problem${n === 1 ? "" : "s"} found — model unchanged.`,
    );
  };

  const revert = () => {
    revertModelText();
    const after = useStore.getState();
    syncedDraftRef.current = after.textDraft;
    setText(after.textDraft);
    setAnnounce("Reverted to the applied model text.");
  };

  // ── Store selection → reveal the entity's record line ───────────────
  React.useEffect(() => {
    const target = revealTargetForSelection(selection, lineMap, {
      canonical,
      caretEcho: caretEchoRef.current,
    });
    const ta = textareaRef.current;
    if (!target || !ta) return;
    revealLine(ta, text, offsets, target.startLine);
    caretEchoRef.current = selection;
    setCaretLine(target.startLine);
  }, [selection, canonical, lineMap, offsets, text]);

  // ── Caret → store selection ─────────────────────────────────────────
  const syncCaretToStore = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const line = lineForOffset(offsets, ta.selectionStart);
    setCaretLine(line);
    const next = selectionForCaretLine(
      line,
      lineMap,
      useStore.getState().selection,
      { canonical },
    );
    if (next) {
      caretEchoRef.current = next;
      setSelection(next);
    }
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      // Commit shortcut; native text undo (Cmd/Ctrl+Z) is left to the field.
      e.preventDefault();
      if (canApply) apply();
    }
  };

  /** Focus the editor and highlight the offending line of a diagnostic. */
  const gotoDiagnostic = (line: number | undefined) => {
    if (line === undefined) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    revealLine(ta, text, offsets, line);
    setCaretLine(line);
  };

  const statusText = !applied
    ? invalid
      ? `Modified · ${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"}`
      : "Modified — not applied"
    : invalid
      ? `${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"} — not applied`
      : "Up to date";
  const statusClass = invalid
    ? "pill pill--danger"
    : !applied
      ? "pill pill--warn"
      : "pill pill--ok";

  const caretEntity =
    canonical && caretLine !== null ? entityAtLine(lineMap, caretLine) : null;
  const caretLabel =
    caretLine === null
      ? ""
      : `Line ${caretLine}${caretEntity && caretEntity.kind !== "none" && caretEntity.kind !== "multi" ? ` · ${KIND_LABELS[caretEntity.kind]} ${caretEntity.id}` : ""}`;

  return (
    <div className="text-model-view" data-testid="text-model-view">
      <div className="text-model-toolbar">
        <button
          type="button"
          data-testid="text-model-apply"
          className="btn btn--primary btn--sm"
          onClick={apply}
          disabled={!canApply}
          title="Apply the text to the model (Cmd/Ctrl+Enter). Invalid text is kept for fixing and never reaches the model."
        >
          Apply
        </button>
        <button
          type="button"
          data-testid="text-model-revert"
          className="btn btn--sm"
          onClick={revert}
          disabled={!canRevert}
          title="Discard unapplied edits and restore the applied model text"
        >
          Revert
        </button>
        <span
          data-testid="text-model-status"
          className={statusClass}
          role="status"
        >
          {statusText}
        </span>
        <span id="text-model-hint" className="text-model-toolbar__hint">
          Text projection of the model — edits join undo history only when
          applied (Cmd/Ctrl+Enter)
        </span>
        <span data-testid="text-model-caret" className="text-model-caret">
          {caretLabel}
        </span>
      </div>
      <textarea
        ref={textareaRef}
        data-testid="text-model-editor"
        className="text-model-editor"
        style={{ lineHeight: `${TEXT_LINE_HEIGHT}px` }}
        aria-label="Model text editor"
        aria-describedby="text-model-hint"
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onEditorKeyDown}
        onSelect={syncCaretToStore}
      />
      {invalid && (
        <div
          className="text-model-diagnostics"
          data-testid="text-model-diagnostics"
          role="region"
          aria-label="Text problems"
        >
          <ul role="list" aria-label="Text problems list">
            {diagnostics.map((d, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="text-model-diagnostic"
                  data-testid={`text-model-diagnostic-${i}`}
                  disabled={d.line === undefined}
                  onClick={() => gotoDiagnostic(d.line)}
                  aria-label={`${d.severity}${d.line !== undefined ? ` at line ${d.line}` : ""}: ${d.message}`}
                >
                  <span
                    className={`pill ${d.severity === "error" ? "pill--danger" : "pill--warn"}`}
                  >
                    {d.severity}
                  </span>
                  {d.line !== undefined && (
                    <span className="text-model-diagnostic__line">
                      Line {d.line}
                    </span>
                  )}
                  <span className="text-model-diagnostic__msg">
                    {d.message}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        className="visually-hidden"
        aria-live="polite"
        data-testid="text-model-announce"
      >
        {announce}
      </div>
    </div>
  );
}
