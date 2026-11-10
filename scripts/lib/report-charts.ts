/**
 * SVG chart renderer shared by the experimental-validation report scripts
 * (chilldown, choked flow, cavitating venturi).  It is the renderer of
 * scripts/microfluidics-validation-report.ts (itself copied from
 * scripts/hydraulics-validation-report.ts) with optional fixed axis ranges
 * added, so parity plots can share x and y scales.
 */

export type MarkerShape = "circle" | "square" | "triangle" | "diamond";

export interface Series {
  label: string;
  pts: Array<[number, number]>;
  color: string;
  mode: "line" | "markers" | "both";
  marker?: MarkerShape;
  dash?: string;
}

function niceStep(range: number, targetTicks: number): number {
  const raw = range / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

function fmtTick(v: number, step: number): string {
  const decimals = Math.max(
    0,
    -Math.floor(Math.log10(step)) + (step < 1 ? 0 : 0),
  );
  return v.toFixed(Math.min(6, decimals));
}

function markerSvg(
  shape: MarkerShape,
  cx: number,
  cy: number,
  r: number,
  color: string,
): string {
  switch (shape) {
    case "circle":
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
    case "square":
      return `<rect x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
    case "triangle":
      return `<polygon points="${cx},${cy - r} ${cx - r},${cy + r} ${cx + r},${cy + r}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
    case "diamond":
      return `<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
  }
}

export function lineChart(opts: {
  title: string;
  xLabel: string;
  yLabel: string;
  series: Series[];
  yPad?: number;
  /** Fixed axis ranges (otherwise fitted to the data). */
  xRange?: [number, number];
  yRange?: [number, number];
  /** Default top-right; move when that corner sits on the data. */
  legend?:
    | "top-right"
    | "top-left"
    | "bottom-left"
    | "bottom-right"
    | "center-left"
    | "center-right"
    /** To the right of the plot; the canvas widens to fit. */
    | "outside-right";
}): string {
  const legendSeries = opts.series.filter((s) => s.label !== "");
  const legendW = Math.ceil(
    Math.max(...legendSeries.map((s) => s.label.length)) * 6.4 + 44,
  );
  const outside = opts.legend === "outside-right";
  const W = 680 + (outside ? legendW + 12 : 0);
  const H = 430;
  const m = { l: 76, r: 24 + (outside ? legendW + 12 : 0), t: 46, b: 58 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;

  // Non-finite points (a failed or unavailable value) are gaps: they are
  // left out of the axis ranges and break the line instead of poisoning
  // every coordinate with NaN.
  const finite = ([x, y]: [number, number]) =>
    Number.isFinite(x) && Number.isFinite(y);
  const allPts = opts.series.flatMap((s) => s.pts).filter(finite);
  const xMin = opts.xRange?.[0] ?? Math.min(...allPts.map((p) => p[0]));
  let xMax = opts.xRange?.[1] ?? Math.max(...allPts.map((p) => p[0]));
  let yMin = Math.min(...allPts.map((p) => p[1]));
  let yMax = Math.max(...allPts.map((p) => p[1]));
  if (opts.yRange) {
    [yMin, yMax] = opts.yRange;
  } else {
    const yPad = (opts.yPad ?? 0.06) * (yMax - yMin || 1);
    yMin -= yPad;
    yMax += yPad;
  }
  if (xMax === xMin) xMax = xMin + 1;

  const sx = (x: number) => m.l + ((x - xMin) / (xMax - xMin)) * pw;
  const sy = (y: number) => m.t + ph - ((y - yMin) / (yMax - yMin)) * ph;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="white"/>`,
    `<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">${opts.title}</text>`,
  );

  // Gridlines and ticks
  const xStep = niceStep(xMax - xMin, 6);
  const yStep = niceStep(yMax - yMin, 6);
  for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax + 1e-9; v += xStep) {
    const x = sx(v);
    parts.push(
      `<line x1="${x}" y1="${m.t}" x2="${x}" y2="${m.t + ph}" stroke="#e0e0e0" stroke-width="1"/>`,
      `<text x="${x}" y="${m.t + ph + 18}" text-anchor="middle" font-size="11">${fmtTick(v, xStep)}</text>`,
    );
  }
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
    const y = sy(v);
    parts.push(
      `<line x1="${m.l}" y1="${y}" x2="${m.l + pw}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`,
      `<text x="${m.l - 8}" y="${y + 4}" text-anchor="end" font-size="11">${fmtTick(v, yStep)}</text>`,
    );
  }
  parts.push(
    `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="#333" stroke-width="1.2"/>`,
    `<text x="${m.l + pw / 2}" y="${H - 14}" text-anchor="middle" font-size="12.5">${opts.xLabel}</text>`,
    `<text x="20" y="${m.t + ph / 2}" text-anchor="middle" font-size="12.5" transform="rotate(-90 20 ${m.t + ph / 2})">${opts.yLabel}</text>`,
  );

  // Series
  for (const s of opts.series) {
    if (s.mode !== "markers") {
      const path = s.pts
        .map((p, i) =>
          finite(p)
            ? `${i === 0 || !finite(s.pts[i - 1]) ? "M" : "L"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`
            : "",
        )
        .filter((c) => c !== "")
        .join(" ");
      if (path !== "")
        parts.push(
          `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="1.8"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`,
        );
    }
    if (s.mode !== "line") {
      for (const [x, y] of s.pts.filter(finite)) {
        parts.push(markerSvg(s.marker ?? "circle", sx(x), sy(y), 3.4, s.color));
      }
    }
  }

  // Legend (series with an empty label are drawn but not listed)
  const legendH = legendSeries.length * 18 + 10;
  const pad = 8;
  const pos = opts.legend ?? "top-right";
  const lx = outside
    ? m.l + pw + 12
    : pos.endsWith("left")
      ? m.l + pad
      : m.l + pw - legendW - pad;
  const ly =
    outside || pos.startsWith("top")
      ? m.t + pad
      : pos.startsWith("center")
        ? m.t + (ph - legendH) / 2
        : m.t + ph - legendH - pad;
  parts.push(
    `<rect x="${lx}" y="${ly}" width="${legendW}" height="${legendH}" fill="white" fill-opacity="0.88" stroke="#999" stroke-width="0.8"/>`,
  );
  legendSeries.forEach((s, i) => {
    const yy = ly + 14 + i * 18;
    if (s.mode !== "markers") {
      parts.push(
        `<line x1="${lx + 8}" y1="${yy - 4}" x2="${lx + 30}" y2="${yy - 4}" stroke="${s.color}" stroke-width="1.8"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`,
      );
    }
    if (s.mode !== "line") {
      parts.push(
        markerSvg(s.marker ?? "circle", lx + 19, yy - 4, 3.4, s.color),
      );
    }
    parts.push(
      `<text x="${lx + 36}" y="${yy}" font-size="11">${s.label}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}

/* Grouped bar chart (analytic vs numerical per category) */

export function groupedBarChart(opts: {
  title: string;
  xLabel: string;
  yLabel: string;
  categories: string[];
  series: Array<{ label: string; values: number[]; color: string }>;
  /** y-axis top as a multiple of the largest bar (room for the legend). */
  headroom?: number;
}): string {
  const W = 680;
  const H = 430;
  const m = { l: 76, r: 24, t: 46, b: 58 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const yMax =
    Math.max(...opts.series.flatMap((s) => s.values)) * (opts.headroom ?? 1.12);
  const sy = (y: number) => m.t + ph - (y / yMax) * ph;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="white"/>`,
    `<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">${opts.title}</text>`,
  );

  const yStep = niceStep(yMax, 6);
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    const y = sy(v);
    parts.push(
      `<line x1="${m.l}" y1="${y}" x2="${m.l + pw}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`,
      `<text x="${m.l - 8}" y="${y + 4}" text-anchor="end" font-size="11">${fmtTick(v, yStep)}</text>`,
    );
  }

  const nCat = opts.categories.length;
  const nSer = opts.series.length;
  const slot = pw / nCat;
  const barW = (slot * 0.62) / nSer;
  opts.categories.forEach((cat, ci) => {
    const cx = m.l + slot * (ci + 0.5);
    parts.push(
      `<text x="${cx}" y="${m.t + ph + 18}" text-anchor="middle" font-size="11">${cat}</text>`,
    );
    opts.series.forEach((s, si) => {
      const x = cx - (nSer * barW) / 2 + si * barW;
      const y = sy(s.values[ci]);
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${(m.t + ph - y).toFixed(1)}" fill="${s.color}" fill-opacity="${si === 0 ? 0.45 : 0.85}" stroke="${s.color}" stroke-width="1"/>`,
      );
    });
  });

  parts.push(
    `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="#333" stroke-width="1.2"/>`,
    `<text x="${m.l + pw / 2}" y="${H - 14}" text-anchor="middle" font-size="12.5">${opts.xLabel}</text>`,
    `<text x="20" y="${m.t + ph / 2}" text-anchor="middle" font-size="12.5" transform="rotate(-90 20 ${m.t + ph / 2})">${opts.yLabel}</text>`,
  );

  // Legend — swatches vertically centered on their text lines.
  const legendW =
    Math.max(...opts.series.map((s) => s.label.length)) * 6.4 + 44;
  const legendH = opts.series.length * 18 + 8;
  const lx = m.l + 8; // top-left: the bars here grow left to right
  const ly = m.t + 8;
  parts.push(
    `<rect x="${lx}" y="${ly}" width="${legendW}" height="${legendH}" fill="white" fill-opacity="0.88" stroke="#999" stroke-width="0.8"/>`,
  );
  opts.series.forEach((s, i) => {
    const yy = ly + 16 + i * 18; // text baseline; 11px text centers ≈ yy − 4
    parts.push(
      `<rect x="${lx + 8}" y="${yy - 9}" width="22" height="10" fill="${s.color}" fill-opacity="${i === 0 ? 0.45 : 0.85}" stroke="${s.color}" stroke-width="1"/>`,
      `<text x="${lx + 36}" y="${yy}" font-size="11">${s.label}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}

export const C = {
  ref: "#000000",
  blue: "#1f5fa8",
  red: "#c0392b",
  green: "#1e8449",
  orange: "#d68910",
  grey: "#7f8c8d",
};
