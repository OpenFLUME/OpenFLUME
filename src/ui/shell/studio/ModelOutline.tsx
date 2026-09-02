/**
 * ModelOutline — the Studio shell's project tree (FLACS/COMSOL-style).
 *
 * One searchable tree covers the WHOLE project, not just canvas entities:
 *
 *   SETUP           solver / physics / fluids (with named-fluid children) /
 *                   species / units / extensibility — each row annotated with
 *                   its current value and clicking opens the Setup tab on
 *                   that section, so the tree doubles as a settings summary.
 *   MODEL           fluid nodes, branches, solid nodes, conductors, groups,
 *                   notes — click to select + zoom on the canvas.
 *   RESULTS         run history records — click to select the run and open
 *                   the Results view.
 *
 * Rows that need attention carry a warning or error icon, fed by the
 * deterministic readiness checks and the live validation errors, so "what is
 * wrong and where" is answered by the tree itself. Healthy rows are left
 * unmarked: the panel should read as a quiet list with the problems standing
 * out of it.
 */
import React from "react";
import { useStore, type SettingsTabId } from "../../store";
import type { Selection } from "../../types";
import { assessModelReadiness, type ReadinessCheck } from "../../../core";
import { matchSelectionFromError } from "../../selectionFromError";
import EntityGlyph, {
  type EntityGlyphSpec,
} from "../../components/EntityGlyph";
import HoverCard from "../../components/HoverCard";
import { useHoverAnchor } from "../../useHoverAnchor";
import {
  summarizeEntity,
  type EntitySummary,
  type SummarizableKind,
} from "../../entitySummary";
import { componentLabel, conductorLabel } from "../../componentRegistry";
import { downloadRunsFile, runsFileName } from "../../runsFile";
import ConfirmDialog, {
  type ConfirmRequest,
} from "../../components/ConfirmDialog";
import { confirmDiscardAllRuns, confirmDiscardRun } from "../../runDiscard";
import VariantPicker from "./VariantPicker";
import { activeUnitPreset } from "../../units";
import { fluidSpecLabel } from "../../fluidsUi";
import { formatSig } from "../../format";

export type RowStatus = "ok" | "warn" | "error" | "none";

interface Row {
  key: string;
  label: string;
  /** Current-value annotation rendered dimmer after the label. */
  annotation?: string;
  /** Canvas-matching icon — entity rows only. */
  glyph?: EntityGlyphSpec;
  /** Accessible name for the glyph (the element's type in words). */
  glyphTitle?: string;
  /** Text badge for rows with no canvas shape (runs). */
  badge?: string;
  status: RowStatus;
  /** Tooltip explaining a non-ok status. */
  statusTitle?: string;
  /** The active variant overrides this row's value. */
  modified?: boolean;
  indent?: boolean;
  selected?: boolean;
  testId: string;
  onClick: () => void;
  /** Entity behind the row, when hovering it should summarize something. */
  hover?: { kind: SummarizableKind; id: string };
  /** Position in its config array — set on rows that can be drag-reordered. */
  dragIndex?: number;
  /** Secondary actions at the row's right edge (baseline pin, discard). */
  trailing?: RowAction[];
}

interface RowAction {
  label: string;
  title: string;
  testId: string;
  /** On: the action's state is engaged and stays highlighted, not just hovered. */
  active?: boolean;
  /** Destructive: reads red on hover rather than as a normal affordance. */
  danger?: boolean;
  onClick: () => void;
}

/** Which array a section's rows can be reordered within. */
type ReorderKind = "node" | "branch" | "solidNode" | "conductor" | "note";

/** Section disclosure chevron: points right when closed, down when open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={
        open
          ? "model-outline__chevron model-outline__chevron--open"
          : "model-outline__chevron"
      }
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

/**
 * Row status, drawn ONLY when something is wrong: an amber warning triangle or
 * a red error circle. Healthy is the default state and needs no marker — a
 * column of green ticks is noise you have to read past to find the one row
 * that matters, and the round green dot this replaced also read as one more
 * entity glyph beside the outline's green boundary-node squares.
 *
 * Callers still report `ok` rather than `none`, because "checked and fine" and
 * "nothing to check" are different facts; which of them draws is this
 * component's business.
 *
 * Interior marks sit on top of the filled shape rather than being knocked out
 * of it, so the icons survive every row background (default, hover, selected)
 * unchanged.
 */
export function StatusIcon({
  status,
  title,
}: {
  status: RowStatus;
  title?: string;
}) {
  if (status === "none" || status === "ok") return null;
  return (
    <svg
      className={`model-outline__status model-outline__status--${status}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      role="img"
      aria-label={status === "warn" ? "Needs attention" : "Error"}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {status === "warn" ? (
        <>
          <path
            d="M8 1.8 15.2 14.4H0.8z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path
            d="M8 6.2v3.4"
            stroke="var(--bg-0)"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <circle cx="8" cy="12.1" r="1" fill="var(--bg-0)" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5.4 5.4 10.6 10.6M10.6 5.4 5.4 10.6"
            stroke="var(--bg-0)"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

/**
 * A row plus its trailing actions, which cannot be nested inside the row's own
 * <button>.
 *
 * The wrapper — not the button — paints the hover and selected surface, so the
 * highlight runs the full width of the panel instead of stopping short where
 * the actions begin.
 */
function OutlineRowWithAction(props: React.ComponentProps<typeof OutlineRow>) {
  const { row } = props;
  if (!row.trailing?.length) return <OutlineRow {...props} />;
  return (
    <div
      className={
        row.selected
          ? "model-outline__row-wrap model-outline__row-wrap--selected"
          : "model-outline__row-wrap"
      }
    >
      <OutlineRow {...props} />
      {row.trailing.map((action) => (
        <button
          key={action.testId}
          type="button"
          className={[
            "model-outline__row-action",
            action.danger ? "model-outline__row-action--danger" : "",
            action.active ? "model-outline__row-action--active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-pressed={action.active}
          data-testid={action.testId}
          title={action.title}
          aria-label={action.title}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function OutlineRow({
  row,
  onHover,
  onLeave,
  drag,
}: {
  row: Row;
  onHover?: (key: string, el: HTMLElement) => void;
  onLeave?: (key: string) => void;
  drag?: {
    /** null while nothing is being dragged in this section. */
    overIndex: number | null;
    dropBefore: boolean;
    onStart: (index: number) => void;
    onOver: (index: number, before: boolean) => void;
    onDrop: () => void;
    onEnd: () => void;
  };
}) {
  const draggable = drag !== undefined && row.dragIndex !== undefined;
  const isDropTarget = draggable && drag.overIndex === row.dragIndex;

  return (
    <button
      type="button"
      className={[
        "model-outline__item",
        row.indent ? "model-outline__item--child" : "",
        row.selected ? "model-outline__item--selected" : "",
        isDropTarget
          ? drag.dropBefore
            ? "model-outline__item--drop-before"
            : "model-outline__item--drop-after"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={row.testId}
      onClick={row.onClick}
      draggable={draggable}
      onDragStart={
        draggable
          ? (e) => {
              // Reordering is internal: keep the payload out of the canvas
              // drop handler's namespace.
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", row.key);
              onLeave?.(row.key);
              drag.onStart(row.dragIndex!);
            }
          : undefined
      }
      onDragOver={
        draggable
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const box = e.currentTarget.getBoundingClientRect();
              drag.onOver(row.dragIndex!, e.clientY < box.top + box.height / 2);
            }
          : undefined
      }
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              drag.onDrop();
            }
          : undefined
      }
      onDragEnd={draggable ? drag.onEnd : undefined}
      onPointerEnter={
        row.hover ? (e) => onHover?.(row.key, e.currentTarget) : undefined
      }
      onPointerLeave={row.hover ? () => onLeave?.(row.key) : undefined}
      onFocus={
        row.hover ? (e) => onHover?.(row.key, e.currentTarget) : undefined
      }
      onBlur={row.hover ? () => onLeave?.(row.key) : undefined}
    >
      {row.glyph && (
        <EntityGlyph
          {...row.glyph}
          size={16}
          title={row.glyphTitle}
          className="model-outline__item-glyph"
        />
      )}
      {row.badge && (
        <span className="model-outline__item-kind">{row.badge}</span>
      )}
      <span className="model-outline__item-label">
        {row.label}
        {row.annotation && (
          <span className="model-outline__item-annotation">
            {row.annotation}
          </span>
        )}
      </span>
      {row.modified && (
        <span
          className="model-outline__modified"
          title="Overridden by the active variant"
        >
          M
        </span>
      )}
      <StatusIcon status={row.status} title={row.statusTitle} />
    </button>
  );
}

interface SectionAction {
  label: string;
  testId: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}

function Section({
  id,
  title,
  rows,
  emptyHint,
  defaultOpen = true,
  onHover,
  onLeave,
  reorderKind,
  actions,
}: {
  id: string;
  title: string;
  rows: Row[];
  emptyHint?: string;
  defaultOpen?: boolean;
  onHover?: (key: string, el: HTMLElement) => void;
  onLeave?: (key: string) => void;
  /** Set to let rows in this section be dragged into a new order. */
  reorderKind?: ReorderKind;
  /** Section-level actions shown in the heading (e.g. "Save", "Discard"). */
  actions?: SectionAction[];
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const reorderEntity = useStore((s) => s.reorderEntity);
  const [dragFrom, setDragFrom] = React.useState<number | null>(null);
  const [dragOver, setDragOver] = React.useState<{
    index: number;
    before: boolean;
  } | null>(null);

  const endDrag = React.useCallback(() => {
    setDragFrom(null);
    setDragOver(null);
  }, []);

  const commitDrop = React.useCallback(() => {
    if (reorderKind && dragFrom !== null && dragOver !== null) {
      // Dropping "after" a row that sits below the dragged one lands on that
      // row's index once the source is spliced out; "before" lands one earlier.
      const target = dragOver.before ? dragOver.index : dragOver.index + 1;
      const to = target > dragFrom ? target - 1 : target;
      reorderEntity(reorderKind, dragFrom, to);
    }
    endDrag();
  }, [reorderKind, dragFrom, dragOver, reorderEntity, endDrag]);

  const drag = reorderKind
    ? {
        overIndex: dragOver?.index ?? null,
        dropBefore: dragOver?.before ?? true,
        onStart: setDragFrom,
        onOver: (index: number, before: boolean) =>
          setDragOver({ index, before }),
        onDrop: commitDrop,
        onEnd: endDrag,
      }
    : undefined;

  const worst: RowStatus = rows.some((r) => r.status === "error")
    ? "error"
    : rows.some((r) => r.status === "warn")
      ? "warn"
      : "none";
  return (
    <div
      className="model-outline__section"
      data-testid={`outline-section-${id}`}
    >
      <div className="model-outline__heading-row">
        {/* The disclosure button flexes to fill the slack, so the whole empty
            middle of the heading still toggles the section. The count sits
            outside it, LAST, so counts line up in one column down the panel
            whether or not a section also carries actions. */}
        <button
          type="button"
          className="model-outline__heading"
          aria-expanded={open}
          // The count is rendered outside this button, so name it explicitly
          // rather than letting the disclosure announce a bare title.
          aria-label={`${title} (${rows.length})`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="model-outline__heading-label">
            <Chevron open={open} />
            {title}
          </span>
        </button>
        {actions?.map((a) => (
          <button
            key={a.testId}
            type="button"
            className="model-outline__heading-action"
            data-testid={a.testId}
            title={a.title}
            disabled={a.disabled}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
        <span className="model-outline__heading-meta">
          {!open && <StatusIcon status={worst} />}
          <span className="model-outline__count">{rows.length}</span>
        </span>
      </div>
      {open &&
        (rows.length === 0 ? (
          emptyHint ? (
            <div className="model-outline__empty">{emptyHint}</div>
          ) : null
        ) : (
          rows.map((row) => (
            <OutlineRowWithAction
              key={row.key}
              row={row}
              onHover={onHover}
              onLeave={onLeave}
              drag={drag}
            />
          ))
        ))}
    </div>
  );
}

/** Case-insensitive match over everything the row shows. */
function rowMatches(query: string, ...haystacks: (string | undefined)[]) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystacks.some((h) => h?.toLowerCase().includes(q));
}

/** Body of the hover card: identity, defining parameters, solved values. */
function EntitySummaryCard({ summary }: { summary: EntitySummary }) {
  return (
    <>
      <div className="hover-card__header">
        {summary.glyph && <EntityGlyph {...summary.glyph} size={16} />}
        <span className="hover-card__title">{summary.title}</span>
        <span className="hover-card__subtitle">{summary.subtitle}</span>
      </div>
      {summary.rows.length > 0 && (
        <dl className="hover-card__rows">
          {summary.rows.map((r) => (
            <React.Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {summary.results.length > 0 && (
        <>
          <div className="hover-card__section">Latest run</div>
          <dl className="hover-card__rows">
            {summary.results.map((r) => (
              <React.Fragment key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </>
      )}
    </>
  );
}

export default function ModelOutline() {
  const config = useStore((s) => s.config);
  const selection = useStore((s) => s.selection);
  const validationErrors = useStore((s) => s.validationErrors);
  const runHistory = useStore((s) => s.runHistory);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const activeTab = useStore((s) => s.activeTab);
  const unitPreferences = useStore((s) => s.unitPreferences);
  const setSelection = useStore((s) => s.setSelection);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveGroupTab = useStore((s) => s.setActiveGroupTab);
  const requestCanvasFocus = useStore((s) => s.requestCanvasFocus);
  const setSettingsTab = useStore((s) => s.setSettingsTab);
  const selectRun = useStore((s) => s.selectRun);
  const discardRuns = useStore((s) => s.discardRuns);
  const deleteRun = useStore((s) => s.deleteRun);
  const running = useStore((s) => s.running);
  const result = useStore((s) => s.result);
  const resultConfig = useStore((s) => s.resultConfig);
  const timeIndex = useStore((s) => s.timeIndex);
  const baseConfig = useStore((s) => s.baseConfig);
  const activeVariantId = useStore((s) => s.activeVariantId);
  const baselineRunId = useStore((s) => s.baselineRunId);
  const setBaselineRunId = useStore((s) => s.setBaselineRunId);

  const [query, setQuery] = React.useState("");
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const hover = useHoverAnchor();

  const checks = React.useMemo(() => assessModelReadiness(config), [config]);
  const check = React.useCallback(
    (id: string): ReadinessCheck | undefined => checks.find((c) => c.id === id),
    [checks],
  );

  /** Element ids flagged by a validation error (red) or a readiness
   *  target (amber). Errors win over warnings on the same element. */
  const { errorIds, warnIds } = React.useMemo(() => {
    const errors = new Set<string>();
    for (const err of validationErrors) {
      const sel = matchSelectionFromError(err, config);
      if (sel && "id" in sel) errors.add(sel.id);
    }
    const warns = new Set<string>();
    for (const c of checks) {
      if (c.status === "ok" || !c.targets) continue;
      for (const t of c.targets) if (!errors.has(t.id)) warns.add(t.id);
    }
    return { errorIds: errors, warnIds: warns };
  }, [validationErrors, checks, config]);

  /** Ids and settings keys the active variant overrides, for the "M" marks. */
  const overrides = React.useMemo(() => {
    const patch =
      activeVariantId === null
        ? undefined
        : (baseConfig.variants ?? []).find((v) => v.id === activeVariantId)
            ?.patch;
    const ids = new Set<string>();
    if (patch) {
      for (const key of [
        "nodes",
        "branches",
        "solidNodes",
        "conductors",
      ] as const)
        for (const id of Object.keys(patch[key] ?? {})) ids.add(id);
      if (patch.added)
        for (const key of [
          "nodes",
          "branches",
          "solidNodes",
          "conductors",
        ] as const)
          for (const entity of patch.added[key] ?? []) ids.add(entity.id);
    }
    return {
      ids,
      settings: patch?.settings !== undefined,
      fluid: patch?.fluid !== undefined,
    };
  }, [baseConfig.variants, activeVariantId]);

  const entityStatus = (id: string): { status: RowStatus; title?: string } => {
    if (errorIds.has(id))
      return {
        status: "error",
        title: "A validation error names this element",
      };
    if (warnIds.has(id))
      return { status: "warn", title: "Flagged by a readiness check" };
    return { status: "none" };
  };

  const jumpTo = React.useCallback(
    (kind: Selection["kind"], id: string) => {
      setActiveTab("editor");
      setActiveGroupTab(null);
      setSelection({ kind, id } as Selection);
      requestCanvasFocus(kind, id);
    },
    [setActiveTab, setActiveGroupTab, setSelection, requestCanvasFocus],
  );

  /** Open the Setup workspace on a given section. */
  const openConfig = React.useCallback(
    (tab: SettingsTabId) => {
      setActiveTab("config");
      setSettingsTab(tab);
    },
    [setActiveTab, setSettingsTab],
  );

  // --- CONFIGURATION rows -------------------------------------------------
  const s = config.settings;
  const solveCheck = check("solve-settings");
  const solverAnnotation =
    s.mode === "transient"
      ? `transient → ${s.endTime !== undefined ? `${formatSig(s.endTime, 3)} s` : "?"}`
      : `steady · tol ${s.tolerance}`;
  const physicsOn = [
    s.momentumFlux ? "momentum flux" : null,
    s.kineticEnergy ? "kinetic energy" : null,
  ].filter(Boolean);
  const namedFluids = Object.entries(config.fluids ?? {});
  const speciesCount = config.species?.names.length ?? 0;
  const reactionCount = config.species?.reactions?.length ?? 0;
  const extensibilityCount =
    Object.keys(config.registers ?? {}).length +
    (config.logic?.length ?? 0) +
    (config.controllers?.length ?? 0);

  const configRows: Row[] = [];
  const pushConfig = (
    tab: SettingsTabId,
    label: string,
    annotation: string,
    status: RowStatus,
    statusTitle?: string,
    opts?: {
      key?: string;
      indent?: boolean;
      onClick?: () => void;
      modified?: boolean;
    },
  ) => {
    if (!rowMatches(query, label, annotation)) return;
    configRows.push({
      key: opts?.key ?? `config-${tab}-${label}`,
      label,
      annotation,
      status,
      statusTitle,
      modified: opts?.modified,
      indent: opts?.indent,
      testId: `outline-config-${opts?.key ?? tab}`,
      onClick: opts?.onClick ?? (() => openConfig(tab)),
    });
  };

  pushConfig(
    "solver",
    "Solver",
    solverAnnotation,
    solveCheck?.status === "ok" ? "ok" : "warn",
    solveCheck?.status === "ok" ? undefined : solveCheck?.detail,
    { modified: overrides.settings },
  );
  pushConfig(
    "physics",
    "Physics",
    physicsOn.length > 0
      ? physicsOn.join(" + ")
      : "algebraic momentum + static enthalpy",
    "ok",
  );
  pushConfig(
    "fluids",
    "Fluids",
    namedFluids.length > 0
      ? `${fluidSpecLabel(config.fluid)} +${namedFluids.length} named`
      : fluidSpecLabel(config.fluid),
    "ok",
    undefined,
    { modified: overrides.fluid },
  );
  for (const [name, spec] of namedFluids) {
    pushConfig("fluids", name, fluidSpecLabel(spec), "ok", undefined, {
      key: `fluid-${name}`,
      indent: true,
    });
  }
  if (speciesCount > 0) {
    pushConfig(
      "species",
      "Species",
      `${speciesCount} species · ${reactionCount} reaction${reactionCount === 1 ? "" : "s"}`,
      "ok",
    );
  }
  pushConfig("units", "Units", activeUnitPreset(unitPreferences), "ok");
  if (extensibilityCount > 0) {
    pushConfig(
      "extensibility",
      "Extensibility",
      `${extensibilityCount} item${extensibilityCount === 1 ? "" : "s"}`,
      "ok",
    );
  }

  // --- MODEL rows -----------------------------------------------------------
  const isSelected = (kind: Selection["kind"], id: string) =>
    selection.kind === kind && "id" in selection && selection.id === id;

  const entityRow = (
    kind: Selection["kind"] &
      ("node" | "branch" | "solidNode" | "conductor" | "group" | "note"),
    id: string,
    label: string,
    glyph: EntityGlyphSpec,
    glyphTitle: string,
    /** Index in the config array — the reorder handle, not the render order. */
    dragIndex: number,
  ): Row | null => {
    if (!rowMatches(query, id, label, glyphTitle)) return null;
    const { status, title } = entityStatus(id);
    return {
      key: `${kind}:${id}`,
      label,
      glyph,
      glyphTitle,
      status,
      statusTitle: title,
      modified: overrides.ids.has(id),
      selected: isSelected(kind, id),
      testId: `outline-item-${id}`,
      onClick: () => jumpTo(kind, id),
      hover: { kind, id },
      dragIndex,
    };
  };

  const nodeRows = config.nodes
    .map((n, i) =>
      entityRow(
        "node",
        n.id,
        n.label && n.label !== n.id ? `${n.id} · ${n.label}` : n.id,
        { entity: "node", type: n.type },
        n.type === "boundary" ? "Boundary node" : "Internal node",
        i,
      ),
    )
    .filter((r): r is Row => r !== null);
  const branchRows = config.branches
    .map((b, i) =>
      entityRow(
        "branch",
        b.id,
        `${b.id} · ${b.from} → ${b.to}`,
        { entity: "branch", component: b.component.type },
        componentLabel(b.component.type),
        i,
      ),
    )
    .filter((r): r is Row => r !== null);
  const solidRows = (config.solidNodes ?? [])
    .map((n, i) =>
      entityRow(
        "solidNode",
        n.id,
        n.label && n.label !== n.id ? `${n.id} · ${n.label}` : n.id,
        { entity: "solidNode", type: n.type },
        n.type === "ambient" ? "Ambient node" : "Solid node",
        i,
      ),
    )
    .filter((r): r is Row => r !== null);
  const conductorRows = (config.conductors ?? [])
    .map((c, i) =>
      entityRow(
        "conductor",
        c.id,
        `${c.id} · ${c.from} ↔ ${c.to}`,
        { entity: "conductor", kind: c.type.kind },
        conductorLabel(c.type.kind),
        i,
      ),
    )
    .filter((r): r is Row => r !== null);
  const groupRows = (config.groups ?? [])
    .map((g, i) =>
      entityRow(
        "group",
        g.id,
        g.label || g.id,
        { entity: "group" },
        "Subnetwork",
        i,
      ),
    )
    .filter((r): r is Row => r !== null);
  const noteRows = (config.notes ?? [])
    .map((n, i) =>
      entityRow(
        "note",
        n.id,
        n.text ? n.text.slice(0, 40) : n.id,
        { entity: "note" },
        "Note",
        i,
      ),
    )
    .filter((r): r is Row => r !== null);

  // --- RUNS rows ------------------------------------------------------------
  // One flat, newest-first list tagged with the variant that produced each
  // run: comparison means looking at runs from DIFFERENT variants side by
  // side, which nesting them under their variant would have obstructed.
  const variantName = (id: string | null): string =>
    id === null
      ? "Base"
      : ((baseConfig.variants ?? []).find((v) => v.id === id)?.name ??
        "(deleted)");

  const runRows: Row[] = runHistory
    .slice()
    .reverse()
    .filter((r) =>
      rowMatches(query, r.name, r.summary, r.mode, variantName(r.variantId)),
    )
    .map((r) => ({
      key: `run-${r.id}`,
      label: `${r.name} · ${variantName(r.variantId)}`,
      annotation: r.summary,
      badge: r.mode === "transient" ? "TRN" : "STD",
      status: r.converged ? "ok" : "error",
      statusTitle: r.converged ? "Converged" : "Did not converge",
      selected: selectedRunId === r.id && activeTab === "results",
      testId: `outline-run-${r.id}`,
      onClick: () => {
        selectRun(r.id);
        setActiveTab("results");
      },
      trailing: [
        // The displayed run cannot be its own baseline, so it has no pin.
        ...(r.id === selectedRunId
          ? []
          : [
              {
                label: baselineRunId === r.id ? "★" : "☆",
                title:
                  baselineRunId === r.id
                    ? "Unpin as comparison baseline"
                    : "Pin as comparison baseline",
                testId: `outline-baseline-${r.id}`,
                active: baselineRunId === r.id,
                onClick: () =>
                  setBaselineRunId(baselineRunId === r.id ? null : r.id),
              },
            ]),
        {
          label: "×",
          title: `Discard ${r.name}`,
          testId: `outline-discard-run-${r.id}`,
          danger: true,
          onClick: () =>
            setConfirm(confirmDiscardRun(r.name, () => deleteRun(r.id))),
        },
      ],
    }));

  const filtering = query.trim().length > 0;
  // Dragging while filtered would move an element relative to rows that are
  // not on screen, so reordering is off until the filter is cleared.
  const reorderKind = (kind: ReorderKind): ReorderKind | undefined =>
    filtering ? undefined : kind;

  // The hovered row's summary. Solved values come from the run currently on
  // screen, read against the config that run solved.
  const allRows = React.useMemo(
    () =>
      new Map(
        [
          ...nodeRows,
          ...branchRows,
          ...solidRows,
          ...conductorRows,
          ...groupRows,
          ...noteRows,
        ].map((r) => [r.key, r]),
      ),
    [nodeRows, branchRows, solidRows, conductorRows, groupRows, noteRows],
  );
  const hoveredRow = hover.anchor ? allRows.get(hover.anchor.key) : undefined;
  const hoverSummary = hoveredRow?.hover
    ? summarizeEntity({
        config,
        result,
        resultConfig,
        timeIndex,
        unitPreferences,
        kind: hoveredRow.hover.kind,
        id: hoveredRow.hover.id,
      })
    : null;

  return (
    <div className="model-outline" data-testid="model-outline">
      {/* The picker both switches the variant and labels every section
          below it as belonging to that variant. */}
      <VariantPicker />
      <div className="model-outline__search">
        <input
          className="input"
          type="search"
          placeholder="Filter…"
          aria-label="Filter the project outline"
          data-testid="outline-filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="model-outline__scroll" onScroll={hover.dismiss}>
        {(!filtering || configRows.length > 0) && (
          <Section id="configuration" title="Setup" rows={configRows} />
        )}
        {(!filtering || nodeRows.length > 0) && (
          <Section
            id="fluid-nodes"
            title="Fluid nodes"
            rows={nodeRows}
            emptyHint="Place nodes from the canvas rail."
            onHover={hover.open}
            onLeave={hover.close}
            reorderKind={reorderKind("node")}
          />
        )}
        {(!filtering || branchRows.length > 0) && (
          <Section
            id="branches"
            title="Branches"
            rows={branchRows}
            emptyHint="Connect two nodes to create a branch."
            onHover={hover.open}
            onLeave={hover.close}
            reorderKind={reorderKind("branch")}
          />
        )}
        {(!filtering || solidRows.length > 0) && (
          <Section
            id="solid-nodes"
            title="Solid nodes"
            rows={solidRows}
            onHover={hover.open}
            onLeave={hover.close}
            reorderKind={reorderKind("solidNode")}
          />
        )}
        {(!filtering || conductorRows.length > 0) && (
          <Section
            id="conductors"
            title="Conductors"
            rows={conductorRows}
            onHover={hover.open}
            onLeave={hover.close}
            reorderKind={reorderKind("conductor")}
          />
        )}
        {groupRows.length > 0 && (
          <Section
            id="subnetworks"
            title="Subnetworks"
            rows={groupRows}
            onHover={hover.open}
            onLeave={hover.close}
          />
        )}
        {noteRows.length > 0 && (
          <Section
            id="notes"
            title="Notes"
            rows={noteRows}
            onHover={hover.open}
            onLeave={hover.close}
            reorderKind={reorderKind("note")}
          />
        )}
        {(!filtering || runRows.length > 0) && (
          <Section
            id="results"
            title="Results"
            rows={runRows}
            emptyHint="Run the model to record results here."
            actions={
              runHistory.length > 0
                ? [
                    {
                      label: "Save",
                      testId: "outline-save-runs",
                      title: `Write ${runsFileName(baseConfig)}`,
                      onClick: () => downloadRunsFile(baseConfig, runHistory),
                    },
                    {
                      label: "Discard",
                      testId: "outline-discard-runs",
                      // Discarding mid-solve would only be undone by the
                      // record the running solve is about to push.
                      disabled: running,
                      title: running
                        ? "Wait for the run to finish"
                        : "Delete every recorded run",
                      onClick: () =>
                        setConfirm(
                          confirmDiscardAllRuns(runHistory.length, discardRuns),
                        ),
                    },
                  ]
                : undefined
            }
          />
        )}
      </div>
      <div className="model-outline__hint" aria-hidden="true">
        Press <kbd>Ctrl</kbd>+<kbd>\</kbd> to hide the panel
      </div>
      <HoverCard anchor={hoverSummary ? hover.anchor : null}>
        {hoverSummary && <EntitySummaryCard summary={hoverSummary} />}
      </HoverCard>
      {confirm && (
        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      )}
    </div>
  );
}
