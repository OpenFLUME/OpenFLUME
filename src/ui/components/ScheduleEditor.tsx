/**
 * ScheduleEditor — reusable schedule/curve editor v2.
 *
 * Used for boundary pressure/temperature schedules, ambient temperature
 * schedules, valve position schedules, flow-source schedules, and pump
 * curves. Features:
 *
 *  - Permanent unit-labeled column headers ("Time (s)", "Pressure (kPa)").
 *  - Paste TSV/CSV from the clipboard (Ctrl/Cmd+V anywhere in the grid, or
 *    the "Paste data" button with a focused-textarea fallback); pasted
 *    numbers are interpreted in the CURRENT DISPLAY units and stored as SI.
 *  - Sort-by-x, monotonic-x and duplicate-x warnings (role=alert).
 *  - Spreadsheet keys: Enter commits and moves down the same column (adding
 *    a row at the bottom), Tab moves across cells.
 *  - Add-row reuses the previous x increment instead of [0, 0].
 *  - Compact sparkline preview with axis min/max labels.
 */
import React from "react";
import { useStore } from "../store";
import {
  QuantityKind,
  getUnitDef,
  convertToSI,
  convertFromSI,
  formatNumber,
} from "../units";
import { formatSig } from "../format";
import {
  parseScheduleText,
  firstMonotonicViolation,
  hasDuplicateX,
} from "../scheduleParse";

export type ScheduleRow = [number, number];

export interface ScheduleEditorProps {
  rows: ScheduleRow[];
  onChange: (rows: ScheduleRow[]) => void;
  leftKind: QuantityKind;
  rightKind: QuantityKind;
  /** Human column names, e.g. "Time" / "Pressure" (units appended). */
  leftLabel: string;
  rightLabel: string;
  /** Base testid: `${testid}-add-row`, `-sort`, `-paste`, `-sparkline`, … */
  testid?: string;
}

export default function ScheduleEditor({
  rows,
  onChange,
  leftKind,
  rightKind,
  leftLabel,
  rightLabel,
  testid = "schedule",
}: ScheduleEditorProps) {
  const leftUnitId = useStore((s) => s.unitPreferences[leftKind]);
  const rightUnitId = useStore((s) => s.unitPreferences[rightKind]);
  const leftSymbol = getUnitDef(leftKind, leftUnitId).symbol;
  const rightSymbol = getUnitDef(rightKind, rightUnitId).symbol;

  const [rawLeft, setRawLeft] = React.useState<Record<number, string>>({});
  const [rawRight, setRawRight] = React.useState<Record<number, string>>({});
  const [focused, setFocused] = React.useState<{
    i: number;
    side: "left" | "right";
  } | null>(null);
  const [pasteFallback, setPasteFallback] = React.useState(false);
  const inputRefs = React.useRef<
    Array<[HTMLInputElement | null, HTMLInputElement | null]>
  >([]);
  const pendingFocus = React.useRef<{
    i: number;
    side: "left" | "right";
  } | null>(null);
  const skipBlurCommit = React.useRef<string | null>(null);

  const focusCell = (i: number, side: "left" | "right") => {
    const el = inputRefs.current[i]?.[side === "left" ? 0 : 1];
    el?.focus();
  };

  const getLeft = (i: number, v: number) => {
    if (focused?.i === i && focused.side === "left") return rawLeft[i] ?? "";
    return formatNumber(convertFromSI(leftKind, v, leftUnitId));
  };
  const getRight = (i: number, v: number) => {
    if (focused?.i === i && focused.side === "right") return rawRight[i] ?? "";
    return formatNumber(convertFromSI(rightKind, v, rightUnitId));
  };

  const commitCell = (i: number, side: "left" | "right"): ScheduleRow[] => {
    const str = (side === "left" ? rawLeft[i] : rawRight[i]) ?? "";
    const parsed =
      str.trim() === "" || str.trim() === "-" ? NaN : parseFloat(str);
    if (Number.isNaN(parsed)) {
      setFocused(null);
      return rows;
    }
    const kind = side === "left" ? leftKind : rightKind;
    const unit = side === "left" ? leftUnitId : rightUnitId;
    const si = convertToSI(kind, parsed, unit);
    const column = side === "left" ? 0 : 1;
    if (si === rows[i]?.[column]) {
      setFocused(null);
      return rows;
    }
    const next: ScheduleRow[] = rows.map((r) => [...r] as ScheduleRow);
    next[i][column] = si;
    onChange(next);
    setFocused(null);
    return next;
  };

  const add = (
    focusAfter = false,
    side: "left" | "right" = "left",
    source = rows,
  ) => {
    const last = source[source.length - 1];
    const previous = source[source.length - 2];
    const next: ScheduleRow = !last
      ? [0, 0]
      : [
          last[0] +
            (previous && last[0] > previous[0] ? last[0] - previous[0] : 1),
          last[1],
        ];
    onChange([...source, next]);
    if (focusAfter) pendingFocus.current = { i: source.length, side };
  };

  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));

  // Focus a pending cell after rows change (Enter-at-bottom adds + focuses).
  React.useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    if (p.i < rows.length) {
      pendingFocus.current = null;
      focusCell(p.i, p.side);
    }
  }, [rows]);

  const sortByX = () => {
    const sorted = [...rows].sort((a, b) => a[0] - b[0]);
    onChange(sorted);
  };

  /** Replace the whole grid from parsed text (SI conversion applied). */
  const applyPasteText = (text: string) => {
    const { rows: parsed } = parseScheduleText(
      text,
      leftKind,
      rightKind,
      leftUnitId,
      rightUnitId,
    );
    if (parsed.length === 0) return false;
    if (focused) {
      // Spreadsheet semantics: paste the block starting at the focused cell.
      const next: ScheduleRow[] = rows.map((r) => [...r] as ScheduleRow);
      parsed.forEach((r, di) => {
        const ti = focused.i + di;
        if (ti >= next.length) next.push([0, 0]);
        if (focused.side === "left") {
          next[ti] = [r[0], di === 0 ? r[1] : next[ti][1]];
          if (di === 0) next[ti] = [r[0], r[1]];
        } else {
          next[ti] = di === 0 ? [r[0], r[1]] : [next[ti][0], r[1]];
        }
      });
      onChange(next);
    } else {
      onChange(parsed);
    }
    return true;
  };

  const onGridPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text/plain");
    if (
      !text ||
      (!text.includes("\t") && !text.includes(",") && !text.includes("\n"))
    )
      return;
    e.preventDefault();
    applyPasteText(text);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && applyPasteText(text)) return;
      setPasteFallback(true);
    } catch {
      setPasteFallback(true);
    }
  };

  const monotonicViolation = firstMonotonicViolation(rows);
  const dupX = hasDuplicateX(rows);

  return (
    <div className="schedule-editor" data-testid={testid} onPaste={onGridPaste}>
      {/* Permanent unit-labeled header */}
      <div className="schedule-editor__row schedule-editor__head">
        <span
          className="schedule-editor__colhead"
          data-testid={`${testid}-head-x`}
        >
          {leftLabel} ({leftSymbol})
        </span>
        <span
          className="schedule-editor__colhead"
          data-testid={`${testid}-head-y`}
        >
          {rightLabel} ({rightSymbol})
        </span>
        <span className="schedule-editor__colhead" aria-hidden="true" />
      </div>
      {rows.map((row, i) => (
        <div key={i} className="schedule-editor__row">
          <input
            ref={(el) => {
              if (!inputRefs.current[i]) inputRefs.current[i] = [null, null];
              inputRefs.current[i][0] = el;
            }}
            className="input"
            type="text"
            inputMode="decimal"
            value={getLeft(i, row[0])}
            onFocus={() => {
              setFocused({ i, side: "left" });
              setRawLeft((prev) => ({
                ...prev,
                [i]: String(convertFromSI(leftKind, row[0], leftUnitId)),
              }));
            }}
            onBlur={() => {
              if (skipBlurCommit.current === `${i}:left`)
                skipBlurCommit.current = null;
              else commitCell(i, "left");
            }}
            onChange={(e) =>
              setRawLeft((prev) => ({ ...prev, [i]: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                skipBlurCommit.current = `${i}:left`;
                const committed = commitCell(i, "left");
                if (i + 1 < rows.length) focusCell(i + 1, "left");
                else add(true, "left", committed);
              }
            }}
            aria-label={`${leftLabel} row ${i + 1}`}
          />
          <input
            ref={(el) => {
              if (!inputRefs.current[i]) inputRefs.current[i] = [null, null];
              inputRefs.current[i][1] = el;
            }}
            className="input"
            type="text"
            inputMode="decimal"
            value={getRight(i, row[1])}
            onFocus={() => {
              setFocused({ i, side: "right" });
              setRawRight((prev) => ({
                ...prev,
                [i]: String(convertFromSI(rightKind, row[1], rightUnitId)),
              }));
            }}
            onBlur={() => {
              if (skipBlurCommit.current === `${i}:right`)
                skipBlurCommit.current = null;
              else commitCell(i, "right");
            }}
            onChange={(e) =>
              setRawRight((prev) => ({ ...prev, [i]: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                skipBlurCommit.current = `${i}:right`;
                const committed = commitCell(i, "right");
                if (i + 1 < rows.length) focusCell(i + 1, "right");
                else add(true, "right", committed);
              }
            }}
            aria-label={`${rightLabel} row ${i + 1}`}
          />
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => remove(i)}
            aria-label={`Remove row ${i + 1}`}
            tabIndex={-1}
          >
            ×
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
        <button
          className="btn btn--sm"
          data-testid={`${testid}-add-row`}
          onClick={() => add()}
        >
          + row
        </button>
        <button
          className="btn btn--ghost btn--sm"
          data-testid={`${testid}-sort`}
          onClick={sortByX}
          disabled={rows.length < 2}
          title={`Sort rows by ${leftLabel} (ascending)`}
        >
          Sort by {leftLabel.toLowerCase()}
        </button>
        <button
          className="btn btn--ghost btn--sm"
          data-testid={`${testid}-paste`}
          onClick={() => void pasteFromClipboard()}
          title="Paste TSV/CSV from the clipboard (replaces the grid; or focus a cell to paste from there)"
        >
          Paste data
        </button>
      </div>
      {monotonicViolation !== null && (
        <div
          className="banner banner--warn schedule-editor__alert"
          role="alert"
          data-testid={`${testid}-warning-monotonic`}
        >
          {leftLabel} values must be non-decreasing (row{" "}
          {monotonicViolation + 1} breaks the order) — use Sort.
        </div>
      )}
      {dupX && (
        <div
          className="banner banner--warn schedule-editor__alert"
          role="alert"
          data-testid={`${testid}-warning-duplicates`}
        >
          Duplicate {leftLabel.toLowerCase()} values — the solver holds the last
          value at a repeated {leftLabel.toLowerCase()}.
        </div>
      )}
      <Sparkline
        rows={rows}
        leftKind={leftKind}
        rightKind={rightKind}
        leftUnitId={leftUnitId}
        rightUnitId={rightUnitId}
        leftLabel={leftLabel}
        rightLabel={rightLabel}
        leftSymbol={leftSymbol}
        rightSymbol={rightSymbol}
        testid={`${testid}-sparkline`}
      />
      {pasteFallback && (
        <div className="schedule-editor__paste-fallback">
          <div className="field__hint" style={{ marginBottom: 4 }}>
            Clipboard access was blocked — click the box and press Ctrl/Cmd+V to
            paste.
          </div>
          <textarea
            data-testid={`${testid}-paste-fallback`}
            className="input"
            rows={4}
            autoFocus
            placeholder={"Paste TSV/CSV here, e.g.\n0\t100\n1\t85"}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text/plain");
              e.preventDefault();
              if (applyPasteText(text)) setPasteFallback(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPasteFallback(false);
            }}
            onBlur={() => setPasteFallback(false)}
            aria-label="Paste schedule data"
          />
        </div>
      )}
    </div>
  );
}

/** Compact curve preview with axis extent labels (display units). */
function Sparkline({
  rows,
  leftKind,
  rightKind,
  leftUnitId,
  rightUnitId,
  leftLabel,
  rightLabel,
  leftSymbol,
  rightSymbol,
  testid,
}: {
  rows: ScheduleRow[];
  leftKind: QuantityKind;
  rightKind: QuantityKind;
  leftUnitId: string;
  rightUnitId: string;
  leftLabel: string;
  rightLabel: string;
  leftSymbol: string;
  rightSymbol: string;
  testid: string;
}) {
  if (rows.length === 0) return null;
  const pts = rows.map(
    ([x, y]) =>
      [
        convertFromSI(leftKind, x, leftUnitId),
        convertFromSI(rightKind, y, rightUnitId),
      ] as [number, number],
  );
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const W = 220;
  const H = 64;
  const PAD = 6;
  const sx = (x: number) =>
    PAD + ((x - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD);
  const sy = (y: number) =>
    H - PAD - ((y - yMin) / (yMax - yMin || 1)) * (H - 2 * PAD);
  const points = pts
    .map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`)
    .join(" ");
  return (
    <div className="schedule-editor__sparkline" data-testid={testid}>
      <svg
        width={W}
        height={H}
        role="img"
        aria-label={`${rightLabel} vs ${leftLabel} preview`}
      >
        <rect x={0} y={0} width={W} height={H} fill="var(--bg-input)" rx={4} />
        {pts.length > 1 ? (
          <polyline
            points={points}
            fill="none"
            stroke="var(--info)"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ) : null}
        {pts.map(([x, y], i) => (
          <circle key={i} cx={sx(x)} cy={sy(y)} r={2.2} fill="var(--info)" />
        ))}
        <text x={PAD} y={H - 2} fontSize={8.5} fill="var(--text-3)">
          {formatSig(xMin, 3)}–{formatSig(xMax, 3)} {leftSymbol}
        </text>
        <text
          x={W - PAD}
          y={10}
          fontSize={8.5}
          fill="var(--text-3)"
          textAnchor="end"
        >
          {formatSig(yMin, 3)}–{formatSig(yMax, 3)} {rightSymbol}
        </text>
      </svg>
    </div>
  );
}
