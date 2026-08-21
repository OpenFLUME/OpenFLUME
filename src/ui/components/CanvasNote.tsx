/**
 * CanvasNote — a free-floating text annotation on the model canvas.
 *
 * Notes document a model for the next human to open it (assumptions, sources,
 * review remarks).  They are deliberately inert: no ports, no connectivity, no
 * numerics, and no influence on the solver or the provenance hash.
 *
 * Unlike node labels, note text is CONTENT rather than decoration, so it
 * scales with the canvas instead of counter-scaling to a fixed screen size,
 * and it never participates in the label-declutter pass.
 *
 * Sizing has two regimes.  A note with no stored size takes the default width
 * and grows downward with its text, so typing never needs a resize; dragging
 * the corner handle switches it to an explicit box, which is then honoured
 * verbatim and scrolls when the text outgrows it.
 */
import React from "react";
import { NodeResizeControl } from "@xyflow/react";
import { useStore } from "../store";
import {
  CANVAS_GRID_SIZE,
  NOTE_MIN_HEIGHT,
  NOTE_MIN_WIDTH,
  NOTE_WIDTH,
} from "../canvasGeometry";

interface CanvasNoteData {
  noteId: string;
  text: string;
  width?: number;
  height?: number;
  selected: boolean;
}

const PLACEHOLDER = "Double-click to write…";

/** Snap a dragged edge to the canvas grid, never below a usable minimum. */
function snapSize(value: number, min: number): number {
  return Math.max(min, Math.round(value / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE);
}

export default React.memo(function CanvasNote({
  data,
}: {
  data: CanvasNoteData;
}) {
  const { noteId, text, selected } = data;
  const updateNote = useStore((s) => s.updateNote);
  const removeNote = useStore((s) => s.removeNote);
  // A note created from the rail arrives empty and useless, so it opens ready
  // to type.  Mount-only state: re-selecting an existing note never reopens it.
  const [editing, setEditing] = React.useState(text === "");
  const [draft, setDraft] = React.useState(text);
  const [hovered, setHovered] = React.useState(false);
  /**
   * In-flight resize.  The store is written once on release (like node drags,
   * so one gesture is one undo step), and this mirrors the pointer until then.
   */
  const [liveSize, setLiveSize] = React.useState<{
    width: number;
    height: number;
  } | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const width = liveSize?.width ?? data.width ?? NOTE_WIDTH;
  // Undefined height means auto: the card is as tall as its text.
  const height = liveSize?.height ?? data.height;
  const fixedHeight = height !== undefined;

  // Adopt external edits (property panel, text view, undo) unless the user is
  // mid-sentence in this editor.
  React.useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);

  React.useEffect(() => {
    if (!editing) return;
    let attempts = 0;
    let raf = 0;
    // React Flow mounts a brand-new node with visibility:hidden until it has
    // measured it, and focus() on a hidden element is silently dropped — so a
    // note placed from the rail would open its editor with no caret in it.
    // Keep asking for a few frames, until the node is actually on screen.
    const focusWhenVisible = () => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      if (document.activeElement === ta) {
        ta.setSelectionRange(ta.value.length, ta.value.length);
        return;
      }
      if (attempts++ < 10) raf = requestAnimationFrame(focusWhenVisible);
    };
    focusWhenVisible();
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    // An abandoned blank note would be invisible and undeletable by pointer.
    if (next === "" && text === "") {
      removeNote(noteId);
      return;
    }
    if (next !== text) updateNote(noteId, { text: next });
  };

  const cancel = () => {
    setEditing(false);
    setDraft(text);
    if (text === "") removeNote(noteId);
  };

  return (
    <div
      data-testid={`note-${noteId}`}
      className={`canvas-note${selected ? " canvas-note--selected" : ""}`}
      style={{ width, height, minHeight: NOTE_MIN_HEIGHT }}
      onDoubleClick={() => setEditing(true)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {editing ? (
        /* nodrag/nopan/nowheel hand the pointer to the textarea — without them
           React Flow reads a click as the start of a node drag or a pan, and
           the caret can never be placed. */
        <textarea
          ref={textareaRef}
          data-testid={`note-editor-${noteId}`}
          className="canvas-note__editor nodrag nopan nowheel"
          aria-label="Note text"
          value={draft}
          placeholder="Write a note…"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // Enter inserts a newline; the canvas shortcuts stay out of the way
            // (they skip textarea targets), so only the exits need handling.
            if (event.key === "Escape") {
              event.stopPropagation();
              cancel();
            } else if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <div
          data-testid={`note-text-${noteId}`}
          /* nowheel only once the box is fixed and can actually scroll —
             otherwise it would swallow zoom for a card with nothing to scroll. */
          className={[
            "canvas-note__text",
            text === "" ? "canvas-note__text--empty" : "",
            fixedHeight ? "canvas-note__text--clipped nowheel" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {text === "" ? PLACEHOLDER : text}
        </div>
      )}
      {/* Bottom-right only: the note's x/y is its top-left corner, so resizing
          from this one corner never has to move the note as well. */}
      {(selected || hovered) && (
        <NodeResizeControl
          position="bottom-right"
          className="canvas-note__resize"
          minWidth={NOTE_MIN_WIDTH}
          minHeight={NOTE_MIN_HEIGHT}
          onResize={(_event, params) =>
            setLiveSize({ width: params.width, height: params.height })
          }
          onResizeEnd={(_event, params) => {
            setLiveSize(null);
            updateNote(noteId, {
              width: snapSize(params.width, NOTE_MIN_WIDTH),
              height: snapSize(params.height, NOTE_MIN_HEIGHT),
            });
          }}
        >
          {/* Two short strokes, the conventional corner grip. */}
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M9 1v8H1" />
            <path d="M9 5.5v3.5H5.5" />
          </svg>
        </NodeResizeControl>
      )}
    </div>
  );
});
