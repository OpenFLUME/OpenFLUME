/**
 * HoverCard — an instant, non-interactive detail panel anchored to a row.
 *
 * Portaled to document.body so it escapes the outline's `overflow: auto`
 * clipping (the same reason the toolbar's issues popover is portaled), and
 * positioned in viewport coordinates beside its anchor, flipping left and
 * clamping vertically when it would leave the window.
 *
 * Deliberately zero open delay — this is a reading aid while scanning a
 * list, so a hover intent delay would defeat it.
 */
import React from "react";
import { createPortal } from "react-dom";

const GAP = 8;
const MARGIN = 8;
const WIDTH = 260;

export interface HoverCardAnchor {
  rect: DOMRect;
}

export default function HoverCard({
  anchor,
  children,
}: {
  anchor: HoverCardAnchor | null;
  children: React.ReactNode;
}) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(
    null,
  );

  // Measure after paint: the card's height decides whether it can hang from
  // the row's top or must be clamped against the viewport bottom.
  React.useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    const height = cardRef.current?.offsetHeight ?? 0;
    const { rect } = anchor;
    let left = rect.right + GAP;
    if (left + WIDTH > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, rect.left - GAP - WIDTH);
    }
    let top = rect.top;
    if (height > 0 && top + height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - MARGIN - height);
    }
    setPos({ top, left });
  }, [anchor]);

  if (!anchor) return null;

  return createPortal(
    <div
      ref={cardRef}
      className="hover-card"
      data-testid="hover-card"
      role="tooltip"
      style={{
        position: "fixed",
        width: WIDTH,
        top: pos?.top ?? anchor.rect.top,
        left: pos?.left ?? anchor.rect.right + GAP,
        // Hidden for the single measuring frame so it never flashes in the
        // wrong place before the flip/clamp is known.
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
