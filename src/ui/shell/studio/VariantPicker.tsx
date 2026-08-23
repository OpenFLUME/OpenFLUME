/**
 * VariantPicker — switches the active simulation variant AND labels the
 * outline sections below it, so the panel never states twice which network
 * you are editing.
 *
 * A popover rather than a native `<select>`: the list has to carry a status
 * dot, a change count and a run count per variant, plus rename / duplicate /
 * delete actions and a "new variant" item, none of which fit in an option
 * element. Follows the anchored-portal pattern used by the toolbar's issues
 * popover so it escapes the outline's scroll clipping.
 */
import React from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../store";
import { countVariantChanges } from "../../../core";
import { StatusIcon } from "./ModelOutline";

interface Entry {
  id: string | null;
  name: string;
  changes: number;
  runs: number;
  /** Newest run outcome, when there is one. */
  outcome: "ok" | "error" | null;
}

export default function VariantPicker() {
  const baseConfig = useStore((s) => s.baseConfig);
  const activeVariantId = useStore((s) => s.activeVariantId);
  const runHistory = useStore((s) => s.runHistory);
  const setActiveVariant = useStore((s) => s.setActiveVariant);
  const createVariant = useStore((s) => s.createVariant);
  const renameVariant = useStore((s) => s.renameVariant);
  const duplicateVariant = useStore((s) => s.duplicateVariant);
  const deleteVariant = useStore((s) => s.deleteVariant);

  const [open, setOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const entries: Entry[] = React.useMemo(() => {
    const forVariant = (id: string | null): Pick<Entry, "runs" | "outcome"> => {
      const runs = runHistory.filter((r) => r.variantId === id);
      const newest = runs[runs.length - 1];
      return {
        runs: runs.length,
        outcome: newest ? (newest.converged ? "ok" : "error") : null,
      };
    };
    return [
      { id: null, name: "Base", changes: 0, ...forVariant(null) },
      ...(baseConfig.variants ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        changes: countVariantChanges(v),
        ...forVariant(v.id),
      })),
    ];
  }, [baseConfig.variants, runHistory]);

  const active = entries.find((e) => e.id === activeVariantId) ?? entries[0];

  React.useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = buttonRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setAnchor({
        top: rect.bottom + 4,
        left: rect.left,
        width: Math.max(rect.width, 240),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Naming happens inline, in the row itself: `renaming` holds the id being
  // edited ("" for the new-variant field), `draft` the text.
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");

  const choose = (id: string | null) => {
    setActiveVariant(id);
    setOpen(false);
  };

  const startRename = (id: string, current: string) => {
    setRenaming(id);
    setDraft(current);
  };

  // The outside-click handler runs on mousedown, before the input's blur, so
  // it needs the live draft to commit rather than a stale closure.
  const pending = React.useRef<{ id: string; draft: string } | null>(null);
  pending.current = renaming === null ? null : { id: renaming, draft };

  const commitPending = React.useCallback(() => {
    const current = pending.current;
    pending.current = null;
    if (!current) return false;
    const name = current.draft.trim();
    setRenaming(null);
    setDraft("");
    if (name.length === 0) return false;
    if (current.id === "") {
      createVariant(name);
      return true;
    }
    renameVariant(current.id, name);
    return false;
  }, [createVariant, renameVariant]);

  const commitName = () => {
    // Creating activates the new variant, so there is nothing left to pick.
    if (commitPending()) setOpen(false);
  };

  const cancelName = () => {
    pending.current = null;
    setRenaming(null);
    setDraft("");
  };

  /** Enter commits, Escape abandons — and Escape must not also close the
   *  menu, or cancelling a rename would lose your place. */
  const onNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitName();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelName();
    }
  };

  React.useEffect(() => {
    if (!open) return;
    // Clicking away commits whatever was typed, then closes — the same
    // outcome as tabbing out, so the gesture never silently discards a name.
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (buttonRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      commitPending();
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, commitPending]);

  const nameField = (testId: string, placeholder: string) => (
    <input
      className="input variant-menu__name-input"
      data-testid={testId}
      aria-label={placeholder}
      placeholder={placeholder}
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onNameKeyDown}
      onBlur={commitName}
    />
  );

  return (
    <div className="variant-picker">
      <button
        ref={buttonRef}
        type="button"
        className="variant-picker__button"
        data-testid="variant-picker"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Active simulation variant"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="variant-picker__name">{active.name}</span>
        {active.changes > 0 && (
          <span className="variant-picker__changes">
            {active.changes} change{active.changes === 1 ? "" : "s"}
          </span>
        )}
        <span className="variant-picker__count">
          {entries.findIndex((e) => e.id === active.id) + 1} of {entries.length}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            ref={panelRef}
            className="variant-menu"
            data-testid="variant-menu"
            role="listbox"
            aria-label="Simulation variants"
            style={{
              position: "fixed",
              top: anchor.top,
              left: anchor.left,
              minWidth: anchor.width,
            }}
          >
            {entries.map((entry) => (
              <div
                key={entry.id ?? "base"}
                className={
                  entry.id === active.id
                    ? "variant-menu__row variant-menu__row--active"
                    : "variant-menu__row"
                }
                role="option"
                aria-selected={entry.id === active.id}
              >
                {renaming === entry.id && entry.id !== null ? (
                  nameField(`variant-rename-input-${entry.id}`, "Variant name")
                ) : (
                  <>
                    <button
                      type="button"
                      className="variant-menu__pick"
                      data-testid={`variant-option-${entry.id ?? "base"}`}
                      onClick={() => choose(entry.id)}
                    >
                      <span className="variant-menu__label">{entry.name}</span>
                      <span className="variant-menu__meta">
                        {entry.changes > 0 && (
                          <span>{entry.changes} changes</span>
                        )}
                        {entry.runs > 0 && (
                          <span>
                            {entry.runs} run{entry.runs === 1 ? "" : "s"}
                          </span>
                        )}
                        {entry.outcome && (
                          <StatusIcon
                            status={entry.outcome === "ok" ? "ok" : "error"}
                            title={
                              entry.outcome === "ok"
                                ? "Last run converged"
                                : "Last run did not converge"
                            }
                          />
                        )}
                      </span>
                    </button>
                    <span className="variant-menu__actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        title="Duplicate"
                        aria-label={`Duplicate ${entry.name}`}
                        data-testid={`variant-duplicate-${entry.id ?? "base"}`}
                        onClick={() => {
                          duplicateVariant(entry.id);
                          setOpen(false);
                        }}
                      >
                        ⧉
                      </button>
                      {entry.id !== null && (
                        <>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            title="Rename"
                            aria-label={`Rename ${entry.name}`}
                            data-testid={`variant-rename-${entry.id}`}
                            onClick={() => startRename(entry.id!, entry.name)}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            title="Delete this variant and its runs"
                            aria-label={`Delete ${entry.name}`}
                            data-testid={`variant-delete-${entry.id}`}
                            onClick={() => deleteVariant(entry.id!)}
                          >
                            ×
                          </button>
                        </>
                      )}
                    </span>
                  </>
                )}
              </div>
            ))}
            {renaming === "" ? (
              <div className="variant-menu__row">
                {nameField("variant-new-input", "New variant name")}
              </div>
            ) : (
              <button
                type="button"
                className="variant-menu__new"
                data-testid="variant-new"
                onClick={() => {
                  setRenaming("");
                  setDraft(`Variant ${entries.length}`);
                }}
              >
                + New variant from current
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
