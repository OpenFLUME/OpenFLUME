import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  niceTicks,
  clampDomain,
  seriesColor,
  assignSeriesColors,
  dedupeTicks,
} from "./chartMath";
import { useStore } from "../store";
import { QuantityKind } from "../units";
import { resolveScale, formatSig, ScaleChoice } from "../format";
import { provenanceCommentLines, provenanceFooter } from "../provenance";
import { safeFilename } from "../utils";
import type { NetworkConfig } from "../types";
import { csvRow } from "../csv";

export interface Series {
  id: string;
  label: string;
  values: number[];
  /** Optional override; defaults to a stable hash color from the series id. */
  color?: string;
  /** Dashed, lower-opacity rendering (baseline overlay series). */
  dashed?: boolean;
  opacity?: number;
  /** Lock this series' color to another series (baseline ↔ primary pairing). */
  matchColorOf?: string;
}

interface InteractiveChartProps {
  dataTestid: string;
  series: Series[];
  times: number[];
  xLabel: string;
  yLabel: string;
  yQuantityKind: QuantityKind;
  /**
   * Display/export unit label override for the y axis.  Used by rawUnit
   * channels (e.g. specific enthalpy in J/kg) whose values are never
   * unit-converted: without it the resolved QuantityKind label ('-' for
   * dimensionless) would mislabel raw SI values in the title, tooltip and
   * CSV export.  Values still pass through the resolved scale (identity for
   * dimensionless), so only the LABEL changes.
   */
  yUnitLabel?: string;
  xQuantityKind?: QuantityKind;
  height?: number;
  cursorTime?: number;
  /** Testid prefix for export buttons (e.g. "chart" → chart-export-png). */
  exportTestid?: string;
  /**
   * Optional cursor commit: called with the index (into `times`) of the
   * sample nearest to a plain click (mouse-up without a drag-zoom), and from
   * the ArrowLeft/ArrowRight/Home/End keys when the chart is focused.  When
   * provided, the SVG becomes focusable and exposes an arrow-key hint in its
   * accessible name; when omitted the chart is pointer-only exactly as
   * before.
   */
  onCursorCommit?: (index: number) => void;
  /**
   * Optional per-series "locate" action: when provided, each legend chip gets
   * a small locate button calling back with the series id (e.g. to reveal the
   * element on the network diagram).  Omitted ⇒ no locate buttons.
   */
  onSeriesLocate?: (id: string) => void;
  /**
   * Provenance source for PNG/SVG/CSV exports (title/footer/filename).
   * Defaults to the LIVE store config (historical behavior); viewers of
   * captured/historical runs pass their captured config snapshot so exports
   * carry the run's own name/settings/hash.
   */
  provenanceConfig?: NetworkConfig;
}

const MARGIN = { top: 16, right: 16, bottom: 40, left: 64 };

/* Literal colors inside the SVG so it serializes standalone for export.
   Values mirror the CSS tokens. */
const C = {
  text: "#b5b5b5", // --text-2
  textHi: "#e6e6e6", // --text-1
  grid: "#393939", // --line-1
  axis: "#515151", // --line-2
  bg: "#171717", // --bg-0
  cursor: "#c99a43", // --select
};

/** Light-theme swap map for report-paste PNG/SVG exports. */
const LIGHT_SWAP: Record<string, string> = {
  [C.text]: "#374151",
  [C.textHi]: "#111827",
  [C.grid]: "#d8dee7",
  [C.axis]: "#9aa5b1",
  [C.bg]: "#ffffff",
  [C.cursor]: "#b45309",
};

function swapLight(el: Element) {
  for (const attr of ["fill", "stroke"]) {
    const v = el.getAttribute(attr);
    if (v && LIGHT_SWAP[v]) el.setAttribute(attr, LIGHT_SWAP[v]);
  }
  for (const child of Array.from(el.children)) swapLight(child);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ExportLegendItem {
  label: string;
  color: string;
  dashed?: boolean;
}

/**
 * Compose a SELF-CONTAINED report chart: title with resolved axis units,
 * colored-swatch legend of the visible series, the plot itself, and a
 * provenance footer (model · ISO timestamp · mode · key settings · config
 * hash). The on-screen chart stays compact; only the export artifact gains
 * the report chrome.
 */
async function composeExportSvg(opts: {
  svg: SVGSVGElement;
  width: number;
  height: number;
  title: string;
  legend: ExportLegendItem[];
  light: boolean;
  config?: NetworkConfig;
}): Promise<{ xml: string; width: number; height: number }> {
  const { svg, width, height, title, legend, light } = opts;
  const config = opts.config ?? useStore.getState().config;
  const footer = await provenanceFooter(config);

  const headerH = 30;
  const rowH = 17;
  // Greedy row wrap for the legend (estimated text width).
  const legendRows: ExportLegendItem[][] = [];
  {
    let cur: ExportLegendItem[] = [];
    let curW = 0;
    for (const item of legend) {
      const itemW = 22 + item.label.length * 5.6 + 14;
      if (cur.length > 0 && curW + itemW > width - 20) {
        legendRows.push(cur);
        cur = [];
        curW = 0;
      }
      cur.push(item);
      curW += itemW;
    }
    if (cur.length) legendRows.push(cur);
  }
  const legendH = legendRows.length > 0 ? legendRows.length * rowH + 8 : 0;
  const footerH = 20;
  const totalH = headerH + height + legendH + footerH;

  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(totalH));
  root.setAttribute("viewBox", `0 0 ${width} ${totalH}`);
  root.setAttribute(
    "font-family",
    "Inter, ui-sans-serif, system-ui, sans-serif",
  );

  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(totalH));
  bg.setAttribute("fill", C.bg);
  root.appendChild(bg);

  const titleEl = document.createElementNS(SVG_NS, "text");
  titleEl.setAttribute("x", "10");
  titleEl.setAttribute("y", "20");
  titleEl.setAttribute("fill", C.textHi);
  titleEl.setAttribute("font-size", "13");
  titleEl.setAttribute("font-weight", "700");
  titleEl.textContent = title;
  root.appendChild(titleEl);

  const plot = document.createElementNS(SVG_NS, "g");
  plot.setAttribute("transform", `translate(0, ${headerH})`);
  for (const child of Array.from(svg.childNodes))
    plot.appendChild(child.cloneNode(true));
  root.appendChild(plot);

  legendRows.forEach((row, ri) => {
    let x = 10;
    const y = headerH + height + 6 + ri * rowH;
    for (const item of row) {
      if (item.dashed) {
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(x));
        line.setAttribute("y1", String(y + 5.5));
        line.setAttribute("x2", String(x + 14));
        line.setAttribute("y2", String(y + 5.5));
        line.setAttribute("stroke", item.color);
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-dasharray", "4 3");
        root.appendChild(line);
      } else {
        const sw = document.createElementNS(SVG_NS, "rect");
        sw.setAttribute("x", String(x));
        sw.setAttribute("y", String(y));
        sw.setAttribute("width", "11");
        sw.setAttribute("height", "11");
        sw.setAttribute("rx", "2");
        sw.setAttribute("fill", item.color);
        root.appendChild(sw);
      }
      const tx = document.createElementNS(SVG_NS, "text");
      tx.setAttribute("x", String(x + 17));
      tx.setAttribute("y", String(y + 9.5));
      tx.setAttribute("fill", C.text);
      tx.setAttribute("font-size", "10.5");
      tx.textContent = item.label;
      root.appendChild(tx);
      x += 22 + item.label.length * 5.6 + 14;
    }
  });

  const footerEl = document.createElementNS(SVG_NS, "text");
  footerEl.setAttribute("x", "10");
  footerEl.setAttribute("y", String(totalH - 6));
  footerEl.setAttribute("fill", C.text);
  footerEl.setAttribute("font-size", "9.5");
  footerEl.setAttribute("opacity", "0.85");
  footerEl.textContent = footer;
  root.appendChild(footerEl);

  if (light) swapLight(root);
  return {
    xml: new XMLSerializer().serializeToString(root),
    width,
    height: totalH,
  };
}

export default function InteractiveChart({
  dataTestid,
  series,
  times,
  xLabel,
  yLabel,
  yQuantityKind,
  yUnitLabel,
  xQuantityKind = "time",
  height = 300,
  cursorTime,
  exportTestid,
  onCursorCommit,
  onSeriesLocate,
  provenanceConfig,
}: InteractiveChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [zoomDomain, setZoomDomain] = useState<[number, number] | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [drag, setDrag] = useState<{ startX: number; currentX: number } | null>(
    null,
  );

  const yUnitId = useStore((s) => s.unitPreferences[yQuantityKind]);
  const xUnitId = useStore((s) => s.unitPreferences[xQuantityKind]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ONE display unit per axis, resolved over ALL series values (not just the
  // visible ones) so the axis stays stable while toggling series.
  const yScaleChoice: ScaleChoice = useMemo(
    () =>
      resolveScale(
        series.flatMap((s) => s.values),
        yQuantityKind,
        yUnitId,
      ),
    [series, yQuantityKind, yUnitId],
  );
  const xScaleChoice: ScaleChoice = useMemo(
    () => resolveScale(times, xQuantityKind, xUnitId),
    [times, xQuantityKind, xUnitId],
  );
  // Effective y unit label: the rawUnit override wins (raw SI values are
  // never converted, so the resolved kind label would mislabel them).
  const yUnitText = yUnitLabel ?? yScaleChoice.unitLabel;

  // Data converted once into the resolved display units.
  const dispTimes = useMemo(
    () => times.map((t) => xScaleChoice.convert(t)),
    [times, xScaleChoice],
  );
  // Colors: stable per id ACROSS charts (hash), hash collisions resolved
  // WITHIN this chart; baseline overlays share their primary's color.
  const coloredSeries = useMemo(() => {
    const colors = assignSeriesColors(series);
    return series.map((s) => ({
      ...s,
      color: colors.get(s.id) ?? s.color ?? seriesColor(s.id),
      disp: s.values.map((v) => yScaleChoice.convert(v)),
    }));
  }, [series, yScaleChoice]);

  const fullDomain: [number, number] = useMemo(() => {
    if (dispTimes.length === 0) return [0, 1];
    return [dispTimes[0], dispTimes[dispTimes.length - 1]];
  }, [dispTimes]);

  const xDomain = zoomDomain ?? fullDomain;

  const visibleSeries = useMemo(
    () => coloredSeries.filter((s) => !hidden.has(s.id)),
    [coloredSeries, hidden],
  );

  const yDomain = useMemo((): [number, number] => {
    if (visibleSeries.length === 0) return [0, 1];
    const [x0, x1] = xDomain;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const s of visibleSeries) {
      for (let i = 0; i < dispTimes.length; i++) {
        const t = dispTimes[i];
        if (t >= x0 && t <= x1) {
          const v = s.disp[i];
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
    }
    if (!isFinite(yMin) || !isFinite(yMax)) {
      for (const s of visibleSeries) {
        for (const v of s.disp) {
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
    }
    if (!isFinite(yMin) || !isFinite(yMax)) return [0, 1];
    // Degenerate domain — including SUB-ULP spans (300 vs 300.00000000000006)
    // where an exact `yMin === yMax` check is not enough: pad ±1% (±1 unit
    // near 0) so ticks and the y-scale can differ at all.
    const span = yMax - yMin;
    const ulpEps =
      Number.EPSILON * 8 * Math.max(1, Math.abs(yMin), Math.abs(yMax));
    if (!(span > ulpEps)) {
      const pad = Math.abs(yMin) * 0.01 || 1;
      return [yMin - pad, yMax + pad];
    }
    const pad = (yMax - yMin) * 0.05;
    return [yMin - pad, yMax + pad];
  }, [visibleSeries, dispTimes, xDomain]);

  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const xScale = useCallback(
    (t: number) => {
      const [x0, x1] = xDomain;
      const r = x1 - x0 || 1;
      return MARGIN.left + ((t - x0) / r) * innerWidth;
    },
    [xDomain, innerWidth],
  );

  const yScale = useCallback(
    (v: number) => {
      const [y0, y1] = yDomain;
      const r = y1 - y0 || 1;
      return MARGIN.top + (1 - (v - y0) / r) * innerHeight;
    },
    [yDomain, innerHeight],
  );

  // Tick labels deduplicated — near-degenerate domains escalate precision
  // rather than printing "293 / 293 / 293".
  const xTicks = useMemo(
    () => dedupeTicks(niceTicks(xDomain[0], xDomain[1], 5)),
    [xDomain],
  );
  const yTicks = useMemo(
    () => dedupeTicks(niceTicks(yDomain[0], yDomain[1], 5)),
    [yDomain],
  );

  const svgToDataX = useCallback(
    (clientX: number) => {
      const svg = containerRef.current?.querySelector("svg");
      if (!svg) return xDomain[0];
      const rect = svg.getBoundingClientRect();
      const ratio = (clientX - rect.left - MARGIN.left) / innerWidth;
      const [x0, x1] = xDomain;
      return x0 + ratio * (x1 - x0);
    },
    [xDomain, innerWidth],
  );

  /** Index (into times/dispTimes) of the sample nearest to a client x. */
  const nearestIdx = useCallback(
    (clientX: number) => {
      const dataX = svgToDataX(clientX);
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < dispTimes.length; i++) {
        const d = Math.abs(dispTimes[i] - dataX);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return bestIdx;
    },
    [dispTimes, svgToDataX],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      setMousePos({ x: e.clientX, y: e.clientY });
      setHoverIdx(nearestIdx(e.clientX));
      if (drag) {
        setDrag({ ...drag, currentX: e.clientX });
      }
    },
    [nearestIdx, drag],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    setDrag({ startX: e.clientX, currentX: e.clientX });
  }, []);

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!drag) return;
      const dx = Math.abs(e.clientX - drag.startX);
      if (dx > 5) {
        const x0 = svgToDataX(drag.startX);
        const x1 = svgToDataX(e.clientX);
        const newDomain = clampDomain(
          [Math.min(x0, x1), Math.max(x0, x1)],
          fullDomain[0],
          fullDomain[1],
        );
        setZoomDomain(newDomain);
      } else if (onCursorCommit && dispTimes.length > 0) {
        // Plain click (no drag-zoom): commit the nearest sample as cursor.
        onCursorCommit(nearestIdx(e.clientX));
      }
      setDrag(null);
    },
    [
      drag,
      svgToDataX,
      fullDomain,
      onCursorCommit,
      dispTimes.length,
      nearestIdx,
    ],
  );

  // Sample index the controlled cursor currently sits on (for keyboard steps).
  const cursorIdx = useMemo(() => {
    if (cursorTime == null || dispTimes.length === 0) return null;
    const target = xScaleChoice.convert(cursorTime);
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < dispTimes.length; i++) {
      const d = Math.abs(dispTimes[i] - target);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }, [cursorTime, dispTimes, xScaleChoice]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (!onCursorCommit || dispTimes.length === 0) return;
      const cur = cursorIdx ?? hoverIdx ?? dispTimes.length - 1;
      let next: number | null = null;
      if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
      else if (e.key === "ArrowRight")
        next = Math.min(dispTimes.length - 1, cur + 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = dispTimes.length - 1;
      if (next !== null) {
        e.preventDefault();
        onCursorCommit(next);
      }
    },
    [onCursorCommit, dispTimes.length, cursorIdx, hoverIdx],
  );

  const handleMouseLeave = useCallback(() => {
    setHoverIdx(null);
    setMousePos(null);
    setDrag(null);
  }, []);

  const handleDoubleClick = useCallback(() => {
    setZoomDomain(null);
  }, []);

  const resetZoom = useCallback(() => {
    setZoomDomain(null);
  }, []);

  const toggleSeries = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const polylines = useMemo(() => {
    return visibleSeries.map((s) => {
      const points = s.disp
        .map((v, i) => `${xScale(dispTimes[i])},${yScale(v)}`)
        .join(" ");
      return {
        id: s.id,
        points,
        color: s.color,
        dashed: s.dashed,
        opacity: s.opacity,
      };
    });
  }, [visibleSeries, dispTimes, xScale, yScale]);

  const selectionRect = useMemo(() => {
    if (!drag) return null;
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x0 = Math.min(drag.startX, drag.currentX) - rect.left;
    const x1 = Math.max(drag.startX, drag.currentX) - rect.left;
    const w = x1 - x0;
    if (w < 2) return null;
    return { x: x0, y: MARGIN.top, width: w, height: innerHeight };
  }, [drag, innerHeight]);

  const tooltipData = useMemo(() => {
    if (hoverIdx == null) return null;
    const t = dispTimes[hoverIdx];
    const items = visibleSeries.map((s) => ({
      id: s.id,
      label: s.label,
      color: s.color,
      value: s.disp[hoverIdx],
    }));
    return { t, items };
  }, [hoverIdx, dispTimes, visibleSeries]);

  const crosshairX = useMemo(() => {
    if (hoverIdx == null) return null;
    return xScale(dispTimes[hoverIdx]);
  }, [hoverIdx, dispTimes, xScale]);

  // ---- Exports ----------------------------------------------------------
  // Exported artifacts are SELF-CONTAINED: title with resolved units, legend
  // of visible series, and a provenance footer (model · timestamp · mode ·
  // settings · config hash). Filenames carry the sanitized model name.

  const svgEl = () => containerRef.current?.querySelector("svg") ?? null;

  const fileStem = () => {
    const name = (provenanceConfig ?? useStore.getState().config).meta.name;
    return `${safeFilename(name)}-${dataTestid}`;
  };

  const exportTitle = `${yLabel} (${yUnitText}) vs ${xLabel} (${xScaleChoice.unitLabel})`;

  const exportLegend = (): ExportLegendItem[] =>
    visibleSeries.map((s) => ({
      label: s.label,
      color: s.color,
      dashed: s.dashed,
    }));

  const exportSvg = async (light: boolean) => {
    const svg = svgEl();
    if (!svg) return;
    const { xml } = await composeExportSvg({
      svg,
      width,
      height,
      title: exportTitle,
      legend: exportLegend(),
      light,
      config: provenanceConfig,
    });
    downloadBlob(
      new Blob([xml], { type: "image/svg+xml" }),
      `${fileStem()}${light ? "-light" : ""}.svg`,
    );
  };

  const exportPng = async (light: boolean) => {
    const svg = svgEl();
    if (!svg) return;
    const {
      xml,
      width: w,
      height: h,
    } = await composeExportSvg({
      svg,
      width,
      height,
      title: exportTitle,
      legend: exportLegend(),
      light,
      config: provenanceConfig,
    });
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = w * 2;
      canvas.height = h * 2;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (blob)
          downloadBlob(blob, `${fileStem()}${light ? "-light" : ""}.png`);
      }, "image/png");
    };
    img.onerror = () => {
      console.error(
        "PNG export failed: the exported SVG could not be rasterized",
      );
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  };

  const exportCsv = async () => {
    const meta = await provenanceCommentLines(
      provenanceConfig ?? useStore.getState().config,
    );
    const header = [
      `${xLabel} (${xScaleChoice.unitLabel})`,
      ...visibleSeries.map((s) => `${s.label} (${yUnitText})`),
    ];
    const lines = [csvRow(header)];
    for (let i = 0; i < dispTimes.length; i++) {
      const row = [
        String(dispTimes[i]),
        ...visibleSeries.map((s) => String(s.disp[i])),
      ];
      lines.push(csvRow(row));
    }
    downloadBlob(
      new Blob([[...meta, ...lines].join("\n")], { type: "text/csv" }),
      `${fileStem()}.csv`,
    );
  };

  const exportPrefix = exportTestid ?? dataTestid;

  return (
    <div
      ref={containerRef}
      data-testid={dataTestid}
      data-domain={`${xDomain[0]},${xDomain[1]}`}
      style={{ width: "100%", position: "relative", userSelect: "none" }}
    >
      <div
        className="chart-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 4,
        }}
      >
        <span
          className="chart-title"
          style={{ fontSize: 12, fontWeight: 600, color: "var(--text-1)" }}
        >
          {yLabel} ({yUnitText}){" "}
          <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
            vs {xLabel} ({xScaleChoice.unitLabel})
          </span>
        </span>
        <span style={{ flex: 1 }} />
        {zoomDomain && (
          <button
            data-testid="chart-reset-zoom"
            className="btn btn--ghost btn--sm"
            onClick={resetZoom}
          >
            Reset zoom
          </button>
        )}
        <button
          data-testid={`${exportPrefix}-export-png`}
          className="btn btn--ghost btn--sm"
          onClick={() => void exportPng(false)}
          title="Download PNG (2x, dark, with legend + provenance)"
        >
          PNG
        </button>
        <button
          data-testid={`${exportPrefix}-export-png-light`}
          className="btn btn--ghost btn--sm"
          onClick={() => void exportPng(true)}
          title="Download PNG (2x, light — for reports)"
        >
          PNG◐
        </button>
        <button
          data-testid={`${exportPrefix}-export-svg`}
          className="btn btn--ghost btn--sm"
          onClick={() => void exportSvg(false)}
          title="Download SVG (with legend + provenance)"
        >
          SVG
        </button>
        <button
          data-testid={`${exportPrefix}-export-csv`}
          className="btn btn--ghost btn--sm"
          onClick={() => void exportCsv()}
          title="Download CSV (visible series, display units, provenance header)"
        >
          CSV
        </button>
      </div>
      <svg
        width={width}
        height={height}
        style={{ display: "block", pointerEvents: "all" }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={handleDoubleClick}
        {...(onCursorCommit
          ? {
              tabIndex: 0,
              onKeyDown: handleKeyDown,
              "aria-label": `${yLabel} versus ${xLabel} chart. Click or use the arrow keys to move the time cursor.`,
            }
          : {})}
      >
        <g shapeRendering="crispEdges" opacity={0.5}>
          {xTicks.map((t, i) => {
            const x = xScale(t.value);
            return (
              <line
                key={`xg-${i}`}
                x1={x}
                y1={MARGIN.top}
                x2={x}
                y2={height - MARGIN.bottom}
                stroke={C.grid}
                strokeWidth={1}
              />
            );
          })}
          {yTicks.map((t, i) => {
            const y = yScale(t.value);
            return (
              <line
                key={`yg-${i}`}
                x1={MARGIN.left}
                y1={y}
                x2={width - MARGIN.right}
                y2={y}
                stroke={C.grid}
                strokeWidth={1}
              />
            );
          })}
        </g>
        <line
          x1={MARGIN.left}
          y1={height - MARGIN.bottom}
          x2={width - MARGIN.right}
          y2={height - MARGIN.bottom}
          stroke={C.axis}
          strokeWidth={1}
        />
        <line
          x1={MARGIN.left}
          y1={MARGIN.top}
          x2={MARGIN.left}
          y2={height - MARGIN.bottom}
          stroke={C.axis}
          strokeWidth={1}
        />
        {xTicks.map((t, i) => (
          <text
            key={`xt-${i}`}
            x={xScale(t.value)}
            y={height - MARGIN.bottom + 16}
            fill={C.text}
            fontSize={11}
            textAnchor="middle"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {t.label}
          </text>
        ))}
        {yTicks.map((t, i) => (
          <text
            key={`yt-${i}`}
            x={MARGIN.left - 8}
            y={yScale(t.value) + 4}
            fill={C.text}
            fontSize={11}
            textAnchor="end"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {t.label}
          </text>
        ))}
        <text
          x={MARGIN.left + innerWidth / 2}
          y={height - 6}
          fill={C.text}
          fontSize={11}
          textAnchor="middle"
        >
          {xLabel} ({xScaleChoice.unitLabel})
        </text>
        {polylines.map((p) => (
          <polyline
            key={p.id}
            fill="none"
            stroke={p.color}
            strokeWidth={p.dashed ? 1.5 : 1.75}
            strokeDasharray={p.dashed ? "6 4" : undefined}
            opacity={p.opacity ?? 1}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={p.points}
          />
        ))}
        {crosshairX != null && (
          <line
            x1={crosshairX}
            y1={MARGIN.top}
            x2={crosshairX}
            y2={height - MARGIN.bottom}
            stroke={C.textHi}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}
        {cursorTime != null && (
          <line
            x1={xScale(xScaleChoice.convert(cursorTime))}
            y1={MARGIN.top}
            x2={xScale(xScaleChoice.convert(cursorTime))}
            y2={height - MARGIN.bottom}
            stroke={C.cursor}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}
        {selectionRect && (
          <rect
            x={selectionRect.x}
            y={selectionRect.y}
            width={selectionRect.width}
            height={selectionRect.height}
            fill="rgba(255,255,255,0.1)"
            stroke={C.textHi}
            strokeWidth={1}
          />
        )}
      </svg>

      {tooltipData && mousePos && (
        <div
          data-testid="chart-tooltip"
          className="chart-tooltip"
          style={{
            position: "fixed",
            left:
              mousePos.x > window.innerWidth - 280
                ? undefined
                : mousePos.x + 12,
            right:
              mousePos.x > window.innerWidth - 280
                ? window.innerWidth - mousePos.x + 12
                : undefined,
            top: mousePos.y - 12,
            pointerEvents: "none",
            zIndex: 100,
            minWidth: 140,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            t = {formatSig(tooltipData.t, 4)} {xScaleChoice.unitLabel}
          </div>
          {tooltipData.items.map((item) => (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 2,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: item.color,
                  display: "inline-block",
                }}
              />
              <span style={{ flex: 1 }}>{item.label}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatSig(item.value, 4)} {yUnitText}
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px 12px",
          marginTop: 6,
          alignItems: "center",
        }}
      >
        {series.length > 8 && (
          <>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setHidden(new Set())}
              aria-label="Show all series"
            >
              all
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setHidden(new Set(series.map((s) => s.id)))}
              aria-label="Hide all series"
            >
              none
            </button>
          </>
        )}
        {coloredSeries.map((s) => {
          const isHidden = hidden.has(s.id);
          return (
            <span
              key={s.id}
              style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
            >
              <button
                data-testid={`chart-legend-item-${s.id}`}
                onClick={() => toggleSeries(s.id)}
                aria-pressed={!isHidden}
                className="chart-legend-chip"
              >
                {s.dashed ? (
                  <svg
                    width="12"
                    height="10"
                    aria-hidden="true"
                    style={{ opacity: isHidden ? 0.3 : 1 }}
                  >
                    <line
                      x1="1"
                      y1="5"
                      x2="11"
                      y2="5"
                      stroke={s.color}
                      strokeWidth="2"
                      strokeDasharray="3 2.5"
                    />
                  </svg>
                ) : (
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: s.color,
                      opacity: isHidden ? 0.3 : 1,
                      display: "inline-block",
                    }}
                  />
                )}
                <span
                  style={{ textDecoration: isHidden ? "line-through" : "none" }}
                >
                  {s.label}
                </span>
              </button>
              {onSeriesLocate && (
                <button
                  data-testid={`chart-legend-locate-${s.id}`}
                  className="btn btn--ghost btn--sm"
                  style={{ padding: "0 4px", lineHeight: 1 }}
                  onClick={() => onSeriesLocate(s.id)}
                  aria-label={`Locate ${s.label} on the diagram`}
                  title={`Locate ${s.label} on the diagram`}
                >
                  ⌖
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
