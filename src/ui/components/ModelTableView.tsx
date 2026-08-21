/**
 * ModelTableView — the model-audit surface (QA/review + bulk navigation).
 *
 * Four sortable/filterable tables (nodes, branches, solid nodes, conductors)
 * with units resolved from user preferences, commit-on-blur inline editing
 * of the safe common fields (label, node P/T/volume, solid T/mass), row
 * click/Enter to select + pan the canvas, per-table CSV export with
 * provenance headers, and a counts/validation summary bar.
 *
 * Polymorphic branch/conductor parameters are intentionally edited in the
 * PropertyPanel ("Open in properties") — this view stays a review surface,
 * not a second property editor.
 */
import React, { useMemo, useState } from "react";
import { useStore } from "../store";
import { NetworkConfig, Selection } from "../types";
import { isParameterExpression } from "../../core";
import {
  QuantityKind,
  UnitId,
  getUnitDef,
  convertFromSI,
  convertToSI,
  formatNumber,
} from "../units";
import { formatSig, formatWithUnit, resolveScale, siNumber } from "../format";
import { componentLabel, conductorLabel } from "../componentRegistry";
import { specSummaryShort } from "../solidPropertyUi";
import { provenanceCommentLines } from "../provenance";
import { safeFilename } from "../utils";
import { csvRow } from "../csv";

type Config = NetworkConfig;
type NodeConfig = Config["nodes"][number];
type BranchConfig = Config["branches"][number];
type SolidNodeConfig = NonNullable<Config["solidNodes"]>[number];
type ConductorConfig = NonNullable<Config["conductors"]>[number];
type NoteConfig = NonNullable<Config["notes"]>[number];

/* ------------------------------------------------------------------ */
/* Cell editors (bare, commit-on-blur/Enter, Escape reverts)           */
/* ------------------------------------------------------------------ */

function CellTextInput({
  value,
  onCommit,
  testid,
  ariaLabel,
}: {
  value: string;
  onCommit: (v: string) => void;
  testid?: string;
  ariaLabel: string;
}) {
  const [raw, setRaw] = React.useState(value);
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setRaw(value);
  }, [value, focused]);
  const commit = () => {
    setFocused(false);
    if (raw !== value) onCommit(raw);
  };
  return (
    <input
      data-testid={testid}
      className="input mt-cell-input"
      type="text"
      value={focused ? raw : value}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => {
        setRaw(value);
        setFocused(true);
      }}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setRaw(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function CellUnitInput({
  kind,
  value,
  onCommit,
  testid,
  ariaLabel,
  unitId: unitIdOverride,
}: {
  kind: QuantityKind;
  value: number | undefined;
  onCommit: (v: number | undefined) => void;
  testid?: string;
  ariaLabel: string;
  /** Column-resolved display unit (auto-scaled base prefs); defaults to pref. */
  unitId?: UnitId;
}) {
  const prefUnitId = useStore((s) => s.unitPreferences[kind]);
  const unitId = unitIdOverride ?? prefUnitId;
  const [raw, setRaw] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  const display =
    value === undefined || !isFinite(value)
      ? ""
      : formatNumber(convertFromSI(kind, value, unitId));
  React.useEffect(() => {
    if (!focused) setRaw(display);
  }, [display, focused]);
  const commit = () => {
    setFocused(false);
    const r = raw.trim();
    if (r === "" || r === "-") {
      onCommit(undefined);
      return;
    }
    const parsed = parseFloat(r);
    if (!Number.isNaN(parsed)) onCommit(convertToSI(kind, parsed, unitId));
  };
  return (
    <input
      data-testid={testid}
      className="input mt-cell-input mt-cell-input--num"
      type="text"
      inputMode="decimal"
      value={focused ? raw : display}
      placeholder="—"
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => {
        setRaw(display);
        setFocused(true);
      }}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setRaw(display);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Generic sortable model table                                        */
/* ------------------------------------------------------------------ */

interface MTColumn<Row> {
  key: string;
  header: string;
  numeric?: (row: Row) => number | undefined;
  render: (row: Row) => React.ReactNode;
  csv?: (row: Row) => string;
  /** Raw text used for search filtering. */
  filterText?: (row: Row) => string;
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ModelTable<Row extends { id: string }>({
  testid,
  ariaLabel,
  columns,
  rows,
  csvName,
  onOpen,
  rowTestid,
}: {
  testid: string;
  ariaLabel: string;
  columns: MTColumn<Row>[];
  rows: Row[];
  csvName: string;
  onOpen: (id: string) => void;
  rowTestid: (row: Row) => string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const config = useStore((s) => s.config);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const arr = [...rows];
    arr.sort((a, b) => {
      if (col.numeric) {
        const av = col.numeric(a);
        const bv = col.numeric(b);
        if (av === undefined && bv === undefined) return 0;
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        return (av - bv) * sort.dir;
      }
      const at = col.filterText
        ? col.filterText(a)
        : String(col.csv ? col.csv(a) : "");
      const bt = col.filterText
        ? col.filterText(b)
        : String(col.csv ? col.csv(b) : "");
      return at.localeCompare(bt) * sort.dir;
    });
    return arr;
  }, [rows, sort, columns]);

  const exportCsv = async () => {
    const meta = await provenanceCommentLines(config);
    const header = csvRow(columns.map((c) => c.header));
    const lines = sorted.map((r) =>
      csvRow(
        columns.map((c) =>
          c.csv ? c.csv(r) : c.filterText ? c.filterText(r) : "",
        ),
      ),
    );
    downloadText(
      [...meta, header, ...lines].join("\n"),
      `${safeFilename(config.meta.name)}-${csvName}.csv`,
    );
  };

  return (
    <div className="results-table-wrap">
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 4,
          padding: "4px 6px",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <button
          data-testid={`${testid}-csv`}
          className="btn btn--ghost btn--sm"
          onClick={() => void exportCsv()}
          title="Download table as CSV with provenance header (displayed units)"
        >
          Download CSV
        </button>
      </div>
      <table
        data-testid={testid}
        className="table mt-table"
        aria-label={ariaLabel}
        style={{ fontSize: 11 }}
      >
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  aria-sort={
                    active
                      ? sort!.dir === 1
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() =>
                    setSort((prev) =>
                      prev?.key === c.key
                        ? { key: c.key, dir: (prev.dir * -1) as 1 | -1 }
                        : { key: c.key, dir: 1 },
                    )
                  }
                >
                  {c.header} {active ? (sort!.dir === 1 ? "▲" : "▼") : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.id}
              data-testid={rowTestid(r)}
              tabIndex={0}
              style={{ cursor: "pointer" }}
              onClick={() => onOpen(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) {
                  e.preventDefault();
                  onOpen(r.id);
                }
              }}
            >
              {columns.map((c) => (
                <td key={c.key}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  color: "var(--text-3)",
                  textAlign: "center",
                  padding: 12,
                }}
              >
                No rows match the filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Parameter summaries                                                 */
/* ------------------------------------------------------------------ */

/**
 * Format a possibly formula-bound (NumberOrExpression) field in a summary
 * string: literal numbers format with their unit; formula objects show a
 * compact `ƒ<expr>` marker (the PropertyPanel's formula editor is the
 * editing surface; the table stays an audit view).
 */
function fmtBindable(
  value: number | { expr: string } | undefined,
  kind: QuantityKind,
  prefs: import("../units").UnitPreferences,
  sigFigs = 3,
): string {
  const n = siNumber(value);
  if (n !== undefined) return formatWithUnit(n, kind, prefs, sigFigs);
  if (
    value !== undefined &&
    typeof value === "object" &&
    value !== null &&
    "expr" in value
  ) {
    const expr = value.expr;
    return `ƒ${expr.length > 24 ? `${expr.slice(0, 24)}…` : expr}`;
  }
  return "—";
}

function branchSummary(
  b: BranchConfig,
  prefs: import("../units").UnitPreferences,
): string {
  const c = b.component;
  switch (c.type) {
    case "pipe":
      return `L ${fmtBindable(c.length, "length", prefs)} · D ${fmtBindable(c.diameter, "length", prefs)}`;
    case "heatedPipe": {
      const ua = siNumber(c.ua);
      const uaText =
        ua !== undefined
          ? formatSig(ua, 3)
          : c.ua !== undefined && typeof c.ua === "object" && "expr" in c.ua
            ? `ƒ${c.ua.expr}`
            : "—";
      return `L ${fmtBindable(c.length, "length", prefs)} · UA ${uaText} W/K`;
    }
    case "orifice":
    case "orificeCompressible":
      return `A ${fmtBindable(c.area, "area", prefs)} · Cd ${formatSig(c.cd, 2)}`;
    case "cavitatingVenturi":
      return `A_th ${fmtBindable(c.throatArea, "area", prefs)} · Cd ${formatSig(c.cd, 2)}`;
    case "valve":
    case "checkValve":
      return `A ${fmtBindable(c.area, "area", prefs)}${c.type === "valve" ? ` · pos ${formatSig(c.position, 2)}` : ""}`;
    case "dynamicCheckValve":
      return `A ${fmtBindable(c.area, "area", prefs)} · k ${formatSig(c.springRate, 3)} N/m · m ${formatSig(c.mass, 3)} kg`;
    case "reliefValve":
      return `crack ${formatWithUnit(c.crackPressure, "pressure", prefs, 3)}`;
    case "resistance":
      return `K ${formatSig(c.k, 3)} · A ${fmtBindable(c.area, "area", prefs)}`;
    case "pump":
      return `${c.curve.length}-pt curve`;
    case "bend":
      return `D ${fmtBindable(c.diameter, "length", prefs)} · ${formatSig(c.angle, 3)}°`;
    case "areaChange":
      return `${fmtBindable(c.areaIn, "area", prefs)} → ${fmtBindable(c.areaOut, "area", prefs)}`;
    case "flowSource":
      return `ṁ ${formatWithUnit(c.massFlow, "massFlow", prefs, 3)}`;
    case "regulator":
      return `P_set ${formatWithUnit(c.setPressure, "pressure", prefs, 3)}`;
    default:
      return "";
  }
}

function conductorSummary(
  c: ConductorConfig,
  prefs: import("../units").UnitPreferences,
): string {
  const t = c.type;
  switch (t.kind) {
    case "conduction":
      return `k ${specSummaryShort(t.k)} · A ${fmtBindable(t.area, "area", prefs)} · L ${fmtBindable(t.length, "length", prefs)}`;
    case "convection": {
      const area = fmtBindable(t.area, "area", prefs);
      // Specified h is a constant, a static binding, or — as the custom
      // model — an equation the solver evaluates (ui/convectionModelUi.ts).
      const h = t.h as number | { expr: string } | undefined;
      const hText =
        typeof h === "number"
          ? formatSig(h, 3) // legacy constant-h summary, byte-identical
          : isParameterExpression(h)
            ? fmtBindable(h, "heatTransferCoeff", prefs)
            : undefined;
      if (t.correlation === undefined) {
        return `h ${hText ?? "corr."} · A ${area}`;
      }
      const m = t.correlation.model;
      if (m === "custom") {
        const expr =
          typeof t.correlation.expression === "string"
            ? t.correlation.expression
            : "";
        const floor = hText !== undefined ? ` · h floor ${hText}` : "";
        return `h ${fmtBindable({ expr }, "heatTransferCoeff", prefs)}${floor} · A ${area}`;
      }
      const name =
        m === "dittusBoelter"
          ? "Dittus–Boelter"
          : m === "miropolskii"
            ? "Miropolskii"
            : m === "darrHartwig"
              ? "Darr–Hartwig"
              : "TT-WF";
      return `${name} · h floor ${hText ?? "5"} · A ${area}`;
    }
    case "radiation":
      return `ε ${formatSig(t.emissivity, 2)} · A ${fmtBindable(t.area, "area", prefs)} · F ${formatSig(t.viewFactor, 2)}`;
    default:
      return "";
  }
}

function cpSummary(cp: SolidNodeConfig["cp"]): string {
  return specSummaryShort(cp);
}

/* ------------------------------------------------------------------ */
/* Main view                                                           */
/* ------------------------------------------------------------------ */

export default function ModelTableView({
  onNavigateToModel,
}: { onNavigateToModel?: () => void } = {}) {
  const config = useStore((s) => s.config);
  const validationErrors = useStore((s) => s.validationErrors);
  const updateNode = useStore((s) => s.updateNode);
  const updateBranch = useStore((s) => s.updateBranch);
  const updateSolidNode = useStore((s) => s.updateSolidNode);
  const updateConductor = useStore((s) => s.updateConductor);
  const updateNote = useStore((s) => s.updateNote);
  const setSelection = useStore((s) => s.setSelection);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const openGroupTab = useStore((s) => s.openGroupTab);
  const requestCanvasFocus = useStore((s) => s.requestCanvasFocus);
  const unitPrefs = useStore((s) => s.unitPreferences);

  const [query, setQuery] = useState("");

  const groupLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of config.groups ?? []) m.set(g.id, g.label || g.id);
    return m;
  }, [config.groups]);

  /** Select the element, switch to the canvas (its group tab if grouped), pan to it. */
  const openInModel = (kind: Selection["kind"], id: string) => {
    setSelection({ kind, id } as Selection);
    if (kind === "node" || kind === "solidNode" || kind === "note") {
      const n =
        kind === "note"
          ? (config.notes ?? []).find((x) => x.id === id)
          : (config.nodes.find((x) => x.id === id) ??
            (config.solidNodes ?? []).find((x) => x.id === id));
      if (n?.group) {
        openGroupTab(n.group);
      } else {
        setActiveTab("editor");
      }
    } else {
      setActiveTab("editor");
    }
    requestCanvasFocus(kind, id);
    onNavigateToModel?.();
  };

  // ── Counts / audit summary ──────────────────────────────────────────
  const counts = useMemo(() => {
    const boundaries = config.nodes.filter((n) => n.type === "boundary").length;
    const internal = config.nodes.length - boundaries;
    const solids = config.solidNodes?.length ?? 0;
    const conductors = config.conductors?.length ?? 0;
    const connected = new Set<string>();
    for (const b of config.branches) {
      connected.add(b.from);
      connected.add(b.to);
    }
    for (const c of config.conductors ?? []) {
      connected.add(c.from);
      connected.add(c.to);
    }
    const disconnected =
      config.nodes.filter((n) => !connected.has(n.id)).length +
      (config.solidNodes ?? []).filter((n) => !connected.has(n.id)).length;
    return {
      boundaries,
      internal,
      branches: config.branches.length,
      solids,
      conductors,
      groups: config.groups?.length ?? 0,
      disconnected,
    };
  }, [config]);

  const q = query.trim().toLowerCase();
  const match = (...parts: Array<string | undefined>) =>
    !q || parts.some((p) => (p ?? "").toLowerCase().includes(q));

  // ── Nodes table ─────────────────────────────────────────────────────
  const nodeRows = config.nodes.filter((n) =>
    match(n.id, n.label, n.type, n.group && groupLabel.get(n.group)),
  );
  const solidRowsAll = config.solidNodes ?? [];

  // ONE display unit per numeric column (same philosophy as result tables):
  // a base-SI preference auto-scales (300 kPa, never a raw "300000" Pa cell);
  // an explicit non-base preference is honored verbatim.
  const pUnitId = resolveScale(
    nodeRows.flatMap((n) => {
      const v = siNumber(n.pressure);
      return v !== undefined ? [v] : [];
    }),
    "pressure",
    unitPrefs.pressure,
  ).unitId;
  const tUnitId = resolveScale(
    [
      ...nodeRows.flatMap((n) => {
        const v = siNumber(n.temperature);
        return v !== undefined ? [v] : [];
      }),
      ...solidRowsAll.flatMap((n) => {
        const v = siNumber(n.temperature);
        return v !== undefined ? [v] : [];
      }),
    ],
    "temperature",
    unitPrefs.temperature,
  ).unitId;
  const vUnitId = resolveScale(
    nodeRows.flatMap((n) => {
      const v = siNumber(n.volume);
      return v !== undefined ? [v] : [];
    }),
    "volume",
    unitPrefs.volume,
  ).unitId;
  const pUnit = getUnitDef("pressure", pUnitId).symbol;
  const tUnit = getUnitDef("temperature", tUnitId).symbol;
  const vUnit = getUnitDef("volume", vUnitId).symbol;
  const nodeColumns: MTColumn<NodeConfig>[] = [
    {
      key: "name",
      header: "Name",
      filterText: (n) => n.label ?? "",
      render: (n) => (
        <CellTextInput
          value={n.label ?? ""}
          onCommit={(v) => updateNode(n.id, { label: v })}
          testid={`mt-name-${n.id}`}
          ariaLabel={`Label for ${n.id}`}
        />
      ),
      csv: (n) => n.label ?? "",
    },
    {
      key: "id",
      header: "ID",
      filterText: (n) => n.id,
      render: (n) => n.id,
      csv: (n) => n.id,
    },
    {
      key: "type",
      header: "Type",
      filterText: (n) => n.type,
      render: (n) => (
        <span
          className={`pill ${n.type === "boundary" ? "pill--info" : "pill--muted"}`}
          style={{ padding: "1px 7px" }}
        >
          {n.type}
        </span>
      ),
      csv: (n) => n.type,
    },
    {
      key: "p",
      header: `Pressure (${pUnit})`,
      numeric: (n) => siNumber(n.pressure),
      render: (n) =>
        isParameterExpression(n.pressure) ? (
          <span
            style={{ color: "var(--text-2)" }}
            title={`Formula: ${n.pressure.expr} — edit in the property panel`}
          >
            {fmtBindable(n.pressure, "pressure", unitPrefs)}
          </span>
        ) : (
          <CellUnitInput
            kind="pressure"
            unitId={pUnitId}
            value={siNumber(n.pressure)}
            onCommit={(v) => updateNode(n.id, { pressure: v })}
            testid={`mt-p-${n.id}`}
            ariaLabel={`Pressure for ${n.id} (${pUnit})`}
          />
        ),
      csv: (n) =>
        isParameterExpression(n.pressure)
          ? `ƒ${n.pressure.expr}`
          : siNumber(n.pressure) === undefined
            ? ""
            : String(convertFromSI("pressure", siNumber(n.pressure)!, pUnitId)),
    },
    {
      key: "t",
      header: `Temperature (${tUnit})`,
      numeric: (n) => siNumber(n.temperature),
      render: (n) =>
        isParameterExpression(n.temperature) ? (
          <span
            style={{ color: "var(--text-2)" }}
            title={`Formula: ${n.temperature.expr} — edit in the property panel`}
          >
            {fmtBindable(n.temperature, "temperature", unitPrefs)}
          </span>
        ) : (
          <CellUnitInput
            kind="temperature"
            unitId={tUnitId}
            value={siNumber(n.temperature)}
            onCommit={(v) => updateNode(n.id, { temperature: v })}
            testid={`mt-t-${n.id}`}
            ariaLabel={`Temperature for ${n.id} (${tUnit})`}
          />
        ),
      csv: (n) =>
        isParameterExpression(n.temperature)
          ? `ƒ${n.temperature.expr}`
          : siNumber(n.temperature) === undefined
            ? ""
            : String(
                convertFromSI("temperature", siNumber(n.temperature)!, tUnitId),
              ),
    },
    {
      key: "vol",
      header: `Volume (${vUnit})`,
      numeric: (n) => siNumber(n.volume),
      // A formula-bound volume is shown as a read-only ƒ marker (same
      // convention as the Parameters summaries) — never a blank editable
      // cell that would silently overwrite the formula.  Editing stays in
      // the PropertyPanel's FormulaUnitInput.
      render: (n) =>
        isParameterExpression(n.volume) ? (
          <span
            style={{ color: "var(--text-2)" }}
            title={`Formula: ${n.volume.expr} — edit in the property panel`}
          >
            {fmtBindable(n.volume, "volume", unitPrefs)}
          </span>
        ) : (
          <CellUnitInput
            kind="volume"
            unitId={vUnitId}
            value={siNumber(n.volume)}
            onCommit={(v) => updateNode(n.id, { volume: v })}
            testid={`mt-vol-${n.id}`}
            ariaLabel={`Volume for ${n.id} (${vUnit})`}
          />
        ),
      csv: (n) =>
        isParameterExpression(n.volume)
          ? `ƒ${n.volume.expr}`
          : siNumber(n.volume) === undefined
            ? ""
            : String(convertFromSI("volume", siNumber(n.volume)!, vUnitId)),
    },
    {
      key: "group",
      header: "Subnetwork",
      filterText: (n) => (n.group ? (groupLabel.get(n.group) ?? n.group) : ""),
      render: (n) => (n.group ? (groupLabel.get(n.group) ?? n.group) : "—"),
      csv: (n) => (n.group ? (groupLabel.get(n.group) ?? n.group) : ""),
    },
    {
      key: "open",
      header: "Open",
      render: (n) => (
        <button
          type="button"
          data-testid={`mt-open-${n.id}`}
          className="btn btn--ghost btn--sm"
          onClick={(e) => {
            e.stopPropagation();
            openInModel("node", n.id);
          }}
          title="Select and edit full node properties in the property panel"
        >
          Open in properties
        </button>
      ),
    },
  ];

  // ── Branches table ──────────────────────────────────────────────────
  const branchRows = config.branches.filter((b) =>
    match(b.id, b.label, b.from, b.to, componentLabel(b.component.type)),
  );
  const branchColumns: MTColumn<BranchConfig>[] = [
    {
      key: "name",
      header: "Name",
      filterText: (b) => b.label ?? "",
      render: (b) => (
        <CellTextInput
          value={b.label ?? ""}
          onCommit={(v) => updateBranch(b.id, { label: v })}
          testid={`mt-name-${b.id}`}
          ariaLabel={`Label for ${b.id}`}
        />
      ),
      csv: (b) => b.label ?? "",
    },
    {
      key: "id",
      header: "ID",
      filterText: (b) => b.id,
      render: (b) => b.id,
      csv: (b) => b.id,
    },
    {
      key: "from",
      header: "From",
      filterText: (b) => b.from,
      render: (b) => b.from,
      csv: (b) => b.from,
    },
    {
      key: "to",
      header: "To",
      filterText: (b) => b.to,
      render: (b) => b.to,
      csv: (b) => b.to,
    },
    {
      key: "comp",
      header: "Component",
      filterText: (b) => componentLabel(b.component.type),
      render: (b) => componentLabel(b.component.type),
      csv: (b) => b.component.type,
    },
    {
      key: "params",
      header: "Parameters",
      render: (b) => (
        <span style={{ color: "var(--text-2)" }}>
          {branchSummary(b, unitPrefs)}
        </span>
      ),
      csv: (b) => branchSummary(b, unitPrefs),
    },
    {
      key: "open",
      header: "",
      render: (b) => (
        <button
          type="button"
          data-testid={`mt-open-${b.id}`}
          className="btn btn--ghost btn--sm"
          onClick={(e) => {
            e.stopPropagation();
            openInModel("branch", b.id);
          }}
          title="Select and edit full component parameters in the property panel"
        >
          Open in properties
        </button>
      ),
    },
  ];

  // ── Solid nodes table ───────────────────────────────────────────────
  const solidRows = solidRowsAll.filter((n) => match(n.id, n.label, n.type));
  const solidColumns: MTColumn<SolidNodeConfig>[] = [
    {
      key: "name",
      header: "Name",
      filterText: (n) => n.label ?? "",
      render: (n) => (
        <CellTextInput
          value={n.label ?? ""}
          onCommit={(v) => updateSolidNode(n.id, { label: v })}
          testid={`mt-name-${n.id}`}
          ariaLabel={`Label for ${n.id}`}
        />
      ),
      csv: (n) => n.label ?? "",
    },
    {
      key: "id",
      header: "ID",
      filterText: (n) => n.id,
      render: (n) => n.id,
      csv: (n) => n.id,
    },
    {
      key: "type",
      header: "Type",
      filterText: (n) => n.type,
      render: (n) => n.type,
      csv: (n) => n.type,
    },
    {
      key: "t",
      header: `Temperature (${tUnit})`,
      numeric: (n) => siNumber(n.temperature),
      render: (n) =>
        isParameterExpression(n.temperature) ? (
          <span
            style={{ color: "var(--text-2)" }}
            title={`Formula: ${n.temperature.expr} — edit in the property panel`}
          >
            {fmtBindable(n.temperature, "temperature", unitPrefs)}
          </span>
        ) : (
          <CellUnitInput
            kind="temperature"
            unitId={tUnitId}
            value={siNumber(n.temperature)}
            onCommit={(v) => updateSolidNode(n.id, { temperature: v })}
            testid={`mt-t-${n.id}`}
            ariaLabel={`Temperature for ${n.id} (${tUnit})`}
          />
        ),
      csv: (n) =>
        isParameterExpression(n.temperature)
          ? `ƒ${n.temperature.expr}`
          : String(
              convertFromSI("temperature", siNumber(n.temperature)!, tUnitId),
            ),
    },
    {
      key: "mass",
      header: "Mass (kg)",
      numeric: (n) => siNumber(n.mass),
      render: (n) =>
        isParameterExpression(n.mass) ? (
          <span
            style={{ color: "var(--text-2)" }}
            title={`Formula: ${n.mass.expr} — edit in the property panel`}
          >
            {fmtBindable(n.mass, "dimensionless", unitPrefs)}
          </span>
        ) : (
          <CellUnitInput
            kind="dimensionless"
            value={siNumber(n.mass)}
            onCommit={(v) => updateSolidNode(n.id, { mass: v })}
            testid={`mt-m-${n.id}`}
            ariaLabel={`Mass for ${n.id} (kg)`}
          />
        ),
      csv: (n) =>
        isParameterExpression(n.mass)
          ? `ƒ${n.mass.expr}`
          : n.mass === undefined
            ? ""
            : String(n.mass),
    },
    {
      key: "cp",
      header: "cp (J/kg·K)",
      numeric: (n) => (typeof n.cp === "number" ? n.cp : undefined),
      render: (n) => cpSummary(n.cp),
      csv: (n) => cpSummary(n.cp),
    },
    {
      key: "group",
      header: "Subnetwork",
      filterText: (n) => (n.group ? (groupLabel.get(n.group) ?? n.group) : ""),
      render: (n) => (n.group ? (groupLabel.get(n.group) ?? n.group) : "—"),
      csv: (n) => (n.group ? (groupLabel.get(n.group) ?? n.group) : ""),
    },
    {
      key: "open",
      header: "Open",
      render: (n) => (
        <button
          type="button"
          data-testid={`mt-open-${n.id}`}
          className="btn btn--ghost btn--sm"
          onClick={(e) => {
            e.stopPropagation();
            openInModel("solidNode", n.id);
          }}
          title="Select and edit full node properties in the property panel"
        >
          Open in properties
        </button>
      ),
    },
  ];

  // ── Conductors table ────────────────────────────────────────────────
  const conductorRows = (config.conductors ?? []).filter((c) =>
    match(c.id, c.label, c.from, c.to, conductorLabel(c.type.kind)),
  );
  const conductorColumns: MTColumn<ConductorConfig>[] = [
    {
      key: "name",
      header: "Name",
      filterText: (c) => c.label ?? "",
      render: (c) => (
        <CellTextInput
          value={c.label ?? ""}
          onCommit={(v) => updateConductor(c.id, { label: v })}
          testid={`mt-name-${c.id}`}
          ariaLabel={`Label for ${c.id}`}
        />
      ),
      csv: (c) => c.label ?? "",
    },
    {
      key: "id",
      header: "ID",
      filterText: (c) => c.id,
      render: (c) => c.id,
      csv: (c) => c.id,
    },
    {
      key: "from",
      header: "From",
      filterText: (c) => c.from,
      render: (c) => c.from,
      csv: (c) => c.from,
    },
    {
      key: "to",
      header: "To",
      filterText: (c) => c.to,
      render: (c) => c.to,
      csv: (c) => c.to,
    },
    {
      key: "kind",
      header: "Kind",
      filterText: (c) => conductorLabel(c.type.kind),
      render: (c) => conductorLabel(c.type.kind),
      csv: (c) => c.type.kind,
    },
    {
      key: "params",
      header: "Parameters",
      render: (c) => (
        <span style={{ color: "var(--text-2)" }}>
          {conductorSummary(c, unitPrefs)}
        </span>
      ),
      csv: (c) => conductorSummary(c, unitPrefs),
    },
  ];

  // Notes are prose, so the table is the one place to read them all at once
  // and search across them; there is nothing numeric to unit-convert.
  const noteRows = (config.notes ?? []).filter((n) =>
    match(n.id, n.text, n.group && groupLabel.get(n.group)),
  );
  const noteColumns: MTColumn<NoteConfig>[] = [
    {
      key: "id",
      header: "ID",
      filterText: (n) => n.id,
      render: (n) => n.id,
      csv: (n) => n.id,
    },
    {
      key: "text",
      header: "Text",
      filterText: (n) => n.text,
      render: (n) => (
        <CellTextInput
          value={n.text}
          onCommit={(v) => updateNote(n.id, { text: v })}
          testid={`mt-note-text-${n.id}`}
          ariaLabel={`Text for note ${n.id}`}
        />
      ),
      csv: (n) => n.text,
    },
    {
      key: "group",
      header: "Subnetwork",
      filterText: (n) => (n.group ? (groupLabel.get(n.group) ?? n.group) : ""),
      render: (n) => (n.group ? (groupLabel.get(n.group) ?? n.group) : "—"),
      csv: (n) => (n.group ? (groupLabel.get(n.group) ?? n.group) : ""),
    },
    {
      key: "open",
      header: "Open",
      render: (n) => (
        <button
          type="button"
          data-testid={`mt-open-${n.id}`}
          className="btn btn--ghost btn--sm"
          onClick={(e) => {
            e.stopPropagation();
            openInModel("note", n.id);
          }}
        >
          ⤢
        </button>
      ),
      csv: () => "",
    },
  ];

  const issueCount = validationErrors.length;

  return (
    <div
      data-testid="model-table-view"
      style={{
        height: "100%",
        overflowY: "auto",
        padding: 24,
        color: "var(--text-1)",
      }}
    >
      {/* Audit summary bar */}
      <div
        data-testid="model-table-summary"
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <span className="pill pill--muted" title="Boundary fluid nodes">
          {counts.boundaries} boundary
        </span>
        <span className="pill pill--muted" title="Internal fluid nodes">
          {counts.internal} internal
        </span>
        <span className="pill pill--muted" title="Branches">
          {counts.branches} branches
        </span>
        <span className="pill pill--muted" title="Solid/ambient nodes">
          {counts.solids} solids
        </span>
        <span className="pill pill--muted" title="Thermal conductors">
          {counts.conductors} conductors
        </span>
        <span className="pill pill--muted" title="Subnetworks">
          {counts.groups} subnetworks
        </span>
        <span
          className={`pill ${counts.disconnected > 0 ? "pill--warn" : "pill--muted"}`}
          data-testid="model-table-disconnected"
          title="Nodes not referenced by any branch or conductor"
        >
          {counts.disconnected} disconnected
        </span>
        <span
          className={`pill ${issueCount > 0 ? "pill--danger" : "pill--ok"}`}
          data-testid="model-table-validation"
          title={
            issueCount > 0
              ? validationErrors.join("\n")
              : "validateNetwork reports no issues"
          }
        >
          {issueCount > 0
            ? `${issueCount} validation issue${issueCount === 1 ? "" : "s"}`
            : "No validation issues"}
        </span>
        <span style={{ flex: 1 }} />
        <input
          data-testid="model-table-search"
          className="input"
          type="search"
          placeholder="Filter by name, id, type…"
          aria-label="Filter model tables"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 240 }}
        />
      </div>

      <Section title={`Fluid Nodes (${nodeRows.length})`}>
        <ModelTable
          testid="model-table-nodes"
          ariaLabel="Fluid nodes"
          columns={nodeColumns}
          rows={nodeRows}
          csvName="nodes"
          onOpen={(id) => openInModel("node", id)}
          rowTestid={(n) => `mt-node-${n.id}`}
        />
      </Section>
      <Section title={`Branches (${branchRows.length})`}>
        <ModelTable
          testid="model-table-branches"
          ariaLabel="Branches"
          columns={branchColumns}
          rows={branchRows}
          csvName="branches"
          onOpen={(id) => openInModel("branch", id)}
          rowTestid={(b) => `mt-branch-${b.id}`}
        />
      </Section>
      <Section title={`Solid Nodes (${solidRows.length})`}>
        <ModelTable
          testid="model-table-solids"
          ariaLabel="Solid nodes"
          columns={solidColumns}
          rows={solidRows}
          csvName="solid-nodes"
          onOpen={(id) => openInModel("solidNode", id)}
          rowTestid={(n) => `mt-solid-${n.id}`}
        />
      </Section>
      <Section title={`Conductors (${conductorRows.length})`}>
        <ModelTable
          testid="model-table-conductors"
          ariaLabel="Conductors"
          columns={conductorColumns}
          rows={conductorRows}
          csvName="conductors"
          onOpen={(id) => openInModel("conductor", id)}
          rowTestid={(c) => `mt-conductor-${c.id}`}
        />
      </Section>
      {/* Hidden entirely when unused: an always-empty table would imply the
          model is missing something. */}
      {(config.notes?.length ?? 0) > 0 && (
        <Section title={`Notes (${noteRows.length})`}>
          <ModelTable
            testid="model-table-notes"
            ariaLabel="Notes"
            columns={noteColumns}
            rows={noteRows}
            csvName="notes"
            onOpen={(id) => openInModel("note", id)}
            rowTestid={(n) => `mt-note-${n.id}`}
          />
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          marginBottom: 10,
          color: "var(--text-1)",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
