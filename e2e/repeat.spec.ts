/**
 * e2e/repeat.spec.ts — the discretize/repeat feature:
 *
 *  1. Repeat happy path: a one-node unit chained to 3 total instances via
 *     the Repeat dialog creates the expected nodes/branches, announces the
 *     counts, and the repeated model still converges.
 *  2. A repeat is ONE undo step: Ctrl/Cmd+Z reverts the whole chain.
 *  3. A selection with no unambiguous seam (two branches enter the unit)
 *     leaves the Repeat menu action disabled with the reason as its tooltip.
 *  4. Split pipe: the property panel's Discretize section divides a pipe
 *     into N series segments (inserting mid nodes and seam pipes) and the
 *     model still runs.
 *  5. Persistence: a repeated model saves to the unchanged .fn format
 *     (parameter links included) and reloads to the same, still-solvable
 *     network.
 */
import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

async function captureTextDownload(
  page: Page,
  trigger: () => Promise<void>,
): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    trigger(),
  ]);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Download path is null");
  return fs.readFileSync(downloadPath, "utf-8");
}

/**
 * Collapse the bottom-left Add Elements panel so canvas elements passing
 * behind it stay clickable (same helper as connection-orientation.spec.ts).
 */
async function collapseAddElements(page: Page) {
  const toggle = page.locator(".canvas-action-panel__toggle");
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute("aria-expanded")) === "true") {
    await toggle.click();
    await page.waitForTimeout(150);
  }
}

/**
 * The minimal repeatable line: B1 --seg1--> n1 --tail--> B2.  The unit
 * {n1} has exactly one entry branch (seg1 — the seam) and one exit crossing
 * (tail), so Repeat is enabled on a plain node click.
 */
const REPEAT_LINE_CONFIG = {
  meta: { name: "Repeat line", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-8,
    maxIterations: 100,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "B1",
      type: "boundary",
      x: 250,
      y: 400,
      pressure: 200000,
      temperature: 300,
      label: "In",
    },
    {
      id: "n1",
      type: "internal",
      x: 450,
      y: 400,
      pressure: 150000,
      temperature: 300,
      volume: 0.001,
      label: "Seg 1",
    },
    {
      id: "B2",
      type: "boundary",
      x: 650,
      y: 400,
      pressure: 100000,
      temperature: 300,
      label: "Out",
    },
  ],
  branches: [
    {
      id: "seg1",
      from: "B1",
      to: "n1",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      label: "Seg pipe",
    },
    {
      id: "tail",
      from: "n1",
      to: "B2",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      label: "Tail",
    },
  ],
};

/** A merge: two branches enter node j, so no seam can be derived. */
const MERGE_CONFIG = {
  meta: { name: "Merge (no seam)", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-8,
    maxIterations: 100,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "B1",
      type: "boundary",
      x: 300,
      y: 280,
      pressure: 200000,
      temperature: 300,
      label: "In 1",
    },
    {
      id: "B2",
      type: "boundary",
      x: 300,
      y: 520,
      pressure: 180000,
      temperature: 300,
      label: "In 2",
    },
    {
      id: "j",
      type: "internal",
      x: 520,
      y: 400,
      pressure: 120000,
      temperature: 300,
      volume: 0.001,
      label: "Junction",
    },
    {
      id: "B3",
      type: "boundary",
      x: 740,
      y: 400,
      pressure: 100000,
      temperature: 300,
      label: "Out",
    },
  ],
  branches: [
    {
      id: "in1",
      from: "B1",
      to: "j",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      label: "In 1 pipe",
    },
    {
      id: "in2",
      from: "B2",
      to: "j",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      label: "In 2 pipe",
    },
    {
      id: "out",
      from: "j",
      to: "B3",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      label: "Out pipe",
    },
  ],
};

async function injectConfig(page: Page, config: unknown) {
  await page.evaluate((cfg) => {
    localStorage.setItem("fluids-network-config-v1", JSON.stringify(cfg));
  }, config);
  await page.reload();
  await page.waitForTimeout(500);
  await collapseAddElements(page);
}

/** Select a canvas node and wait for the property panel to confirm it. */
async function selectFluidNode(page: Page, id: string) {
  await page.locator(`[data-testid="node-${id}"]`).click();
  await expect(page.locator('[data-testid="property-panel"]')).toContainText(
    `Node: ${id}`,
  );
}

/** Select a branch by clicking its edge (retry — fitView can shift geometry). */
async function selectBranch(page: Page, id: string) {
  const edge = page.locator(`[data-testid="rf__edge-${id}"]`);
  const interaction = edge.locator("path.react-flow__edge-interaction");
  const target =
    (await interaction.count()) > 0
      ? interaction.first()
      : edge.locator("path.react-flow__edge-path");
  const panel = page.locator('[data-testid="property-panel"]');
  for (let attempt = 0; attempt < 5; attempt++) {
    const box = await target.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      if (
        await panel
          .getByText(`Branch: ${id}`)
          .isVisible()
          .catch(() => false)
      )
        return;
    }
    await page.waitForTimeout(200);
  }
  await expect(panel).toContainText(`Branch: ${id}`);
}

/** Run the whole Repeat dialog flow from the selected unit. */
async function repeatSelection(page: Page, count: string) {
  await page.locator('[data-testid="repeat-menu-action"]').click();
  await expect(page.locator('[data-testid="repeat-dialog"]')).toBeVisible();
  await page.locator('[data-testid="repeat-count"]').fill(count);
  await page.locator('[data-testid="repeat-dialog-accept"]').click();
  await expect(page.locator('[data-testid="repeat-dialog"]')).not.toBeVisible();
  await page.waitForTimeout(300);
}

test.describe("Repeat and split (discretize)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Reset units to SI default so existing assertions that hard-code SI inputs work
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. Repeat chains a unit into N instances; the model converges", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await injectConfig(page, REPEAT_LINE_CONFIG);

    const rfNodes = page.locator(".react-flow__node");
    const rfEdges = page.locator(".react-flow__edge");
    await expect(rfNodes).toHaveCount(3);
    await expect(rfEdges).toHaveCount(2);

    await selectFluidNode(page, "n1");
    const repeatAction = page.locator('[data-testid="repeat-menu-action"]');
    await expect(repeatAction).toBeEnabled();

    // The dialog previews what one more instance costs before committing.
    await repeatAction.click();
    await expect(page.locator('[data-testid="repeat-dialog"]')).toBeVisible();
    // Nothing references this unit, so there is no uncloned-record warning.
    await expect(
      page.locator('[data-testid="repeat-uncloned-warning"]'),
    ).toHaveCount(0);
    await page.locator('[data-testid="repeat-count"]').fill("3");
    await expect(page.locator('[data-testid="repeat-summary"]')).toContainText(
      "Creates 2 more instances: 2 nodes, 2 branches",
    );
    await page.locator('[data-testid="repeat-dialog-accept"]').click();
    await expect(
      page.locator('[data-testid="repeat-dialog"]'),
    ).not.toBeVisible();
    await page.waitForTimeout(300);

    // Two seam clones (seg2, seg3) and two node copies (n2, n3) appear; the
    // tail branch rewires onto the last instance.
    await expect(rfNodes).toHaveCount(5);
    await expect(rfEdges).toHaveCount(4);
    await expect(page.locator('[data-testid="node-n2"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-n3"]')).toBeVisible();
    await expect(page.locator('[data-testid="canvas-announce"]')).toContainText(
      "Repeated unit 3",
    );

    // The chained model (with parameter links to instance 1) still solves.
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    consoleWatcher.assertNoErrors();
  });

  test("2. A repeat reverts in a single undo step", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await injectConfig(page, REPEAT_LINE_CONFIG);

    const rfNodes = page.locator(".react-flow__node");
    const rfEdges = page.locator(".react-flow__edge");

    await selectFluidNode(page, "n1");
    await repeatSelection(page, "3");
    await expect(rfNodes).toHaveCount(5);
    await expect(rfEdges).toHaveCount(4);

    // One Ctrl/Cmd+Z removes every created entity at once.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    await expect(rfNodes).toHaveCount(3);
    await expect(rfEdges).toHaveCount(2);
    await expect(page.locator('[data-testid="node-n2"]')).toHaveCount(0);

    consoleWatcher.assertNoErrors();
  });

  test("3. Repeat is disabled with a reason when the seam is ambiguous", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await injectConfig(page, MERGE_CONFIG);

    // Two branches enter node j, so no single seam branch can be derived.
    await selectFluidNode(page, "j");
    const repeatAction = page.locator('[data-testid="repeat-menu-action"]');
    await expect(repeatAction).toBeDisabled();
    const tooltip = await repeatAction.getAttribute("title");
    expect(tooltip).toContain("Cannot repeat");
    expect(tooltip).toContain("multiple branches enter the unit");

    consoleWatcher.assertNoErrors();
  });

  test("4. Split pipe divides a branch into N segments; the model runs", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await injectConfig(page, REPEAT_LINE_CONFIG);

    const rfNodes = page.locator(".react-flow__node");
    const rfEdges = page.locator(".react-flow__edge");

    await selectBranch(page, "seg1");

    // The property panel's inline Discretize section: count, live summary,
    // and the divided-not-duplicated hint.
    const segments = page.locator('[data-testid="split-segments"]');
    await expect(segments).toBeVisible();
    await segments.fill("3");
    await expect(page.locator('[data-testid="split-summary"]')).toContainText(
      "Creates 2 new nodes and 2 new pipes",
    );
    await page.locator('[data-testid="split-apply"]').click();
    await page.waitForTimeout(300);

    // m1/m2 are the inserted mid nodes; seg1 survives as the last segment.
    await expect(rfNodes).toHaveCount(5);
    await expect(rfEdges).toHaveCount(4);
    await expect(page.locator('[data-testid="node-m1"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-m2"]')).toBeVisible();
    await expect(page.locator('[data-testid="canvas-announce"]')).toContainText(
      "Split seg1 into 3 segments",
    );

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    consoleWatcher.assertNoErrors();
  });

  test("5. A repeated model round-trips through the .fn format", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await injectConfig(page, REPEAT_LINE_CONFIG);

    await selectFluidNode(page, "n1");
    await repeatSelection(page, "3");

    const rfNodes = page.locator(".react-flow__node");
    await expect(rfNodes).toHaveCount(5);

    // Save (the user-facing format is the .fn text projection)
    const fnText = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="toolbar-save"]').click();
    });

    // The unchanged format carries the repeated network verbatim: 5 node and
    // 4 branch records, including the parameter link the dialog created.
    expect(fnText.startsWith("// Fluid Network config v2\n")).toBe(true);
    expect(fnText.match(/^node "/gm)?.length).toBe(5);
    expect(fnText.match(/^branch "/gm)?.length).toBe(4);
    expect(fnText).toContain('node "n3"');
    expect(fnText).toContain("pipe('seg1').length");

    // New network, then load the saved file back
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `repeat-${Date.now()}.fn`);
    fs.writeFileSync(tmpFile, fnText);

    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="node-n1"]')).not.toBeVisible();

    await page
      .locator('[data-testid="toolbar-load-input"]')
      .setInputFiles(tmpFile);
    await page.waitForTimeout(800);

    // The whole chain survived the round-trip and still solves.
    await expect(rfNodes).toHaveCount(5);
    await expect(page.locator('[data-testid="node-n2"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-n3"]')).toBeVisible();

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    fs.unlinkSync(tmpFile);

    consoleWatcher.assertNoErrors();
  });

  test("6. The Repeat dialog and Split section warn exactly when a controller references the unit", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    // The repeatable line, plus two PID controllers: one senses member n1,
    // one senses the seam pipe seg1's mass flow (transient mode, so the
    // controllers are valid).
    await injectConfig(page, {
      ...REPEAT_LINE_CONFIG,
      settings: {
        mode: "transient",
        dt: 0.1,
        endTime: 1,
        tolerance: 1e-8,
        maxIterations: 100,
      },
      controllers: [
        {
          id: "pid-heat",
          type: "pid",
          sense: { kind: "node", id: "n1", quantity: "pressure" },
          setpoint: 150000,
          gains: { kp: 1, ki: 0, kd: 0 },
          output: { kind: "heatInput", id: "n1" },
        },
        {
          id: "pid-flow",
          type: "pid",
          sense: { kind: "branch", id: "seg1", quantity: "massFlow" },
          setpoint: 0.1,
          gains: { kp: 1, ki: 0, kd: 0 },
          output: { kind: "boundaryPressure", id: "B1" },
        },
      ],
    });

    // Repeat dialog: the controller on member n1 is not cloned, and the
    // dialog says so before the user commits.
    await selectFluidNode(page, "n1");
    await page.locator('[data-testid="repeat-menu-action"]').click();
    await expect(page.locator('[data-testid="repeat-dialog"]')).toBeVisible();
    const warning = page.locator('[data-testid="repeat-uncloned-warning"]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Controller pid-heat");
    await expect(warning).toContainText("will not be copied");
    await expect(warning).toContainText("uncontrolled");
    await page.locator('[data-testid="repeat-dialog-cancel"]').click();

    // Split section: the controller sensing seg1 keeps tracking only the
    // last segment after a split — the section says so as well.
    await selectBranch(page, "seg1");
    const splitWarning = page.locator('[data-testid="split-uncloned-warning"]');
    await expect(splitWarning).toBeVisible();
    await expect(splitWarning).toContainText("Controller pid-flow");
    await expect(splitWarning).toContainText("last segment");

    consoleWatcher.assertNoErrors();
  });
});
