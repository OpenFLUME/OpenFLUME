/**
 * Regenerate the user-manual UI screenshots.
 *
 *   npm run build && npx tsx scripts/capture-manual-figures.ts
 *
 * Serves dist/ on a loopback port, drives the built application with
 * Playwright's bundled Chromium, and writes the six figures referenced by
 * docs/user-manual.md into docs/figures/user-manual/:
 *
 *   first-run-orifice.png       §2.3 fig 2-1  orifice sanity check, branch selected
 *   tank-blowdown-results.png   §2.3 fig 2-2  Analysis tab after the transient
 *   tank-blowdown-scrubber.png  §2.3 fig 2-3  canvas colored by pressure + scrubber
 *   regen-cooling-canvas.png    §6.3 fig 6-1  conjugate model by temperature
 *   settings-dialog.png         §6.6 fig 6-2  Global Settings over the same model
 *   model-text-view.png         §6.10 fig 6-3 Model Text over the same model
 *
 * The figures are captured in ONE browser session, in the order the manual
 * presents them, so run numbering in the Analysis tab matches the walkthrough
 * (the tank blowdown is Run 2 because the orifice check was Run 1).
 *
 * Determinism notes: browser storage is cleared before the first example so an
 * autosaved model can never leak in, the pointer is parked over empty canvas
 * before each canvas shot so no hover chip is captured, and CSS animations are
 * disabled at capture time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "@playwright/test";
import { createServer } from "./serve";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const OUT_DIR = path.join(REPO_ROOT, "docs", "figures", "user-manual");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4176);

/** Logical viewport; figures are written at 2x for legible text when zoomed. */
const VIEWPORT = { width: 1400, height: 920 };
const SCALE = 2;

const STEADY_TIMEOUT = 30_000;
/** Spacecraft radiator is a real-fluid model: CoolProp init + solve. */
const REAL_FLUID_TIMEOUT = 180_000;

function testId(page: Page, id: string): Locator {
  return page.locator(`[data-testid="${id}"]`);
}

async function shoot(page: Page, name: string): Promise<void> {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  wrote docs/figures/user-manual/${name}.png (${kb} KB)`);
}

/** Park the pointer over empty canvas so no hover chip lands in the shot. */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height - 160);
  await page.waitForTimeout(150);
}

/**
 * Click an edge on the canvas by its element id. React Flow draws edges in a
 * transformed SVG layer, so the click goes through the pointer at the centre
 * of the edge's client rect rather than through the locator's own hit test.
 */
async function selectOnCanvas(page: Page, edgeId: string): Promise<void> {
  const rect = await page.evaluate((id) => {
    const path = document.querySelector<SVGPathElement>(
      `[data-testid="rf__edge-${id}"] .react-flow__edge-interaction`,
    );
    if (!path) return null;
    const { x, y, width, height } = path.getBoundingClientRect();
    return { x, y, width, height };
  }, edgeId);
  if (!rect) throw new Error(`Edge "${edgeId}" is not on the canvas.`);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.waitForTimeout(200);
}

async function loadExample(page: Page, name: string): Promise<void> {
  console.log(`- loading example "${name}"`);
  await testId(page, "toolbar-examples").selectOption(name);
  // Loading over an edited model asks for confirmation; a pristine one does not.
  const confirm = testId(page, "confirm-dialog-accept");
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.waitForTimeout(400);
}

async function runToCompletion(page: Page, timeout: number): Promise<string> {
  await testId(page, "toolbar-run").click();
  const status = testId(page, "toolbar-status");
  await status.waitFor({ state: "visible", timeout });
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="toolbar-status"]');
        return (
          !!el && /converged|steps|failed|diverged/i.test(el.textContent ?? "")
        );
      },
      undefined,
      { timeout },
    )
    .catch(() => {
      throw new Error("Run did not reach a terminal status in time.");
    });
  const text = ((await status.textContent()) ?? "").trim();
  console.log(`  run status: ${text}`);
  if (/failed|diverged/i.test(text)) {
    throw new Error(
      `Run did not converge — refusing to publish the figure. Status: ${text}`,
    );
  }
  // Let the canvas recolor and the charts settle before the shutter.
  await page.waitForTimeout(600);
  return text;
}

async function capture(baseURL: string): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  try {
    await page.goto(baseURL);
    // A restored autosave would put an arbitrary model on the canvas.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await testId(page, "toolbar-run").waitFor({
      state: "visible",
      timeout: 30_000,
    });

    // --- Figure 2-1: orifice sanity check, orifice branch selected -----------
    await loadExample(page, "Sanity: orifice hand-calc");
    await runToCompletion(page, STEADY_TIMEOUT);
    await selectOnCanvas(page, "o");
    await testId(page, "property-panel").waitFor({ state: "visible" });
    await parkPointer(page);
    await shoot(page, "first-run-orifice");

    // --- Figure 2-2: Analysis tab after the tank-blowdown transient ----------
    await loadExample(page, "Tank blowdown");
    await runToCompletion(page, STEADY_TIMEOUT);
    await testId(page, "results-tab").click();
    await testId(page, "channel-explorer-chart").waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await page.waitForTimeout(400);
    await shoot(page, "tank-blowdown-results");

    // --- Figure 2-3: canvas colored by pressure, with the time scrubber ------
    await testId(page, "editor-tab").click();
    await testId(page, "color-by-select").selectOption({ label: "Pressure" });
    await testId(page, "time-scrubber").waitFor({ state: "visible" });
    await testId(page, "canvas-legend").waitFor({ state: "visible" });
    await parkPointer(page);
    await shoot(page, "tank-blowdown-scrubber");

    // --- Figure 6-1: spacecraft radiator colored by temperature --------------
    await loadExample(
      page,
      "Spacecraft radiator panel (ammonia loop heat pipe)",
    );
    await runToCompletion(page, REAL_FLUID_TIMEOUT);
    await testId(page, "color-by-select").selectOption({
      label: "Temperature",
    });
    await testId(page, "canvas-legend").waitFor({ state: "visible" });
    await parkPointer(page);
    await shoot(page, "regen-cooling-canvas");

    // --- Figure 6-2: Global Settings over the same real-fluid model ----------
    await testId(page, "toolbar-settings").click();
    await testId(page, "settings-dialog").waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    await shoot(page, "settings-dialog");
    await testId(page, "settings-close").click();
    await testId(page, "settings-dialog").waitFor({ state: "hidden" });

    // --- Figure 6-3: Model Text over the same model --------------------------
    await testId(page, "canvas-text-view").click();
    await testId(page, "text-model-view").waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    await shoot(page, "model-text-view");

    if (consoleErrors.length > 0) {
      console.warn(
        `\n[capture] page reported ${consoleErrors.length} console error(s):`,
      );
      for (const err of consoleErrors.slice(0, 10)) console.warn(`  ${err}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
    throw new Error("dist/index.html is missing — run `npm run build` first.");
  }
  const server = createServer({
    port: PORT,
    host: HOST,
    distDir: DIST_DIR,
    libraryDir: path.join(REPO_ROOT, "library", "components"),
    allowRemoteWrites: false,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => resolve());
  });
  const baseURL = `http://${HOST}:${PORT}/`;
  console.log(`[capture] serving ${DIST_DIR} at ${baseURL}`);
  try {
    await capture(baseURL);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("[capture] done.");
}

main().catch((err) => {
  console.error(
    `[capture] fatal: ${err instanceof Error ? err.stack : String(err)}`,
  );
  process.exit(1);
});
