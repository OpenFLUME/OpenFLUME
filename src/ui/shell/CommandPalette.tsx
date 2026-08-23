/**
 * CommandPalette — Cmd/Ctrl+K launcher (shared by the Studio and
 * canvas-first shells).
 *
 * Two command sources, both computed on open (no background indexing):
 *   - static actions: run/cancel, place nodes, open settings/views, tabs;
 *   - dynamic "go to" entries for every model element (select + zoom).
 *
 * Deliberately shallow: one flat, filterable list with keyboard navigation.
 */
import React from "react";
import { useStore } from "../store";
import type { Selection } from "../types";
import { startRun, cancelRun } from "../runController";
import { createId } from "../utils";
import { canvasDropPosition } from "../dropPosition";

interface Command {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

export default function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Focus after the overlay paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Escape closes from anywhere — focus may sit outside the palette when it
  // was opened via the keyboard while the canvas held focus.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const commands = useCommands(onClose);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 30);
    return commands
      .filter((c) => `${c.label} ${c.keywords ?? ""}`.toLowerCase().includes(q))
      .slice(0, 30);
  }, [commands, query]);

  React.useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep the active row visible while arrowing through the list.
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[activeIndex];
      if (cmd) cmd.run();
    }
  };

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-label="Command palette"
        data-testid="command-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="command-palette__input"
          data-testid="command-palette-input"
          placeholder="Type a command or an element id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search commands"
        />
        {filtered.length === 0 ? (
          <div className="command-palette__empty">No matching commands.</div>
        ) : (
          <ul className="command-palette__list" ref={listRef} role="listbox">
            {filtered.map((cmd, i) => (
              <li key={cmd.id} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  className={
                    i === activeIndex
                      ? "command-palette__item command-palette__item--active"
                      : "command-palette__item"
                  }
                  data-testid={`command-${cmd.id}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={cmd.run}
                >
                  <span>{cmd.label}</span>
                  {cmd.hint && (
                    <span className="command-palette__item-hint">
                      {cmd.hint}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function useCommands(onClose: () => void): Command[] {
  const config = useStore((s) => s.config);
  const running = useStore((s) => s.running);

  return React.useMemo(() => {
    const store = useStore.getState();
    const done = (fn: () => void) => () => {
      fn();
      onClose();
    };
    const jump = (kind: Selection["kind"], id: string) =>
      done(() => {
        store.setActiveTab("editor");
        store.setActiveGroupTab(null);
        store.setSelection({ kind, id } as Selection);
        store.requestCanvasFocus(kind, id);
      });

    const allNodeIds = new Set([
      ...config.nodes.map((n) => n.id),
      ...(config.solidNodes ?? []).map((n) => n.id),
    ]);

    const placeFluidNode = (type: "internal" | "boundary") =>
      done(() => {
        const id = createId(type === "boundary" ? "B" : "N", allNodeIds);
        const pos = canvasDropPosition();
        store.setActiveTab("editor");
        store.addNode({
          id,
          type,
          x: pos.x,
          y: pos.y,
          label: id,
          ...(type === "boundary"
            ? { pressure: 101325, temperature: 293 }
            : { pressure: 101325, temperature: 293, volume: 0.1 }),
        });
        store.setSelection({ kind: "node", id });
      });

    const placeSolidNode = (type: "solid" | "ambient") =>
      done(() => {
        const id = createId(type === "ambient" ? "A" : "S", allNodeIds);
        const pos = canvasDropPosition();
        store.setActiveTab("editor");
        store.addSolidNode({
          id,
          type,
          x: pos.x,
          y: pos.y,
          label: id,
          temperature: 293,
          ...(type === "solid" ? { mass: 1, cp: 500 } : {}),
        });
        store.setSelection({ kind: "solidNode", id });
      });

    const commands: Command[] = [
      running
        ? {
            id: "cancel-run",
            label: "Cancel run",
            hint: "solver",
            run: done(() => cancelRun()),
          }
        : {
            id: "run",
            label: "Run simulation",
            hint: "solver",
            keywords: "solve start",
            run: done(() => void startRun()),
          },
      {
        id: "place-internal",
        label: "Place internal node",
        hint: "model",
        keywords: "add fluid node",
        run: placeFluidNode("internal"),
      },
      {
        id: "place-boundary",
        label: "Place boundary node",
        hint: "model",
        keywords: "add fluid node",
        run: placeFluidNode("boundary"),
      },
      {
        id: "place-solid",
        label: "Place solid node",
        hint: "model",
        keywords: "add thermal node",
        run: placeSolidNode("solid"),
      },
      {
        id: "place-ambient",
        label: "Place ambient node",
        hint: "model",
        keywords: "add thermal node",
        run: placeSolidNode("ambient"),
      },
      {
        id: "open-settings",
        label: "Go to Setup",
        hint: "view",
        keywords: "settings configuration solver physics fluids species units",
        run: done(() => store.setActiveTab("config")),
      },
      {
        id: "tab-model",
        label: "Go to Model canvas",
        hint: "view",
        run: done(() => {
          store.setActiveTab("editor");
          store.setActiveGroupTab(null);
        }),
      },
      {
        id: "tab-results",
        label: "Go to Results",
        hint: "view",
        keywords: "runs analysis plots history",
        run: done(() => store.setActiveTab("results")),
      },
      {
        id: "tab-sweep",
        label: "Go to Sweep",
        hint: "view",
        keywords: "parameter exploration",
        run: done(() => store.setActiveTab("sweep")),
      },
    ];

    for (const n of config.nodes) {
      commands.push({
        id: `goto-node-${n.id}`,
        label: `Go to node ${n.id}${n.label && n.label !== n.id ? ` (${n.label})` : ""}`,
        hint: n.type,
        keywords: "select jump",
        run: jump("node", n.id),
      });
    }
    for (const b of config.branches) {
      commands.push({
        id: `goto-branch-${b.id}`,
        label: `Go to branch ${b.id} (${b.from} → ${b.to})`,
        hint: b.component.type,
        keywords: "select jump",
        run: jump("branch", b.id),
      });
    }
    for (const n of config.solidNodes ?? []) {
      commands.push({
        id: `goto-solid-${n.id}`,
        label: `Go to solid node ${n.id}`,
        hint: n.type,
        keywords: "select jump thermal",
        run: jump("solidNode", n.id),
      });
    }
    for (const c of config.conductors ?? []) {
      commands.push({
        id: `goto-conductor-${c.id}`,
        label: `Go to conductor ${c.id} (${c.from} ↔ ${c.to})`,
        hint: c.type.kind,
        keywords: "select jump thermal",
        run: jump("conductor", c.id),
      });
    }

    return commands;
  }, [config, running, onClose]);
}
