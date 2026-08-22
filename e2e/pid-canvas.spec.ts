import { test, expect, Page } from "@playwright/test";

/**
 * P&ID canvas visual overhaul — smoke coverage.
 *
 * Fluid branches are straight pipe runs with NO arrowheads; component
 * symbols sit on the run midpoint (valve = centered bow-tie; pipe = no
 * glyph); nodes render as compact glyphs (boundary 26px rounded square,
 * internal 22px junction dot, solid 26px diamond); result chips keep their
 * readouts beside the run without the duplicate in-chip icon.
 */

function attachConsoleWatcher(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
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

/** Deterministic steady model: boundary → pipe → internal → valve → boundary. */
async function seedPipeValveModel(page: Page) {
  await page.evaluate(() => {
    const config = {
      meta: { name: "PID smoke", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 120,
          y: 300,
          pressure: 300_000,
          temperature: 300,
          label: "In",
        },
        {
          id: "mid",
          type: "internal",
          x: 360,
          y: 300,
          pressure: 200_000,
          temperature: 300,
          volume: 0.05,
          label: "Mid",
        },
        {
          id: "out",
          type: "boundary",
          x: 600,
          y: 300,
          pressure: 100_000,
          temperature: 300,
          label: "Out",
        },
      ],
      branches: [
        {
          id: "bPipe",
          from: "in",
          to: "mid",
          component: {
            type: "pipe",
            length: 2,
            diameter: 0.03,
            roughness: 1e-5,
          },
          label: "Pipe",
        },
        {
          id: "bValve",
          from: "mid",
          to: "out",
          component: { type: "valve", area: 0.001, cd: 0.6, position: 1 },
          label: "Valve",
        },
      ],
    };
    localStorage.setItem("fluids-network-config-v1", JSON.stringify(config));
  });
  await page.reload();
  await page.waitForTimeout(600);
}

/** Parse `translate(x y)` / `translate(Xpx, Ypx)` out of a transform. */
function parseTranslate(
  transform: string | null,
): { x: number; y: number } | null {
  const m = transform?.match(
    /translate\((-?[\d.]+)(?:px)?[ ,]\s*(-?[\d.]+)(?:px)?\)/,
  );
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
}

/** Parse `rotate(deg)` out of a transform. */
function parseRotate(transform: string | null): number | null {
  const m = transform?.match(/rotate\((-?[\d.]+)\)/);
  return m ? parseFloat(m[1]) : null;
}

/** Parse `M sx,syL tx,ty` (single straight segment) out of a path d. */
function parseStraight(
  d: string | null,
): { sx: number; sy: number; tx: number; ty: number } | null {
  const m = d?.match(/^M\s*(-?[\d.]+),(-?[\d.]+)\s*L\s*(-?[\d.]+),(-?[\d.]+)$/);
  return m ? { sx: +m[1], sy: +m[2], tx: +m[3], ty: +m[4] } : null;
}

test.describe("P&ID canvas", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. Straight runs, no arrowheads, centered valve bow-tie, plain pipe", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await seedPipeValveModel(page);

    // No arrowheads anywhere: no marker defs, no marker attrs on any edge path.
    await expect(page.locator(".react-flow marker")).toHaveCount(0);
    const paths = page.locator(".react-flow__edge path.react-flow__edge-path");
    await expect(paths).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      expect(await paths.nth(i).getAttribute("marker-start")).toBeNull();
      expect(await paths.nth(i).getAttribute("marker-end")).toBeNull();
    }

    // Both runs are single straight segments (M x,y L x,y — no curves).
    const dPipe = await page
      .locator('[data-testid="rf__edge-bPipe"] path.react-flow__edge-path')
      .getAttribute("d");
    const dValve = await page
      .locator('[data-testid="rf__edge-bValve"] path.react-flow__edge-path')
      .getAttribute("d");
    const pipe = parseStraight(dPipe);
    const valve = parseStraight(dValve);
    expect(pipe, `pipe path "${dPipe}" is straight`).toBeTruthy();
    expect(valve, `valve path "${dValve}" is straight`).toBeTruthy();

    // Plain pipe: no midpoint glyph.
    await expect(page.locator('[data-testid="edge-symbol-bPipe"]')).toHaveCount(
      0,
    );

    // Valve: bow-tie symbol centered on the run midpoint, rotated parallel
    // to the run (nodes differ in size, so the run is not exactly level).
    const symbol = page.locator('[data-testid="edge-symbol-bValve"]');
    await expect(symbol).toBeVisible();
    await expect(symbol).toHaveAttribute("data-symbol", "valve");
    const transform = await symbol.getAttribute("transform");
    const runAngle =
      (Math.atan2(valve!.ty - valve!.sy, valve!.tx - valve!.sx) * 180) /
      Math.PI;
    const rotation = parseRotate(transform);
    expect(rotation).not.toBeNull();
    // Valve is direction-neutral: rotation matches the run angle (mod 180°).
    const axisDiff = Math.abs((((rotation! - runAngle) % 180) + 180) % 180);
    expect(Math.min(axisDiff, 180 - axisDiff)).toBeLessThan(0.01);
    const center = parseTranslate(transform);
    expect(center).not.toBeNull();
    const midX = (valve!.sx + valve!.tx) / 2;
    const midY = (valve!.sy + valve!.ty) / 2;
    expect(Math.abs(center!.x - midX)).toBeLessThan(0.5);
    expect(Math.abs(center!.y - midY)).toBeLessThan(0.5);
    // Bow-tie = exactly two opposed triangles on the run.
    await expect(symbol.locator("polygon")).toHaveCount(2);
    await page.screenshot({ path: "test-results/pid-runs-valve.png" });

    consoleWatcher.assertNoErrors();
  });

  test("2. Compact node glyphs and practical handles/connection", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await seedPipeValveModel(page);

    // Compact glyph dimensions (flow units, zoom-independent inline styles):
    // boundary 26px, internal 22px junction dot.
    const dims = async (testid: string) =>
      page.locator(`[data-testid="${testid}"]`).evaluate((el) => ({
        w: (el as HTMLElement).style.width,
        h: (el as HTMLElement).style.height,
      }));
    expect(await dims("node-in")).toEqual({ w: "26px", h: "26px" });
    expect(await dims("node-mid")).toEqual({ w: "22px", h: "22px" });
    expect(await dims("node-out")).toEqual({ w: "26px", h: "26px" });

    // Handles still exist on every node (invisible until armed).
    await expect(
      page.locator('[data-testid="node-in"] [data-testid="handle-right"]'),
    ).toHaveCount(1);

    // Handle drag opens the connection chooser and creates the selected tie.
    await page.locator('[data-testid="toolbar-new"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    const sourceHandle = page
      .locator('[data-testid="node-B1"] [data-testid="handle-right"]')
      .first();
    const targetHandle = page
      .locator('[data-testid="node-B2"] [data-testid="handle-left"]')
      .first();
    await sourceHandle.dragTo(targetHandle, { timeout: 5000 });
    const chooser = page.getByRole("dialog", {
      name: "Choose connection type",
    });
    await chooser.getByRole("button", { name: "Pipe", exact: true }).click();
    await page.waitForTimeout(400);
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch:",
    );

    consoleWatcher.assertNoErrors();
  });

  test("3. Result chips: signed mdot, no duplicate icon, offset off the run", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await seedPipeValveModel(page);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );
    await page.locator('[data-testid="editor-tab"]').click();
    await page.waitForTimeout(300);

    // The edge hover chip keeps its label + signed ṁ readout, but carries no
    // duplicate svg symbol.
    const interaction = page.locator(
      '[data-testid="rf__edge-bValve"] path.react-flow__edge-interaction',
    );
    const interactionBox = await interaction.boundingBox();
    expect(interactionBox).not.toBeNull();
    await page.mouse.move(
      interactionBox!.x + interactionBox!.width / 2,
      interactionBox!.y + interactionBox!.height / 2,
    );
    const chip = page.locator('[data-testid="edge-chip-bValve"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Valve");
    await expect(page.locator('[data-testid="mdot-bValve"]')).toBeVisible();
    await expect(chip.locator("svg")).toHaveCount(0);
    // Accessible component name survives on the chip title.
    expect(await chip.getAttribute("title")).toBe("Valve");

    // The chip is offset perpendicular to the run, clear of the on-line glyph.
    const chipPos = parseTranslate(
      await page
        .locator('[data-testid="edge-chip-bValve"]')
        .evaluate((el) => (el.parentElement as HTMLElement).style.transform),
    );
    const d = await page
      .locator('[data-testid="rf__edge-bValve"] path.react-flow__edge-path')
      .getAttribute("d");
    const run = parseStraight(d);
    expect(chipPos).not.toBeNull();
    expect(run).not.toBeNull();
    // Perpendicular distance from chip anchor to the run segment (flow px).
    const dx = run!.tx - run!.sx;
    const dy = run!.ty - run!.sy;
    const len = Math.hypot(dx, dy);
    const dist =
      Math.abs(dx * (run!.sy - chipPos!.y) - (run!.sx - chipPos!.x) * dy) / len;
    expect(dist).toBeGreaterThan(8);
    // …and it is centered along the run (midpoint ± tolerance).
    const along =
      ((chipPos!.x - run!.sx) * dx + (chipPos!.y - run!.sy) * dy) / (len * len);
    expect(along).toBeGreaterThan(0.4);
    expect(along).toBeLessThan(0.6);

    consoleWatcher.assertNoErrors();
  });
});
