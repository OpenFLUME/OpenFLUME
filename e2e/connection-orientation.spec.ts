import { test, expect, Page } from "@playwright/test";

/**
 * Geometry-aware connection orientation.
 *
 * Edges must leave/enter through the node sides that face each other
 * (left→right layouts connect Right→Left, vertical layouts Bottom→Top or
 * Top→Bottom), and must re-orient when nodes move. Assertions use the
 * deterministic data-source-side / data-target-side attributes rendered on a
 * <g> wrapper inside each edge, plus screenshots for visual review.
 */

function attachConsoleWatcher(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    errors.push(err.message);
  });
  return {
    assertNoErrors() {
      expect(errors).toEqual([]);
    },
  };
}

/** Locator for the orientation marker <g> of one edge. */
function edgeSides(page: Page, edgeId: string) {
  return page.locator(`[data-testid="rf__edge-${edgeId}"] [data-source-side]`);
}

async function expectSides(
  page: Page,
  edgeId: string,
  sourceSide: string,
  targetSide: string,
) {
  const g = edgeSides(page, edgeId);
  await expect(g).toHaveAttribute("data-source-side", sourceSide);
  await expect(g).toHaveAttribute("data-target-side", targetSide);
}

/** Set a node's canvas position through the property panel (deterministic). */
async function setNodePosition(
  page: Page,
  nodeTestId: string,
  x: number,
  y: number,
) {
  await page.locator(`[data-testid="${nodeTestId}"]`).click();
  await page.locator('label:has-text("X") + input').fill(String(x));
  await page.locator('label:has-text("Y") + input').fill(String(y));
  await page.waitForTimeout(200);
}

/**
 * Collapse the bottom-left Add Elements panel so canvas elements passing
 * behind it (drag targets, subnetwork Open buttons) stay clickable.
 */
async function collapseAddElements(page: Page) {
  const toggle = page.locator(".canvas-action-panel__toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "true") {
    await toggle.click();
    await page.waitForTimeout(150);
  }
}

/** Drag a node by a screen-space delta using its current bounding box. */
async function dragNodeBy(
  page: Page,
  nodeTestId: string,
  dx: number,
  dy: number,
) {
  const node = page.locator(`[data-testid="${nodeTestId}"]`);
  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test.describe("Connection orientation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. Left-to-right example exits nodes horizontally", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Heated pipe with radiating wall (conjugate HT)");
    await page.waitForTimeout(600);

    // Every fluid branch in this example flows left → right along y = 300.
    for (const id of ["b_in", "b_mid", "b_out"]) {
      await expectSides(page, id, "right", "left");
    }

    // The bezier path for edge b_in must leave the source heading right:
    // it starts at the right edge of the inlet node (x > node left).
    await page.screenshot({ path: "test-results/orientation-heated-pipe.png" });
    consoleWatcher.assertNoErrors();
  });

  test("2. Water distribution network reads left to right", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Water distribution network");
    await page.waitForTimeout(600);

    await expectSides(page, "pump", "right", "left"); // SRC → N0
    await expectSides(page, "main", "right", "left"); // N0 → N1
    await expectSides(page, "leg2_p", "right", "left"); // N1 → N3 (same row)
    await expectSides(page, "dis_low", "right", "left"); // N6 → D_LOW

    await page.screenshot({
      path: "test-results/orientation-water-distribution.png",
    });
    consoleWatcher.assertNoErrors();
  });

  test("3. Vertical/thermal connections attach bottom-top / top-bottom", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Heated pipe with radiating wall (conjugate HT)");
    await page.waitForTimeout(600);

    // Convection conductors drop straight DOWN from each wall (y = 150) to
    // the fluid node below (y = 300): source bottom, target top.
    await expectSides(page, "c1", "bottom", "top"); // w1 → f1
    await expectSides(page, "c2", "bottom", "top"); // w2 → f2
    // Radiation conductors go UP from the walls to the ambient node (y = 0):
    // source top, target bottom.
    await expectSides(page, "c4", "top", "bottom"); // w1 → amb
    await expectSides(page, "c5", "top", "bottom"); // w2 → amb
    // Same-row connections stay horizontal.
    await expectSides(page, "c3", "right", "left"); // w1 → w2 (wall conduction)
    await expectSides(page, "b_in", "right", "left"); // in → f1
    await expectSides(page, "b_mid", "right", "left"); // f1 → f2
    await expectSides(page, "b_out", "right", "left"); // f2 → out

    await page.screenshot({
      path: "test-results/orientation-conjugate-wall.png",
    });
    consoleWatcher.assertNoErrors();
  });

  test("4. Orientation recomputes when a node is dragged below/above", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Two boundary nodes side by side: B1 left, B2 right. Positions keep the
    // vertical drag path clear of the bottom-left Add Elements panel.
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await setNodePosition(page, "node-B1", 500, 200);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await setNodePosition(page, "node-B2", 640, 200);
    await collapseAddElements(page);

    // Pipe B1 → B2 via the palette tool.
    await page.locator('[data-testid="palette-pipe"]').click();
    await page.locator('[data-testid="node-B1"]').click();
    await page.locator('[data-testid="node-B2"]').click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch:",
    );

    // Horizontal neighbours: Right → Left.
    await expectSides(page, "b1", "right", "left");
    await page.screenshot({
      path: "test-results/orientation-drag-1-horizontal.png",
    });

    // Drag B2 straight down: Bottom → Top. Deltas are sized to clear the
    // 1.25 dominance band (dx = 140 → threshold 175 flow units) whether the
    // initial fit left the viewport at zoom 1 or the 1.25 cap.
    await dragNodeBy(page, "node-B2", 0, 320);
    await expectSides(page, "b1", "bottom", "top");
    await page.screenshot({
      path: "test-results/orientation-drag-2-below.png",
    });

    // Drag B2 up past B1: Top → Bottom.
    await dragNodeBy(page, "node-B2", 0, -560);
    await expectSides(page, "b1", "top", "bottom");
    await page.screenshot({
      path: "test-results/orientation-drag-3-above.png",
    });

    consoleWatcher.assertNoErrors();
  });

  test("5. Group container edge uses container geometry", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Four nodes; B1+B4 become a subnetwork on the left.
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await setNodePosition(page, "node-B1", 300, 400);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await setNodePosition(page, "node-B2", 500, 400);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await setNodePosition(page, "node-B3", 700, 400);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await setNodePosition(page, "node-B4", 300, 560);

    // Group B1 + B4 (the Create subnetwork button lives in the Add Elements
    // panel — collapse it only afterwards so it can't cover the container's
    // Open button).
    await page.locator('[data-testid="node-B1"]').click();
    await page.waitForTimeout(200);
    await page
      .locator('[data-testid="node-B4"]')
      .click({ modifiers: ["Shift"] });
    await page.waitForTimeout(200);
    await page.locator('[data-testid="create-subnetwork"]').click();
    await page.waitForTimeout(500);
    await collapseAddElements(page);

    // Pipe B2 → B3, then retarget its To end to B1 (inside the subnetwork).
    await page.locator('[data-testid="palette-pipe"]').click();
    await page.locator('[data-testid="node-B2"]').click();
    await page.locator('[data-testid="node-B3"]').click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch:",
    );
    await page.locator('[data-testid="branch-to-select"]').selectOption("B1");
    await page.waitForTimeout(400);

    // B2 (x≈524 center) sits RIGHT of the group container (center x≈300):
    // the edge must leave B2's LEFT side and enter the container's RIGHT side.
    await expectSides(page, "b1", "left", "right");
    await page.screenshot({ path: "test-results/orientation-group-edge.png" });

    // Inside the subnetwork tab the same branch runs ghost-B2 → B1 and is
    // oriented from the rendered ghost/member geometry: ghost right of B1.
    await page.locator('[data-testid^="open-subnetwork-"]').first().click();
    await page.waitForTimeout(500);
    await expect(
      page.locator('[data-testid="ghost-node-ghost-B2"]'),
    ).toBeVisible();
    await expectSides(page, "b1", "left", "right");
    await page.screenshot({ path: "test-results/orientation-ghost-edge.png" });

    consoleWatcher.assertNoErrors();
  });

  test("6. Reversed solved flow: no arrowheads, dashed run, flipped directional symbol", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // B1 low pressure on the left, B2 high pressure on the right.
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await setNodePosition(page, "node-B1", 300, 300);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await setNodePosition(page, "node-B2", 500, 300);
    await page.locator('label:has-text("Pressure") + input').fill("300000");
    await page.locator('label:has-text("Pressure") + input').blur();
    await page.waitForTimeout(200);

    // Pipe b1 is declared B1 → B2, but pressure drives B2 → B1: mdot < 0.
    await page.locator('[data-testid="palette-pipe"]').click();
    await page.locator('[data-testid="node-B1"]').click();
    await page.locator('[data-testid="node-B2"]').click();
    await page.waitForTimeout(300);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );
    await page.locator('[data-testid="editor-tab"]').click();
    await page.waitForTimeout(300);

    // Geometry is untouched by the flow sign: still Right → Left. P&ID runs
    // carry NO arrowheads — neither end, and React Flow creates no marker
    // defs at all.
    await expectSides(page, "b1", "right", "left");
    const path = page.locator(
      '[data-testid="rf__edge-b1"] path.react-flow__edge-path',
    );
    expect(await path.getAttribute("marker-start")).toBeNull();
    expect(await path.getAttribute("marker-end")).toBeNull();
    await expect(page.locator(".react-flow marker")).toHaveCount(0);
    // The reversed-flow cue is the dashed run plus the signed ṁ readout.
    const dash = await path.evaluate((el) => el.style.strokeDasharray);
    expect(dash.replace(/[, ]+/g, " ")).toBe("6 4");
    await expect(page.locator('[data-testid="mdot-b1"]')).toContainText("-");
    // A pipe has no on-line glyph (the straight run IS the symbol).
    await expect(page.locator('[data-testid="edge-symbol-b1"]')).toHaveCount(0);
    await page.screenshot({
      path: "test-results/orientation-reversed-flow.png",
    });

    consoleWatcher.assertNoErrors();
  });

  test("7. Reversed flow flips a directional symbol (flow source)", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Deterministic model: a flow source with NEGATIVE mass flow solves to
    // mdot < 0, so its intrinsic-arrow glyph must flip toward the source.
    await page.evaluate(() => {
      const config = {
        meta: { name: "Reversed source", version: 2 },
        settings: {
          mode: "steady",
          tolerance: 1e-8,
          maxIterations: 60,
          relaxation: 0.7,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "bLo",
            type: "boundary",
            x: 120,
            y: 300,
            pressure: 100_000,
            temperature: 300,
            label: "Lo",
          },
          {
            id: "bHi",
            type: "boundary",
            x: 520,
            y: 300,
            pressure: 200_000,
            temperature: 300,
            label: "Hi",
          },
        ],
        branches: [
          {
            id: "src",
            from: "bLo",
            to: "bHi",
            component: { type: "flowSource", massFlow: -0.1 },
            label: "Src",
          },
        ],
      };
      localStorage.setItem("fluids-network-config-v1", JSON.stringify(config));
    });
    await page.reload();
    await page.waitForTimeout(500);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );
    await page.locator('[data-testid="editor-tab"]').click();
    await page.waitForTimeout(300);

    const symbol = page.locator('[data-testid="edge-symbol-src"]');
    await expect(symbol).toBeVisible();
    await expect(symbol).toHaveAttribute("data-symbol", "flowSource");
    await expect(symbol).toHaveAttribute("data-directional", "true");
    await expect(symbol).toHaveAttribute("data-reversed", "true");
    // Horizontal left→right run (angle ≈ 0): reversed flow flips the glyph
    // back toward the source (rotation ≈ 180°, tolerant of sub-pixel runs).
    const transform = await symbol.getAttribute("transform");
    const rotation = parseFloat(
      transform?.match(/rotate\((-?[\d.]+)\)/)?.[1] ?? "NaN",
    );
    expect(Math.abs(rotation - 180)).toBeLessThan(2);
    // Still no arrowheads — the flip replaces them.
    const path = page.locator(
      '[data-testid="rf__edge-src"] path.react-flow__edge-path',
    );
    expect(await path.getAttribute("marker-start")).toBeNull();
    expect(await path.getAttribute("marker-end")).toBeNull();
    await page.screenshot({ path: "test-results/pid-reversed-flowsource.png" });

    consoleWatcher.assertNoErrors();
  });
});
