import { describe, expect, it } from "vitest";
import type React from "react";
import {
  CANVAS_ELEMENT_MIME,
  canvasElementFromDrop,
  startCanvasElementDrag,
} from "../canvasDnd";

function dragEvent() {
  const data = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "none",
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
  return { dataTransfer } as unknown as React.DragEvent<HTMLElement>;
}

describe("canvas element drag data", () => {
  it("serializes and restores a supported node payload", () => {
    const event = dragEvent();
    startCanvasElementDrag(event, "fluid:boundary");

    expect(event.dataTransfer.effectAllowed).toBe("copy");
    expect(event.dataTransfer.getData(CANVAS_ELEMENT_MIME)).toBe(
      "fluid:boundary",
    );
    expect(canvasElementFromDrop(event)).toBe("fluid:boundary");
  });

  it("rejects unrelated drop payloads", () => {
    const event = dragEvent();
    event.dataTransfer.setData(CANVAS_ELEMENT_MIME, "component:pipe");

    expect(canvasElementFromDrop(event)).toBeNull();
  });
});
