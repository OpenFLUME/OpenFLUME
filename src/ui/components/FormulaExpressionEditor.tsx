/**
 * FormulaExpressionEditor — the visual token-field editor for formula
 * sources (the text of a `={expr}` FormulaUnitInput value).
 *
 * The SOURCE STRING is the only state that matters: what the user commits
 * is exactly the text the editor holds, byte-for-byte.  Model references
 * (segmentFormula chips) render as atomic `contenteditable=false` spans;
 * helpers, builtins, operators and literals stay ordinary text.
 *
 * Implementation contract (why it looks the way it looks):
 *
 *  - The host div's content is rendered via dangerouslySetInnerHTML from
 *    `rendered`, a state string that ONLY changes (a) when the committed
 *    text prop changes while the editor is NOT focused, and (b) on explicit
 *    programmatic edits (accept a suggestion, remove/explode a chip, paste).
 *    Ordinary typing is read OUT of the DOM (onInput → onTextChange) without
 *    re-rendering the content, so React never rewrites nodes under the caret
 *    and innerHTML replacement can never hit detached-node reconciliation.
 *  - Every programmatic edit stores a pending caret/selection (source
 *    offsets) that a layout effect restores after the React commit.
 *  - Native contenteditable undo is blocked (it would desync the DOM from
 *    the source of truth); store undo applies after commit, exactly like
 *    the plain input path.
 *  - The autocomplete menu is portaled to document.body (the property
 *    panel clips overflow) and is driven by the pure
 *    completionContext/buildFormulaCatalog machinery.  It opens as you
 *    type and on Ctrl+Space. The click-first browser uses the same editor's
 *    imperative insertion surface.
 *
 * Nothing here throws on weird input: the tokenizer/segmenter are tolerant
 * by design and every DOM helper degrades to the end-of-text caret.
 */
import React from "react";
import { createPortal } from "react-dom";
import { parseFormulaInput } from "../formulaBinding";
import {
  explodeSegmentSource,
  removeSegmentSource,
  segmentFormula,
  type FormulaChip,
  type FormulaSegment,
} from "../formulaTokens";
import {
  applyFormulaCompletion,
  completionContext,
  type FormulaCatalog,
  type FormulaCompletion,
  type FormulaSuggestion,
} from "../formulaCompletion";

/* ------------------------------------------------------------------ */
/* Pure HTML builders (exported for tests)                             */
/* ------------------------------------------------------------------ */

/** Escape text/attribute content for the editor's innerHTML. */
export function escapeFormulaHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Static-scope validity of a chip against the catalog: the accessor's
 * entity list must contain the id, and (except `reg`) the property chain
 * must be one of the entity's leaf paths.  Invalid chips keep their source
 * untouched — they only render a warning style.
 */
export function isFormulaChipValid(
  catalog: FormulaCatalog,
  chip: FormulaChip,
): boolean {
  const entities = catalog.entities[chip.accessor];
  if (!entities) return false;
  const entity = entities.find((e) => e.id === chip.id);
  if (!entity) return false;
  if (chip.accessor === "reg") return chip.properties.length === 0;
  if (chip.properties.length === 0) return false;
  const path = chip.properties.join(".");
  return entity.properties.some((p) => p.path.join(".") === path);
}

export interface FormulaEditorHtmlOptions {
  /** Source start offset of the currently selected chip, if any. */
  selectedChipStart?: number | null;
  /** Source start offset of an EXPLODED chip: its span renders as raw
   *  editable text (the user is editing the reference source itself). */
  explodeChipStart?: number | null;
  /** data-testid prefix for chip spans (`${testId}-chip`). */
  testId?: string;
  /** Validity predicate (defaults: everything valid). */
  isValid?: (chip: FormulaChip) => boolean;
}

/**
 * Render the editor content HTML for `source`: exact text segments plus
 * atomic chip spans.  Chips carry their exact source span in data
 * attributes so DOM↔source mapping never re-derives anything.
 */
export function buildFormulaEditorHtml(
  source: string,
  opts: FormulaEditorHtmlOptions = {},
): string {
  const segments = segmentFormula(source);
  let html = "";
  for (const seg of segments) {
    const raw = source.slice(seg.start, seg.end);
    if (seg.type === "text" || seg.start === opts.explodeChipStart) {
      // Exploded chips render as their raw, editable source text.
      html += escapeFormulaHtml(raw);
      continue;
    }
    const { chip } = seg;
    const valid = opts.isValid ? opts.isValid(chip) : true;
    const selected = opts.selectedChipStart === seg.start;
    const cls = ["formula-chip"];
    if (!valid) cls.push("formula-chip--invalid");
    if (selected) cls.push("formula-chip--selected");
    const title = valid
      ? `${raw} — click to select, double-click to edit as text`
      : `${raw} — not a valid static reference (the source is kept as typed)`;
    html +=
      `<span class="${cls.join(" ")}" contenteditable="false"` +
      ` data-chip-start="${seg.start}" data-chip-end="${seg.end}"` +
      ` data-chip-source="${escapeFormulaHtml(raw)}"` +
      (opts.testId
        ? ` data-testid="${escapeFormulaHtml(opts.testId)}-chip"`
        : "") +
      ` title="${escapeFormulaHtml(title)}">` +
      `<span class="formula-chip__accessor">${escapeFormulaHtml(chip.accessor)}</span>` +
      (valid
        ? ""
        : '<span class="formula-chip__warn" aria-hidden="true">⚠</span>') +
      `<span class="formula-chip__label">${escapeFormulaHtml(chip.label)}</span>` +
      `<button type="button" class="formula-chip__remove" data-chip-remove="${seg.start}" tabindex="-1"` +
      ` aria-label="Remove reference ${escapeFormulaHtml(chip.label)}"` +
      ` title="Remove this reference (the rest of the formula is kept)">×</button>` +
      `</span>`;
  }
  return html;
}

/* ------------------------------------------------------------------ */
/* DOM helpers (client-only; every one tolerates missing nodes)        */
/* ------------------------------------------------------------------ */

type ChipSegment = Extract<FormulaSegment, { type: "chip" }>;

/** Type-guard predicate: the chip segment starting at `start`, if any. */
function chipAt(start: number): (s: FormulaSegment) => s is ChipSegment {
  return (s): s is ChipSegment => s.type === "chip" && s.start === start;
}

function isChipElement(node: Node): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    node.dataset !== undefined &&
    node.dataset.chipSource !== undefined
  );
}

/** Source length of one child node: text length, or the chip's span length. */
function sourceLengthOf(node: Node): number {
  if (node.nodeType === 3) return (node as Text).data.length;
  if (isChipElement(node)) {
    const el = node as HTMLElement;
    return (
      Number(el.dataset.chipEnd ?? 0) - Number(el.dataset.chipStart ?? 0) ||
      (el.dataset.chipSource ?? "").length
    );
  }
  return (node.textContent ?? "").length;
}

/**
 * Reconstruct the exact source string from the editor DOM: text nodes
 * contribute their characters; chip spans contribute their recorded exact
 * source slice.  Newlines (only possible via a stray browser edit) are
 * normalized to spaces so the source stays a single-line expression.
 */
export function readFormulaEditorText(host: HTMLElement): string {
  let out = "";
  host.childNodes.forEach((node) => {
    if (node.nodeType === 3) out += (node as Text).data;
    else if (isChipElement(node))
      out += (node as HTMLElement).dataset.chipSource ?? "";
    else if (node instanceof HTMLElement && node.tagName === "BR") out += " ";
    else out += node.textContent ?? "";
  });
  return out.replace(/[\r\n]+/g, " ");
}

/** Current caret position as a source offset; null when no selection inside. */
function caretOffsetFromDom(host: HTMLElement): number | null {
  if (
    typeof window === "undefined" ||
    typeof window.getSelection !== "function"
  )
    return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.anchorNode === null) return null;
  if (!host.contains(sel.anchorNode)) return null;
  let offset = 0;
  const children = Array.from(host.childNodes);
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (sel.anchorNode === host && sel.anchorOffset === i) return offset;
    if (node === sel.anchorNode || node.contains(sel.anchorNode)) {
      if (node.nodeType === 3)
        return offset + Math.min(sel.anchorOffset, (node as Text).data.length);
      // Inside a chip (should not happen — chips are atomic): count it whole.
      return offset + sourceLengthOf(node);
    }
    offset += sourceLengthOf(node);
  }
  if (sel.anchorNode === host && sel.anchorOffset >= children.length)
    return offset;
  return offset;
}

/** Locate the DOM position of a source offset (for caret/selection restore). */
function domPositionAt(
  host: HTMLElement,
  sourceOffset: number,
): { node: Node; offset: number } {
  let remaining = Math.max(0, sourceOffset);
  const children = Array.from(host.childNodes);
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    const len = sourceLengthOf(node);
    if (node.nodeType === 3 && remaining <= len)
      return { node, offset: remaining };
    if (remaining <= 0) return { node: host, offset: i };
    if (isChipElement(node) && remaining < len) {
      // Landing inside a chip span: snap to its end (chips are atomic).
      return { node: host, offset: i + 1 };
    }
    remaining -= len;
  }
  return { node: host, offset: children.length };
}

function setDomCaret(host: HTMLElement, sourceOffset: number): void {
  if (
    typeof window === "undefined" ||
    typeof window.getSelection !== "function"
  )
    return;
  const pos = domPositionAt(host, sourceOffset);
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setDomSelection(host: HTMLElement, start: number, end: number): void {
  if (
    typeof window === "undefined" ||
    typeof window.getSelection !== "function"
  )
    return;
  const a = domPositionAt(host, start);
  const b = domPositionAt(host, end);
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Viewport rect of the caret (fallback: the editor box). */
function caretRect(host: HTMLElement): {
  left: number;
  top: number;
  bottom: number;
} {
  if (
    typeof window !== "undefined" &&
    typeof window.getSelection === "function"
  ) {
    const sel = window.getSelection();
    if (
      sel &&
      sel.rangeCount > 0 &&
      sel.anchorNode !== null &&
      host.contains(sel.anchorNode)
    ) {
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(true);
      const rects = range.getClientRects();
      const r = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
      if (
        r &&
        (r.width !== 0 || r.height !== 0 || r.top !== 0 || r.left !== 0)
      ) {
        return { left: r.left, top: r.top, bottom: r.bottom };
      }
    }
  }
  const hr = host.getBoundingClientRect();
  return { left: hr.left + 8, top: hr.top, bottom: hr.bottom };
}

/* ------------------------------------------------------------------ */
/* Autocomplete menu                                                   */
/* ------------------------------------------------------------------ */

const MENU_WIDTH = 300;
const MENU_MAX_HEIGHT = 264;

interface MenuState {
  completion: FormulaCompletion;
  suggestions: FormulaSuggestion[];
  active: number;
  left: number;
  top: number;
}

function placeMenu(rect: { left: number; top: number; bottom: number }): {
  left: number;
  top: number;
} {
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;
  const left = Math.max(8, Math.min(rect.left, vw - MENU_WIDTH - 8));
  const below = vh - rect.bottom;
  const top =
    below >= MENU_MAX_HEIGHT + 8 || below >= rect.top
      ? rect.bottom + 4
      : Math.max(8, rect.top - MENU_MAX_HEIGHT - 4);
  return { left, top };
}

const KIND_BADGE: Record<FormulaSuggestion["kind"], string> = {
  accessor: "ref",
  helper: "fn",
  builtin: "fn",
  id: "id",
  property: "prop",
};

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export interface FormulaExpressionEditorProps {
  /** Current text (the '='-leading field text).  Authoritative when the
   *  editor is NOT focused; while focused the editor is the authority and
   *  reports changes through onTextChange. */
  text: string;
  /** Completion catalog for the current config (buildFormulaCatalog). */
  catalog: FormulaCatalog;
  disabled?: boolean;
  id?: string;
  ariaLabel: string;
  ariaInvalid?: boolean;
  /** data-testid prefix: `-editor`, `-chip`, `-autocomplete`, `-suggestion`,
   *  `-announce` are derived from it. */
  dataTestId?: string;
  onFocus: () => void;
  onTextChange: (text: string) => void;
  /** Commit the current text (blur/Enter semantics live with the caller).
   *  The optional override carries the exact text for edits that happen
   *  WITHOUT focus (e.g. clicking a chip's remove button in display mode),
   *  where the caller's local raw state has not caught up yet. */
  onCommit: (overrideText?: string) => void;
}

const useIsoLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/**
 * Imperative surface used by FormulaUnitInput's click-first formula browser.
 */
export interface FormulaExpressionEditorHandle {
  /**
   * Focus the editor and force-open the variable picker at the current
   * caret (append position when the editor was not focused).  A source
   * that is not a formula yet (a literal field) enters formula mode first:
   * it is replaced by the bare '=' leader with the caret right after it,
   * so a picked item starts a fresh formula.  Nothing commits here — the
   * usual blur/Enter path stays the only commit.
   */
  beginFormula: () => void;
  insertFormulaSource: (source: string, caretOffset?: number) => void;
}

const FormulaExpressionEditor = React.forwardRef<
  FormulaExpressionEditorHandle,
  FormulaExpressionEditorProps
>(function FormulaExpressionEditor(
  {
    text,
    catalog,
    disabled = false,
    id,
    ariaLabel,
    ariaInvalid,
    dataTestId,
    onFocus,
    onTextChange,
    onCommit,
  },
  ref,
) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const listboxId = React.useId();

  const [editing, setEditing] = React.useState(false);
  const [rendered, setRendered] = React.useState(text);
  const [explodeChipStart, setExplodeChipStart] = React.useState<number | null>(
    null,
  );
  const [announce, setAnnounce] = React.useState("");
  const [menu, setMenu] = React.useState<MenuState | null>(null);

  const editingRef = React.useRef(false);
  const menuRef = React.useRef<MenuState | null>(null);
  const textRef = React.useRef(text);
  const renderedRef = React.useRef(rendered);
  const mouseDownRef = React.useRef(false);
  const pendingCaretRef = React.useRef<number | null>(null);
  const pendingSelectionRef = React.useRef<{
    start: number;
    end: number;
  } | null>(null);
  const lastChipsRef = React.useRef<string[]>([]);
  const catalogRef = React.useRef(catalog);
  const onCommitRef = React.useRef(onCommit);
  /**
   * The selected chip's source start.  This is a REF (not state) on
   * purpose: while editing, the host's innerHTML is frozen between
   * programmatic edits, so selection styling is applied imperatively via
   * classList — a state-driven re-render here would rewrite innerHTML from
   * the stale `rendered` source and wipe the user's in-flight typing.
   */
  const selectedChipRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    menuRef.current = menu;
  }, [menu]);
  React.useEffect(() => {
    textRef.current = text;
  }, [text]);
  React.useEffect(() => {
    renderedRef.current = rendered;
  }, [rendered]);
  React.useEffect(() => {
    catalogRef.current = catalog;
  }, [catalog]);
  React.useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const isValidChip = React.useCallback(
    (chip: FormulaChip) => isFormulaChipValid(catalog, chip),
    [catalog],
  );

  /* Sync from the authoritative text whenever we are NOT editing. */
  React.useEffect(() => {
    if (!editing) setRendered(text);
  }, [text, editing]);

  /** Chip source texts of a source string (for add/remove announcements). */
  const chipSourcesOf = React.useCallback(
    (t: string) =>
      segmentFormula(t)
        .filter(
          (s): s is Extract<FormulaSegment, { type: "chip" }> =>
            s.type === "chip",
        )
        .map((s) => t.slice(s.start, s.end)),
    [],
  );

  const announceChipDiff = React.useCallback(
    (newText: string) => {
      const before = lastChipsRef.current;
      const after = chipSourcesOf(newText);
      lastChipsRef.current = after;
      if (after.length === before.length) return;
      if (after.length > before.length) {
        const added = after.filter(
          (s) =>
            before.filter((b) => b === s).length <
            after.filter((a) => a === s).length,
        );
        setAnnounce(`Reference added: ${added[added.length - 1] ?? "chip"}`);
      } else {
        const removed = before.filter(
          (s) =>
            after.filter((a) => a === s).length <
            before.filter((b) => b === s).length,
        );
        setAnnounce(`Removed reference ${removed[0] ?? "chip"}`);
      }
    },
    [chipSourcesOf],
  );

  /* ------- programmatic edit: new source + caret/selection restore ------- */

  const applySource = React.useCallback(
    (
      newSource: string,
      opts: {
        caret?: number;
        selection?: { start: number; end: number };
        announce?: string;
        /** Keep this chip span exploded (rendered as raw text) after the edit. */
        explode?: number | null;
      } = {},
    ) => {
      pendingCaretRef.current = opts.caret ?? null;
      pendingSelectionRef.current = opts.selection ?? null;
      lastChipsRef.current = chipSourcesOf(newSource);
      selectedChipRef.current = null;
      setMenu(null);
      setExplodeChipStart(opts.explode ?? null);
      setRendered(newSource);
      onTextChange(newSource);
      if (opts.announce) setAnnounce(opts.announce);
    },
    [chipSourcesOf, onTextChange],
  );

  /** Current source: prefer the live DOM while editing (user may have typed). */
  const currentSource = React.useCallback((): string => {
    const host = hostRef.current;
    if (host && editingRef.current) return readFormulaEditorText(host);
    return renderedRef.current;
  }, []);

  const removeChipAt = React.useCallback(
    (chipStart: number) => {
      const src = currentSource();
      const seg = segmentFormula(src).find(chipAt(chipStart));
      if (!seg) return;
      const { source, caret } = removeSegmentSource(src, seg);
      applySource(source, {
        caret,
        announce: `Removed reference ${seg.chip.label}`,
      });
      // Clicking a remove button in DISPLAY mode never focuses the editor
      // (mousedown is prevented), so there is no upcoming blur to commit
      // the change — commit immediately with the exact new text.
      if (!editingRef.current) onCommitRef.current(source);
    },
    [applySource, currentSource],
  );

  const explodeChipAt = React.useCallback(
    (chipStart: number) => {
      const src = currentSource();
      const seg = segmentFormula(src).find(chipAt(chipStart));
      if (!seg) return;
      const { source, selectionStart, selectionEnd } = explodeSegmentSource(
        src,
        seg,
      );
      applySource(source, {
        selection: { start: selectionStart, end: selectionEnd },
        announce: `Editing reference ${seg.chip.label} as text`,
        explode: seg.start,
      });
    },
    [applySource, currentSource],
  );

  /* ------- caret/selection restore after programmatic re-render ---------- */

  useIsoLayoutEffect(() => {
    if (!editingRef.current) return;
    const host = hostRef.current;
    if (!host) return;
    if (pendingSelectionRef.current !== null) {
      const { start, end } = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      pendingCaretRef.current = null;
      setDomSelection(host, start, end);
    } else if (pendingCaretRef.current !== null) {
      const caret = pendingCaretRef.current;
      pendingCaretRef.current = null;
      setDomCaret(host, caret);
    } else if (caretOffsetFromDom(host) === null) {
      // The host became editable DURING a click, so the browser may not
      // have placed a caret at all — fall back to end-of-text.
      setDomCaret(host, readFormulaEditorText(host).length);
    }
  });

  /* Keep the active option visible while keyboard-navigating. */
  React.useEffect(() => {
    if (!menu || !listRef.current) return;
    const el = listRef.current.querySelector('[aria-selected="true"]');
    if (el instanceof HTMLElement) el.scrollIntoView({ block: "nearest" });
  }, [menu]);

  /* Close the menu on scroll/resize: the fixed-position anchor is stale. */
  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu !== null]);

  /* ------- autocomplete -------------------------------------------------- */

  const openMenu = React.useCallback(
    (force: boolean) => {
      const host = hostRef.current;
      if (!host || disabled) return;
      const src = readFormulaEditorText(host);
      const caret = caretOffsetFromDom(host) ?? src.length;
      const completion = completionContext(src, caret, catalogRef.current);
      // Drop suggestions whose insertion would not change the text (e.g. a
      // fully-typed property) so Enter still commits on an exact match.
      const replaced = src.slice(
        completion.replaceStart,
        completion.replaceEnd,
      );
      const suggestions = completion.suggestions.filter(
        (s) => s.insertText !== replaced,
      );
      const autoOpen =
        completion.kind !== "toplevel" ||
        completion.prefix.length > 0 ||
        /^=\s*$/.test(src);
      if (suggestions.length === 0 || (!force && !autoOpen)) {
        setMenu(null);
        return;
      }
      const pos = placeMenu(caretRect(host));
      setMenu({
        completion,
        suggestions,
        active: 0,
        left: pos.left,
        top: pos.top,
      });
    },
    [disabled],
  );

  const acceptSuggestion = React.useCallback(
    (suggestion: FormulaSuggestion) => {
      const m = menuRef.current;
      if (!m) return;
      const src = currentSource();
      const { source, caret } = applyFormulaCompletion(
        src,
        m.completion,
        suggestion,
      );
      applySource(source, { caret, announce: `Inserted ${suggestion.label}` });
      // A completed reference re-chips on this render; keep the flow going:
      // reopen for the natural next context (id list after '(', properties
      // after a trailing dot) without stealing keystrokes.
      window.setTimeout(() => {
        if (editingRef.current) openMenu(false);
      }, 0);
    },
    [applySource, currentSource, openMenu],
  );

  /** Enter formula mode without requiring the user to type the `=` leader. */
  const beginFormula = React.useCallback(() => {
    const host = hostRef.current;
    if (!host || disabled) return;
    if (!editingRef.current) host.focus();
    if (!editingRef.current) return; // focus rejected (e.g. disabled)
    const src = readFormulaEditorText(host);
    if (!/^\s*=/.test(src)) {
      applySource("=", {
        caret: 1,
        announce: "Formula mode — choose an option to insert",
      });
    }
  }, [disabled, applySource]);

  /** Insert a complete browser choice at the caret, adding formula mode first. */
  const insertFormulaSource = React.useCallback(
    (fragment: string, caretOffset = fragment.length) => {
      const host = hostRef.current;
      if (!host || disabled) return;
      if (!editingRef.current) host.focus();
      if (!editingRef.current) return;
      let src = readFormulaEditorText(host);
      let caret = caretOffsetFromDom(host) ?? src.length;
      if (!/^\s*=/.test(src)) {
        src = "=";
        caret = 1;
      }
      const offset = Math.max(0, Math.min(caretOffset, fragment.length));
      applySource(src.slice(0, caret) + fragment + src.slice(caret), {
        caret: caret + offset,
        announce: `Inserted ${fragment}`,
      });
    },
    [disabled, applySource],
  );

  React.useImperativeHandle(
    ref,
    () => ({ beginFormula, insertFormulaSource }),
    [beginFormula, insertFormulaSource],
  );

  /* ------- focus / blur / commit ----------------------------------------- */

  const handleFocus = () => {
    if (disabled) return;
    editingRef.current = true;
    setEditing(true);
    setRendered(textRef.current);
    lastChipsRef.current = chipSourcesOf(textRef.current);
    onFocus();
    // Keyboard focus (no mouse) starts with the caret at the end.
    if (!mouseDownRef.current) pendingCaretRef.current = textRef.current.length;
    mouseDownRef.current = false;
  };

  const handleBlur = () => {
    mouseDownRef.current = false;
    editingRef.current = false;
    setEditing(false);
    setMenu(null);
    selectedChipRef.current = null;
    setExplodeChipStart(null);
    onCommitRef.current();
  };

  /** Imperative selection styling (see selectedChipRef): never re-renders. */
  const applySelectionClass = () => {
    const host = hostRef.current;
    if (!host) return;
    host
      .querySelectorAll(".formula-chip--selected")
      .forEach((el) => el.classList.remove("formula-chip--selected"));
    if (selectedChipRef.current !== null) {
      host
        .querySelector(`[data-chip-start="${selectedChipRef.current}"]`)
        ?.classList.add("formula-chip--selected");
    }
  };

  /* ------- DOM event handlers -------------------------------------------- */

  const handleInput = () => {
    const host = hostRef.current;
    if (!host) return;
    const src = readFormulaEditorText(host);
    const parsed = parseFormulaInput(src);
    if (!/^\s*=/.test(src) && parsed.kind === "formula") {
      const next = `=${src}`;
      applySource(next, {
        caret: (caretOffsetFromDom(host) ?? src.length) + 1,
        announce: "Formula mode",
      });
      window.setTimeout(() => {
        if (editingRef.current) openMenu(false);
      }, 0);
      return;
    }
    // Typing invalidates any chip selection (the DOM no longer matches a
    // selection made before the edit) — ref-only, no re-render.
    selectedChipRef.current = null;
    onTextChange(src);
    announceChipDiff(src);
    openMenu(false);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const host = hostRef.current;
    if (!host) return;
    const clip = (e.clipboardData.getData("text/plain") || "").replace(
      /[\r\n]+/g,
      " ",
    );
    if (clip === "") return;
    const src = readFormulaEditorText(host);
    const caret = caretOffsetFromDom(host) ?? src.length;
    applySource(src.slice(0, caret) + clip + src.slice(caret), {
      caret: caret + clip.length,
    });
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    mouseDownRef.current = true;
    // Keep focus on the host when a chip remove button is pressed.
    if (
      e.target instanceof HTMLElement &&
      e.target.closest("[data-chip-remove]")
    )
      e.preventDefault();
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || !(e.target instanceof HTMLElement)) return;
    const removeBtn = e.target.closest("[data-chip-remove]");
    if (removeBtn instanceof HTMLElement) {
      e.preventDefault();
      const start = Number(removeBtn.dataset.chipRemove ?? NaN);
      if (Number.isFinite(start)) removeChipAt(start);
      return;
    }
    const chipEl = e.target.closest("[data-chip-start]");
    if (chipEl instanceof HTMLElement) {
      const start = Number(chipEl.dataset.chipStart ?? NaN);
      const end = Number(chipEl.dataset.chipEnd ?? NaN);
      if (Number.isFinite(start)) {
        selectedChipRef.current = start;
        applySelectionClass();
        if (Number.isFinite(end)) pendingCaretRef.current = end;
      }
      return;
    }
    if (selectedChipRef.current !== null) {
      selectedChipRef.current = null;
      applySelectionClass();
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || !(e.target instanceof HTMLElement)) return;
    const chipEl = e.target.closest("[data-chip-start]");
    if (chipEl instanceof HTMLElement) {
      e.preventDefault();
      const start = Number(chipEl.dataset.chipStart ?? NaN);
      if (Number.isFinite(start)) explodeChipAt(start);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const host = hostRef.current;

    // Block native contenteditable undo/redo — it would desync the DOM from
    // the source of truth.  Store undo applies after commit (see App.tsx).
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === " ") {
      e.preventDefault();
      openMenu(true);
      return;
    }

    const m = menuRef.current;
    if (m) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setMenu({
          ...m,
          active:
            (m.active + delta + m.suggestions.length) % m.suggestions.length,
        });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptSuggestion(m.suggestions[m.active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }

    // Selected-chip commands.  The selection is validated against the LIVE
    // source: typing (which never re-renders the frozen content) may have
    // removed the chip already — a stale selection falls through to the
    // ordinary key handling below.
    let selectedSeg: ChipSegment | undefined;
    if (selectedChipRef.current !== null && host) {
      selectedSeg = segmentFormula(readFormulaEditorText(host)).find(
        chipAt(selectedChipRef.current),
      );
      if (!selectedSeg) {
        selectedChipRef.current = null;
        applySelectionClass();
      }
    }
    if (selectedSeg) {
      if (e.key === "Enter") {
        e.preventDefault();
        explodeChipAt(selectedSeg.start);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        removeChipAt(selectedSeg.start);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        selectedChipRef.current = null;
        applySelectionClass();
        return;
      }
      // Typing over a selected chip replaces it with the typed character.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && host) {
        e.preventDefault();
        const src = readFormulaEditorText(host);
        const { source, caret } = removeSegmentSource(src, selectedSeg);
        const next = source.slice(0, caret) + e.key + source.slice(caret);
        applySource(next, {
          caret: caret + 1,
          announce: `Removed reference ${selectedSeg.chip.label}`,
        });
        return;
      }
    }

    if (e.key === "Enter") {
      // Commit semantics live in the blur handler (one store update).
      e.preventDefault();
      host?.blur();
      return;
    }

    if ((e.key === "Backspace" || e.key === "Delete") && host) {
      // Deterministic atomic chip removal next to the caret.
      const offset = caretOffsetFromDom(host);
      if (offset !== null) {
        const src = readFormulaEditorText(host);
        const chip = segmentFormula(src).find(
          (s): s is ChipSegment =>
            s.type === "chip" &&
            (e.key === "Backspace" ? s.end === offset : s.start === offset),
        );
        if (chip) {
          e.preventDefault();
          const { source, caret } = removeSegmentSource(src, chip);
          applySource(source, {
            caret,
            announce: `Removed reference ${chip.chip.label}`,
          });
        }
      }
    }
  };

  /* ------- render --------------------------------------------------------- */

  // NOTE: no selectedChipStart here — while editing the content is frozen
  // and selection styling is applied imperatively (applySelectionClass);
  // the builder option exists for pure/server rendering and tests.
  const html = React.useMemo(
    () =>
      buildFormulaEditorHtml(rendered, {
        explodeChipStart,
        testId: dataTestId,
        isValid: isValidChip,
      }),
    [rendered, explodeChipStart, dataTestId, isValidChip],
  );

  const hostClass =
    "input formula-expression-editor" +
    (editing ? " formula-expression-editor--editing" : "") +
    (disabled ? " formula-expression-editor--disabled" : "");

  return (
    <div
      className="formula-editor"
      data-testid={dataTestId ? `${dataTestId}-editor-root` : undefined}
    >
      <div
        ref={hostRef}
        id={id}
        className={hostClass}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="false"
        aria-invalid={ariaInvalid || undefined}
        aria-autocomplete="list"
        aria-expanded={menu !== null || undefined}
        aria-controls={menu !== null ? listboxId : undefined}
        aria-activedescendant={
          menu !== null && menu.suggestions.length > 0
            ? `${listboxId}-opt-${menu.active}`
            : undefined
        }
        contentEditable={!disabled && editing}
        suppressContentEditableWarning
        tabIndex={disabled ? undefined : 0}
        data-testid={dataTestId ? `${dataTestId}-editor` : undefined}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleMouseDown}
        onPaste={handlePaste}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div
        className="visually-hidden"
        role="status"
        aria-live="polite"
        data-testid={dataTestId ? `${dataTestId}-announce` : undefined}
      >
        {announce}
      </div>
      {menu !== null &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="formula-autocomplete"
            data-testid={dataTestId ? `${dataTestId}-autocomplete` : undefined}
            style={{
              position: "fixed",
              left: menu.left,
              top: menu.top,
              zIndex: 120,
              width: MENU_WIDTH,
            }}
          >
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label="Formula suggestions"
              className="formula-autocomplete__list"
            >
              {menu.suggestions.map((s, i) => (
                <li
                  key={`${s.kind}:${s.label}`}
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={i === menu.active}
                  className="formula-autocomplete__option"
                  data-testid={
                    dataTestId ? `${dataTestId}-suggestion` : undefined
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => {
                    const m = menuRef.current;
                    if (m && m.active !== i) setMenu({ ...m, active: i });
                  }}
                  onClick={() => acceptSuggestion(s)}
                >
                  <span
                    className={`formula-autocomplete__kind formula-autocomplete__kind--${s.kind}`}
                  >
                    {KIND_BADGE[s.kind]}
                  </span>
                  <span className="formula-autocomplete__label">{s.label}</span>
                  <span className="formula-autocomplete__detail">
                    {s.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
});

export default FormulaExpressionEditor;
