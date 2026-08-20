import type React from "react";

export const CANVAS_ELEMENT_MIME = "application/x-fluids-network-element";

export type CanvasElement =
  | "fluid:internal"
  | "fluid:boundary"
  | "solid:solid"
  | "solid:ambient"
  | "note";

/** Runtime allowlist — the drop payload is untrusted string data. */
const CANVAS_ELEMENTS: ReadonlySet<string> = new Set<CanvasElement>([
  "fluid:internal",
  "fluid:boundary",
  "solid:solid",
  "solid:ambient",
  "note",
]);

export function startCanvasElementDrag(
  event: React.DragEvent<HTMLElement>,
  element: CanvasElement,
): void {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(CANVAS_ELEMENT_MIME, element);
  event.dataTransfer.setData("text/plain", element);
}

export function canvasElementFromDrop(
  event: React.DragEvent<HTMLElement>,
): CanvasElement | null {
  const value = event.dataTransfer.getData(CANVAS_ELEMENT_MIME);
  return CANVAS_ELEMENTS.has(value) ? (value as CanvasElement) : null;
}
