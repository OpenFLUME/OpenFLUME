import React from "react";
import { createPortal } from "react-dom";
import {
  referenceSource,
  type FormulaAccessor,
  type FormulaCatalog,
} from "../formulaCompletion";
import {
  anchoredPlacement,
  clampBrowserPosition,
  draggedPlacement,
  type BrowserPosition,
} from "../formulaBrowserLayout";

const ACCESSOR_LABELS: Record<FormulaAccessor, string> = {
  pipe: "Pipes",
  heatedPipe: "Heated pipes",
  bend: "Bends",
  branch: "Other branches",
  node: "Fluid nodes",
  conductor: "Conductors",
  solid: "Solid nodes",
  reg: "Registers",
};

export default function FormulaBrowser({
  catalog,
  anchor,
  dataTestId,
  onInsert,
  onClose,
}: {
  catalog: FormulaCatalog;
  anchor: DOMRect;
  dataTestId?: string;
  onInsert: (source: string, caretOffset?: number) => void;
  onClose: () => void;
}) {
  const [section, setSection] = React.useState<"values" | "functions">(
    "values",
  );
  /** Where the user dragged the panel; null while it follows its anchor. */
  const [position, setPosition] = React.useState<BrowserPosition | null>(null);
  /** Grab point inside the panel, set for the duration of a drag. */
  const [grab, setGrab] = React.useState<{ x: number; y: number } | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // The panel's own body scrolls, and a capture-phase listener sees that
    // too — only a scroll of the surrounding page invalidates the placement.
    const onViewportChange = (event: Event) => {
      const inside = rootRef.current?.contains(event.target as Node);
      if (event.type === "scroll" && inside) return;
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [onClose]);

  React.useEffect(() => {
    if (!grab) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const onMove = (event: MouseEvent) => {
      setPosition(
        clampBrowserPosition(
          { left: event.clientX - grab.x, top: event.clientY - grab.y },
          viewport,
        ),
      );
    };
    const onUp = () => setGrab(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [grab]);

  /** Pin the current on-screen box first, so the panel never jumps when a
   *  drag starts from an upward-flipped (bottom-anchored) placement. */
  const startDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    setPosition({ left: bounds.left, top: bounds.top });
    setGrab({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  };

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const style: React.CSSProperties = {
    position: "fixed",
    zIndex: 130,
    ...(position
      ? draggedPlacement(position, viewport)
      : anchoredPlacement(anchor, viewport)),
  };
  const insert = (source: string, caretOffset?: number) => {
    onInsert(source, caretOffset);
    onClose();
  };

  return createPortal(
    <div
      ref={rootRef}
      className="formula-browser"
      style={style}
      role="dialog"
      aria-label="Formula options"
      data-testid={dataTestId ? `${dataTestId}-browser` : undefined}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        className="formula-browser__header"
        title="Drag to move"
        data-testid={dataTestId ? `${dataTestId}-browser-handle` : undefined}
        onMouseDown={startDrag}
      >
        <div>
          <div className="formula-browser__title">Build a formula</div>
          <div className="formula-browser__hint">
            Choose an option; the syntax is added for you.
          </div>
        </div>
        <div className="formula-browser__header-actions">
          <span className="formula-browser__grip" aria-hidden="true">
            ⋮⋮
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label="Close formula options"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>
      <div
        className="formula-browser__tabs"
        role="tablist"
        aria-label="Formula option categories"
      >
        <button
          type="button"
          role="tab"
          aria-selected={section === "values"}
          onClick={() => setSection("values")}
        >
          Model values
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "functions"}
          onClick={() => setSection("functions")}
        >
          Functions
        </button>
      </div>
      <div className="formula-browser__body">
        {section === "values" ? (
          catalog.accessors.map(({ name, signature }) => {
            const accessor = name as FormulaAccessor;
            const entities = catalog.entities[accessor];
            if (!entities.length) return null;
            return (
              <section className="formula-browser__section" key={name}>
                <div className="formula-browser__section-title">
                  <span>{ACCESSOR_LABELS[accessor]}</span>
                  <code>{signature}</code>
                </div>
                {entities.map((entity) => (
                  <div
                    className="formula-browser__entity"
                    key={`${name}:${entity.id}`}
                  >
                    <div className="formula-browser__entity-title">
                      <span>{entity.id}</span>
                      <span>{entity.detail}</span>
                    </div>
                    <div className="formula-browser__choices">
                      {entity.properties.length ? (
                        entity.properties.map((property) => {
                          const source = referenceSource(
                            entity.accessor,
                            entity.id,
                            property.path,
                          );
                          return (
                            <button
                              type="button"
                              key={property.path.join(".")}
                              title={source}
                              data-testid={
                                dataTestId
                                  ? `${dataTestId}-browser-value`
                                  : undefined
                              }
                              onClick={() => insert(source)}
                            >
                              <span>{property.path.join(".")}</span>
                              <small>{property.detail}</small>
                            </button>
                          );
                        })
                      ) : (
                        <button
                          type="button"
                          title={referenceSource(entity.accessor, entity.id)}
                          data-testid={
                            dataTestId
                              ? `${dataTestId}-browser-value`
                              : undefined
                          }
                          onClick={() =>
                            insert(referenceSource(entity.accessor, entity.id))
                          }
                        >
                          <span>value</span>
                          <small>{entity.detail}</small>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            );
          })
        ) : (
          <>
            <FunctionSection
              title="Geometry helpers"
              items={catalog.helpers}
              onInsert={insert}
            />
            <FunctionSection
              title="Math"
              items={catalog.builtins}
              onInsert={insert}
            />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function FunctionSection({
  title,
  items,
  onInsert,
}: {
  title: string;
  items: FormulaCatalog["helpers"];
  onInsert: (source: string, caretOffset?: number) => void;
}) {
  return (
    <section className="formula-browser__section">
      <div className="formula-browser__section-title">
        <span>{title}</span>
      </div>
      <div className="formula-browser__function-list">
        {items.map((item) => {
          const source = item.name === "pi" ? "pi" : `${item.name}()`;
          const caret = item.name === "pi" ? source.length : source.length - 1;
          return (
            <button
              type="button"
              key={item.name}
              onClick={() => onInsert(source, caret)}
            >
              <code>{item.signature}</code>
              <span>{item.detail}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
