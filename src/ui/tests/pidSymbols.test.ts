import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import PidSymbol, {
  hasPidSymbol,
  PidEdgeSymbol,
  DIRECTIONAL_PID_SYMBOLS,
  isDirectionalSymbol,
  edgeSymbolRotation,
} from "../components/PidSymbol";
import {
  BRANCH_COMPONENTS,
  CONDUCTORS,
  componentSymbol,
} from "../componentRegistry";
import { EDGE_GLYPH_MIN_RUN } from "../canvasGeometry";

describe("PidSymbol", () => {
  it("covers every registry branch component with a dedicated symbol", () => {
    for (const c of BRANCH_COMPONENTS) {
      expect(
        hasPidSymbol(c.id),
        `missing PidSymbol case for branch component "${c.id}"`,
      ).toBe(true);
    }
  });

  it("covers every registry conductor kind with a dedicated symbol", () => {
    for (const c of CONDUCTORS) {
      expect(
        hasPidSymbol(c.id),
        `missing PidSymbol case for conductor "${c.id}"`,
      ).toBe(true);
    }
  });

  it("renders an svg for every registry id", () => {
    for (const c of [...BRANCH_COMPONENTS, ...CONDUCTORS]) {
      const markup = renderToStaticMarkup(
        React.createElement(PidSymbol, { kind: c.id }),
      );
      expect(markup).toContain("<svg");
      expect(markup).toContain("currentColor");
    }
  });

  it("is aria-hidden decoration unless given a title", () => {
    const decorative = renderToStaticMarkup(
      React.createElement(PidSymbol, { kind: "valve" }),
    );
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain("<title>");
    const labelled = renderToStaticMarkup(
      React.createElement(PidSymbol, { kind: "valve", title: "Valve" }),
    );
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain("<title>Valve</title>");
  });

  it("renders a dashed placeholder (not a crash) for unknown kinds", () => {
    expect(hasPidSymbol("fluxCapacitor")).toBe(false);
    const markup = renderToStaticMarkup(
      React.createElement(PidSymbol, { kind: "fluxCapacitor" }),
    );
    expect(markup).toContain("stroke-dasharray");
  });
});

describe("edgeSymbolRotation", () => {
  it("points directional symbols down-run and flips them on reversed flow", () => {
    for (const kind of DIRECTIONAL_PID_SYMBOLS) {
      expect(edgeSymbolRotation(kind, 0, false), kind).toBe(0);
      expect(edgeSymbolRotation(kind, 0, true), kind).toBe(180);
      // Leftward run: symbol points left; reversed flow points it right.
      expect(edgeSymbolRotation(kind, 180, false), kind).toBe(180);
      expect(edgeSymbolRotation(kind, 180, true), kind).toBe(0);
    }
  });

  it("keeps non-directional symbols upright (never upside down)", () => {
    const neutral = [
      "valve",
      "orifice",
      "resistance",
      "heatedPipe",
      "dpTable",
      "userComponent",
      "conduction",
      "convection",
      "radiation",
    ];
    for (const kind of neutral) {
      expect(isDirectionalSymbol(kind)).toBe(false);
      for (const angle of [-170, -90, -45, 0, 45, 90, 135, 180, 270]) {
        const rot = edgeSymbolRotation(kind, angle, false);
        expect(rot, `${kind} @ ${angle}°`).toBeGreaterThan(-90);
        expect(rot, `${kind} @ ${angle}°`).toBeLessThanOrEqual(90);
      }
    }
  });

  it("leaves non-directional symbols unchanged under reversed flow", () => {
    for (const kind of ["valve", "orifice", "resistance", "bend"]) {
      expect(edgeSymbolRotation(kind, 35, true)).toBe(
        edgeSymbolRotation(kind, 35, false),
      );
      expect(edgeSymbolRotation(kind, 215, true)).toBe(
        edgeSymbolRotation(kind, 215, false),
      );
    }
  });

  it("rotates with the run for vertical connections", () => {
    // Source above target (y down): run angle +90, pump points down-run.
    expect(edgeSymbolRotation("pump", 90, false)).toBe(90);
    expect(edgeSymbolRotation("valve", 90, false)).toBe(90);
    // -90° ≡ 90° (mod 180°) for a direction-neutral glyph — same line axis.
    expect(edgeSymbolRotation("valve", -90, false)).toBe(90);
  });
});

describe("PidEdgeSymbol (on-line glyph)", () => {
  const LONG_RUN = 160;

  it("renders a glyph on the run midpoint for every non-pipe registry type", () => {
    for (const c of BRANCH_COMPONENTS) {
      const kind = componentSymbol(c.id);
      const markup = renderToStaticMarkup(
        React.createElement(PidEdgeSymbol, {
          kind,
          edgeId: c.id,
          x: 80,
          y: 40,
          angleDeg: 0,
          runLength: LONG_RUN,
          color: "#fff",
        }),
      );
      if (c.id === "pipe") {
        // A plain pipe run carries no midpoint glyph — the line IS the symbol.
        expect(markup, "pipe must render no on-line glyph").toBe("");
        continue;
      }
      expect(markup, c.id).toContain(`data-testid="edge-symbol-${c.id}"`);
      expect(markup, c.id).toContain("translate(80 40)");
      expect(markup, c.id).toContain('aria-hidden="true"');
      expect(markup, c.id).toContain("<svg");
    }
  });

  it("renders a glyph for every conductor kind", () => {
    for (const c of CONDUCTORS) {
      const markup = renderToStaticMarkup(
        React.createElement(PidEdgeSymbol, {
          kind: c.id,
          edgeId: c.id,
          x: 10,
          y: 20,
          angleDeg: 90,
          runLength: LONG_RUN,
          color: "#fff",
        }),
      );
      expect(markup, c.id).toContain(`data-symbol="${c.id}"`);
      expect(markup, c.id).toContain("rotate(90)");
    }
  });

  it("hides the glyph when the run is too short and shrinks it on mid runs", () => {
    const hidden = renderToStaticMarkup(
      React.createElement(PidEdgeSymbol, {
        kind: "valve",
        x: 0,
        y: 0,
        angleDeg: 0,
        runLength: EDGE_GLYPH_MIN_RUN - 1,
        color: "#fff",
      }),
    );
    expect(hidden).toBe("");
    const shrunk = renderToStaticMarkup(
      React.createElement(PidEdgeSymbol, {
        kind: "valve",
        x: 0,
        y: 0,
        angleDeg: 0,
        runLength: 50,
        color: "#fff",
      }),
    );
    const m = shrunk.match(/scale\(([\d.]+)\)/);
    expect(m).toBeTruthy();
    expect(parseFloat(m![1])).toBeLessThan(1);
  });

  it("marks directional glyphs and flips them when reversed", () => {
    const fwd = renderToStaticMarkup(
      React.createElement(PidEdgeSymbol, {
        kind: "pump",
        x: 0,
        y: 0,
        angleDeg: 0,
        runLength: LONG_RUN,
        color: "#fff",
      }),
    );
    expect(fwd).toContain('data-directional="true"');
    expect(fwd).toContain("rotate(0)");
    expect(fwd).not.toContain("data-reversed");
    const rev = renderToStaticMarkup(
      React.createElement(PidEdgeSymbol, {
        kind: "pump",
        x: 0,
        y: 0,
        angleDeg: 0,
        runLength: LONG_RUN,
        color: "#fff",
        reversed: true,
      }),
    );
    expect(rev).toContain('data-reversed="true"');
    expect(rev).toContain("rotate(180)");
  });

  it("inherits the passed color via currentColor styling", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PidEdgeSymbol, {
        kind: "valve",
        x: 0,
        y: 0,
        angleDeg: 0,
        runLength: LONG_RUN,
        color: "rgb(1, 2, 3)",
      }),
    );
    expect(markup).toContain("color:rgb(1, 2, 3)");
  });
});
