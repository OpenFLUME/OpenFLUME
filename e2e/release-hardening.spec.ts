/**
 * Release-hardening regressions:
 *
 *  R1. Chart ULP crash kill chain — Extension: Cryo tank vent control (transient)
 *      → Run → pipe diameter 0.02→0.015 → Run. A rerun's temperature series
 *      (e.g. 300 vs 300.00000000000006) used to drive niceTicks into a
 *      sub-ULP step, an unbounded tick loop, RangeError, and a full white
 *      screen.
 *  R2. Toolbar geometry across the 760–1440px band: nothing overlaps, the
 *      Run button keeps a usable width, the status pill stays visible.
 *  R3. Complex example canvas layouts are readable (no coincident nodes).
 *  R4. A fresh empty model does not show "No branches defined" from live
 *      validation, but validation appears as soon as content is authored.
 *
 * Screenshots land in test-results/release-shots/ for review.
 */
import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { openAnalysisSection } from "./analysis";

const SHOTS = path.join("test-results", "release-shots");

function attachConsoleWatcher(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return {
    assertNoErrors() {
      expect(errors).toEqual([]);
    },
  };
}

test.describe("Release hardening", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("R1. transient run → edit branch diameter → rerun never crashes charts", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const consoleWatcher = attachConsoleWatcher(page);

    // Load a shipped transient example and run it.
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Extension: Cryo tank vent control (transient)");
    await page.waitForTimeout(300);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 20000 },
    );
    // Run history sits in the closed Runs disclosure of the Analysis view.
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "runs");
    await expect(page.locator('[data-testid="run-history-item"]')).toHaveCount(
      1,
    );

    // Edit the vent-valve area via the Model Table "Open in
    // properties" affordance (robust selector — no canvas hit-testing).
    await page.locator('[data-testid="editor-tab"]').click();
    await page.locator('[data-testid="canvas-table-view"]').click();
    await page.locator('[data-testid="mt-open-vent"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch: vent",
    );
    const area = page.getByRole("textbox", { name: /^Area \(/ }).first();
    await expect(area).toHaveText("5e-7");
    await area.click();
    await area.fill("4e-7");
    await area.press("Enter");
    await page.waitForTimeout(200);
    await expect(area).toHaveText("4e-7");

    // Rerun — the exact chain that used to white-screen the app.  The Model
    // Table round-trip remounted the Analysis view, so disclosures re-closed.
    await page.locator('[data-testid="toolbar-run"]').click();
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "runs");
    await expect(page.locator('[data-testid="run-history-item"]')).toHaveCount(
      2,
      { timeout: 20000 },
    );
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // The app shell survived: toolbar + tabs + charts all still render.
    // Full-network charts are the explorer's aggregate presets now — switch
    // the view dropdown to temperatures (no disclosure to open).
    await expect(page.locator('[data-testid="toolbar"]')).toBeVisible();
    await expect(page.locator('[data-testid="toolbar-run"]')).toBeVisible();
    await expect(page.locator('[data-testid="results-view"]')).toBeVisible();
    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption("node-solid-temperature");
    const tempChart = page.locator('[data-testid="channel-explorer-chart"]');
    await expect(tempChart).toBeVisible();
    // Temperature series rendered (polylines exist, ticks finite).
    await expect(tempChart.locator("polyline").first()).toBeAttached();
    await page.screenshot({
      path: path.join(SHOTS, "analysis-after-ulp-rerun.png"),
      fullPage: false,
    });

    consoleWatcher.assertNoErrors();
  });

  test("R2. toolbar never overlaps and Run stays usable at 760–1440px", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);

    const ids = [
      "toolbar-new",
      "toolbar-save",
      "toolbar-load-trigger",
      "toolbar-undo",
      "toolbar-redo",
      "toolbar-examples",
      "toolbar-unit-preset",
      "toolbar-settings",
      "toolbar-run",
      "toolbar-health",
    ];

    for (const width of [760, 800, 900, 1000, 1100, 1440]) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(150);

      type Box = { id: string; x: number; y: number; w: number; h: number };
      const boxes: Box[] = [];
      for (const id of ids) {
        const el = page.locator(`[data-testid="${id}"]`).first();
        if (!(await el.isVisible().catch(() => false))) continue;
        const b = await el.boundingBox();
        if (b && b.width > 0 && b.height > 0)
          boxes.push({ id, x: b.x, y: b.y, w: b.width, h: b.height });
      }

      // Run + status must be present at every width.
      const run = boxes.find((b) => b.id === "toolbar-run");
      const status = boxes.find((b) => b.id === "toolbar-health");
      expect(run, `Run visible at ${width}px`).toBeTruthy();
      expect(status, `status pill visible at ${width}px`).toBeTruthy();
      expect(run!.w, `Run width at ${width}px`).toBeGreaterThanOrEqual(40);
      expect(run!.h).toBeGreaterThanOrEqual(20);

      // No horizontal overlaps anywhere in the toolbar (1px tolerance).
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          expect(
            overlapX <= 1 || overlapY <= 1,
            `${width}px: ${a.id} (${a.x.toFixed(0)}..${(a.x + a.w).toFixed(0)}) overlaps ${b.id} (${b.x.toFixed(0)}..${(b.x + b.w).toFixed(0)})`,
          ).toBe(true);
        }
      }

      // Everything stays inside the toolbar's horizontal bounds.
      for (const b of boxes) {
        expect(b.x, `${width}px: ${b.id} left edge`).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w, `${width}px: ${b.id} right edge`).toBeLessThanOrEqual(
          width + 1,
        );
      }

      if (width === 800 || width === 900) {
        await page.screenshot({
          path: path.join(SHOTS, `toolbar-${width}.png`),
        });
      }
    }

    consoleWatcher.assertNoErrors();
  });

  test("R3. complex example layouts distribute stations (no coincident nodes)", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const consoleWatcher = attachConsoleWatcher(page);

    const noOverlaps = async () => {
      // Wait for fit-on-load to settle, then check node rects pairwise.
      const canvas = page.locator('[data-testid="flow-canvas"]');
      await expect(async () => {
        const c = await canvas.boundingBox();
        expect(c).not.toBeNull();
        const probe = await page.evaluate(() => {
          const els = [...document.querySelectorAll(".react-flow__node")];
          return els.length;
        });
        expect(probe).toBeGreaterThan(0);
      }).toPass({ timeout: 5000 });
      await page.waitForTimeout(400); // let fitView finish

      return page.evaluate(() => {
        const els = [...document.querySelectorAll(".react-flow__node")];
        const rects = els.map((el) => ({
          id:
            el.getAttribute("data-testid") || el.getAttribute("data-id") || "?",
          r: el.getBoundingClientRect(),
        }));
        const bad: string[] = [];
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i].r;
            const b = rects[j].r;
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (ox > 2 && oy > 2) bad.push(`${rects[i].id}×${rects[j].id}`);
          }
        }
        return { bad, count: rects.length };
      });
    };

    // Counterflow HX benchmark: 12 hot + 12 cold segment nodes at 70px pitch
    // plus 12 wall nodes on the middle row (38 canvas nodes total).
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Water-water counterflow heat exchanger");
    await page.waitForTimeout(400);
    const hx = await noOverlaps();
    expect(hx.count).toBeGreaterThanOrEqual(30); // 26 fluid + 12 wall nodes
    expect(hx.bad).toEqual([]);
    await page.screenshot({
      path: path.join(SHOTS, "gfssp-ex5-counterflow-hx.png"),
    });

    // NBS cryo-line cooldown (physical x coordinates stretched on load by
    // canvasLayout normalization). Not dirty → no confirm.
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Cryogenic line cooldown");
    await expect(
      page.locator('[data-testid="confirm-dialog-accept"]'),
    ).toHaveCount(0);
    await page.waitForTimeout(400);
    const nbsCooldown = await noOverlaps();
    expect(nbsCooldown.count).toBeGreaterThanOrEqual(40); // 20 fluid + 20 wall nodes + boundaries
    expect(nbsCooldown.bad).toEqual([]);
    await page.screenshot({
      path: path.join(SHOTS, "nbs-cryo-line-cooldown.png"),
    });

    consoleWatcher.assertNoErrors();
  });

  test("R4. fresh empty model stays quiet; validation appears once authoring", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Fresh Untitled model: no red "issues" pill from live validation.
    await page.locator('[data-testid="toolbar-new"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(600); // live-validation debounce is 300 ms
    await expect(page.locator('[data-testid="toolbar-health"]')).toContainText(
      "Ready to solve",
    );
    await expect(page.locator('[data-testid="toolbar-error"]')).toHaveCount(0);

    // Author one node → live validation kicks in quickly.
    await page.locator('[data-testid="add-internal-node"]').click();
    await expect(page.locator('[data-testid="toolbar-error"]')).toBeVisible({
      timeout: 3000,
    });

    consoleWatcher.assertNoErrors();
  });
});
