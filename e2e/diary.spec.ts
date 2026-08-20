/**
 * e2e/diary.spec.ts — Solver-diary inspection UI end-to-end:
 *   1. fast steady run → Analysis "Solver diary" section (digest, ordered
 *      timeline, severity text) + JSON/text downloads carrying the versioned
 *      payload, provenance config hash, and owning-run context;
 *      run-history diary affordance selects the run and focuses the section.
 *   2. long adaptive run → enough events for the collapsed window: Show
 *      all / Show fewer, warning severity entries, retention meta.
 *   3. cancel mid-run → partial cancelled diary renders without a final
 *      result and exports with a model-name-based file name.
 *   4. sweep variants show a compact diary cell; promoting a variant threads
 *      its diary into Analysis run history.
 */
import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";
import { openAnalysisSection } from "./analysis";

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

async function captureDownload(
  page: Page,
  trigger: () => Promise<void>,
): Promise<{ text: string; filename: string }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    trigger(),
  ]);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Download path is null");
  return {
    text: fs.readFileSync(downloadPath, "utf-8"),
    filename: download.suggestedFilename(),
  };
}

test.describe("Solver diary", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Reset units to SI defaults so nothing view-related leaks between tests.
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. Steady run: diary section, exports with provenance/run context, history diary jump", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );

    // The Solver diary is a closed disclosure in the redesigned Analysis
    // view; open it via its header (the run-strip button does the same).
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "diary");
    const diary = page.locator('[data-testid="solver-diary"]');
    await expect(diary).toBeVisible();
    await expect(diary).toHaveAttribute(
      "aria-labelledby",
      "solver-diary-title",
    );
    await expect(
      page.locator('[data-testid="solver-diary-outcome"]'),
    ).toHaveText("converged");
    await expect(
      page.locator('[data-testid="solver-diary-digest"]'),
    ).toContainText("converged");
    await expect(
      page.locator('[data-testid="solver-diary-digest"]'),
    ).toContainText("iter");

    // Ordered timeline: runStart … runFinish, coordinates + severity text.
    const events = page.locator('[data-testid="solver-diary-event"]');
    const eventCount = await events.count();
    expect(eventCount).toBeGreaterThanOrEqual(2);
    await expect(events.first()).toContainText("iter 0");
    await expect(events.first()).toContainText("info"); // severity as text, not color alone
    await expect(events.first()).toContainText("steady run started");
    await expect(events.last()).toContainText("run finished");
    // The toggle appears iff the diary exceeds the collapsed window.
    await expect(
      page.locator('[data-testid="solver-diary-toggle"]'),
    ).toHaveCount(eventCount > 5 ? 1 : 0);

    // JSON export: versioned payload + provenance hash + owning-run context.
    const jsonDl = await captureDownload(page, () =>
      page.locator('[data-testid="solver-diary-download-json"]').click(),
    );
    expect(jsonDl.filename).toMatch(/^Run_1-diary-[0-9a-f]{8}\.json$/);
    const payload = JSON.parse(jsonDl.text);
    expect(payload.version).toBe(1);
    expect(payload.mode).toBe("steady");
    expect(payload.outcome).toBe("converged");
    expect(payload.provenance.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(payload.provenance.modelName).toBe("Three-pipe junction");
    expect(payload.run).toEqual({
      id: expect.stringMatching(/^run-/),
      name: "Run 1",
    });
    expect(payload.events).toHaveLength(eventCount);
    expect(payload.events[0].kind).toBe("runStart");
    expect(payload.events[payload.events.length - 1].kind).toBe("runFinish");

    // Text export: deterministic body + run context line.
    const textDl = await captureDownload(page, () =>
      page.locator('[data-testid="solver-diary-download-text"]').click(),
    );
    expect(textDl.filename).toMatch(/^Run_1-diary-[0-9a-f]{8}\.txt$/);
    expect(textDl.text).toContain("run=Run 1");
    expect(textDl.text).toContain("convergence diary v1");
    expect(textDl.text).toContain("mode=steady");
    expect(textDl.text).toContain("digest: converged");

    // Every run-history row carries a diary affordance (Runs disclosure).
    await openAnalysisSection(page, "runs");
    await expect(page.locator('[data-testid="run-history-diary"]')).toHaveCount(
      1,
    );
    await expect(
      page.locator('[data-testid="run-history-diary"]'),
    ).toContainText("Diary ·");

    // A second run (edited inlet pressure) pushes Run 2 with its own diary.
    await page.locator('[data-testid="editor-tab"]').click();
    await page.locator('[data-testid="node-in"]').click();
    const pressureInput = page.locator('label:has-text("Pressure") + input');
    await pressureInput.fill("250000");
    await pressureInput.blur();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );
    // The editor round-trip remounted the Analysis view (disclosures closed).
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "runs");
    await expect(page.locator('[data-testid="run-history-item"]')).toHaveCount(
      2,
    );
    await expect(page.locator('[data-testid="run-history-diary"]')).toHaveCount(
      2,
    );
    const run2Hash: string = (await page
      .locator('[data-testid="run-history-item"]')
      .first()
      .locator(".run-history__meta")
      .textContent())!.slice(-8);
    await openAnalysisSection(page, "diary");
    const digest2 = await page
      .locator('[data-testid="solver-diary-digest"]')
      .textContent();

    // Selecting Run 1 via its diary affordance: row selection switches, the
    // diary disclosure re-opens (it stayed open here), the diary ITSELF is
    // focused, and the digest/hash follow the selected run.
    await page
      .locator('[data-testid="run-history-item"]')
      .nth(1)
      .locator('[data-testid="run-history-diary"]')
      .click();
    await expect(
      page
        .locator('[data-testid="run-history-item"]')
        .nth(1)
        .locator('[data-testid="run-history-view"]'),
    ).toHaveAttribute("aria-current", "true");
    await expect(diary).toBeFocused();
    const digest1 = await page
      .locator('[data-testid="solver-diary-digest"]')
      .textContent();
    expect(digest1).not.toBe(digest2);

    const json1 = await captureDownload(page, () =>
      page.locator('[data-testid="solver-diary-download-json"]').click(),
    );
    const payload1 = JSON.parse(json1.text);
    expect(payload1.run.name).toBe("Run 1");
    expect(payload1.provenance.configHash.slice(0, 8)).not.toBe(run2Hash);
    expect(json1.filename).toMatch(/^Run_1-diary-[0-9a-f]{8}\.json$/);

    consoleWatcher.assertNoErrors();
  });

  test("2. Long adaptive run: collapsed window, Show all/fewer, warning entries", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const consoleWatcher = attachConsoleWatcher(page);

    // Adaptive-stepping tank blowdown with an absurdly tight error tolerance:
    // the step controller is driven into dtMin, so the diary collects ~9
    // events (dt observations, quartile milestones, dtMin/accuracy warnings).
    // No shipped example is an adaptive run stiff enough to guarantee warning
    // entries, so this mirrors the shipped Tank blowdown network plus the
    // proven tight-tolerance adaptive settings of the core solver's
    // robustness case (src/core/__tests__/adaptive.test.ts).
    await page.evaluate(() => {
      const config = {
        meta: { name: "Tank blowdown (adaptive, tight tolerance)", version: 2 },
        settings: {
          mode: "transient",
          dt: 0.1,
          endTime: 5.0,
          timeStepping: "adaptive",
          adaptive: {
            dtMin: 0.001,
            dtMax: 0.05,
            relTol: 1e-10,
            absTolP: 1e-6,
            absTolT: 1e-6,
            safety: 0.9,
          },
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "idealGas", preset: "air" },
        nodes: [
          {
            id: "tank",
            type: "internal",
            x: 0,
            y: 0,
            pressure: 500000,
            temperature: 300,
            volume: 0.1,
            label: "Tank",
          },
          {
            id: "ambient",
            type: "boundary",
            x: 300,
            y: 0,
            pressure: 101325,
            temperature: 300,
            label: "Ambient",
          },
        ],
        branches: [
          {
            id: "orifice",
            from: "tank",
            to: "ambient",
            component: { type: "orifice", area: 0.0001, cd: 0.6 },
            label: "Orifice",
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
      { timeout: 60000 },
    );

    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "diary");
    const diary = page.locator('[data-testid="solver-diary"]');
    await expect(diary).toBeVisible();
    await expect(
      page.locator('[data-testid="solver-diary-meta"]'),
    ).toContainText("warning");

    // Collapsed by default to the first 5 events; Show all reveals the rest.
    const toggle = page.locator('[data-testid="solver-diary-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toContainText("Show all");
    await expect(
      page.locator('[data-testid="solver-diary-event"]'),
    ).toHaveCount(5);
    await expect(
      page.locator('[data-testid="solver-diary-hidden"]'),
    ).toContainText("hidden");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toContainText("Show fewer");
    const expandedCount = await page
      .locator('[data-testid="solver-diary-event"]')
      .count();
    expect(expandedCount).toBeGreaterThan(5);
    // Warning entries (dtMin hits / accuracy limited) carry severity text.
    await expect(
      diary.locator(".solver-diary__sev--warning").first(),
    ).toBeVisible();
    // Transient coordinates.
    await expect(diary.locator(".solver-diary__coord").first()).toContainText(
      "t = 0s · step 0",
    );

    await toggle.click();
    await expect(
      page.locator('[data-testid="solver-diary-event"]'),
    ).toHaveCount(5);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    consoleWatcher.assertNoErrors();
  });

  test("3. Cancel mid-run: partial cancelled diary without a final result, sensible export name", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const consoleWatcher = attachConsoleWatcher(page);

    // Long transient (same shape as the partial-data cancel test).
    await page.evaluate(() => {
      const config = {
        meta: { name: "Long pump startup", version: 2 },
        settings: {
          mode: "transient",
          dt: 0.005,
          endTime: 200.0,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "res",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: 100_000,
            temperature: 300,
            label: "Reservoir",
          },
          {
            id: "pumpOut",
            type: "internal",
            x: 150,
            y: 0,
            pressure: 250_000,
            temperature: 300,
            volume: 0.02,
            label: "Pump out",
          },
          {
            id: "seg1",
            type: "internal",
            x: 300,
            y: 0,
            pressure: 200_000,
            temperature: 300,
            volume: 0.02,
            label: "Seg1",
          },
          {
            id: "seg2",
            type: "internal",
            x: 450,
            y: 0,
            pressure: 180_000,
            temperature: 300,
            volume: 0.02,
            label: "Seg2",
          },
          {
            id: "seg3",
            type: "internal",
            x: 600,
            y: 0,
            pressure: 160_000,
            temperature: 300,
            volume: 0.02,
            label: "Seg3",
          },
          {
            id: "disch",
            type: "boundary",
            x: 750,
            y: 0,
            pressure: 100_000,
            temperature: 300,
            label: "Discharge",
          },
        ],
        branches: [
          {
            id: "pump",
            from: "res",
            to: "pumpOut",
            component: {
              type: "pump",
              curve: [
                [0, 300_000],
                [0.005, 250_000],
                [0.01, 150_000],
                [0.02, 50_000],
              ],
            },
            label: "Pump",
          },
          {
            id: "pipe1",
            from: "pumpOut",
            to: "seg1",
            component: {
              type: "pipe",
              length: 40,
              diameter: 0.05,
              roughness: 1e-5,
            },
            label: "Pipe1",
          },
          {
            id: "pipe2",
            from: "seg1",
            to: "seg2",
            component: {
              type: "pipe",
              length: 40,
              diameter: 0.05,
              roughness: 1e-5,
            },
            label: "Pipe2",
          },
          {
            id: "pipe3",
            from: "seg2",
            to: "seg3",
            component: {
              type: "pipe",
              length: 40,
              diameter: 0.05,
              roughness: 1e-5,
            },
            label: "Pipe3",
          },
          {
            id: "valve",
            from: "seg3",
            to: "disch",
            component: {
              type: "valve",
              area: 0.0005,
              cd: 0.6,
              position: 0,
              positionSchedule: [
                [0, 0],
                [2, 1],
                [5, 1],
              ],
            },
            label: "Valve",
          },
        ],
      };
      localStorage.setItem("fluids-network-config-v1", JSON.stringify(config));
    });
    await page.reload();
    await page.waitForTimeout(500);

    // Run, let a few progress updates land, then cancel (in-page rAF polling
    // minimises Playwright overhead, per the existing cancel test).
    await page.evaluate(async () => {
      const click = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) throw new Error(`${sel} not found`);
        el.click();
      };
      click('[data-testid="toolbar-run"]');
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const check = () => {
          if (document.querySelector('[data-testid="toolbar-cancel"]'))
            resolve();
          else if (performance.now() > deadline)
            reject(new Error("Cancel button did not appear within 5 s"));
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      // A handful of ~10 Hz progress updates before cancelling.
      await new Promise((r) => setTimeout(r, 500));
      click('[data-testid="toolbar-cancel"]');
    });

    await page.locator('[data-testid="results-tab"]').click();
    await expect(page.locator('[data-testid="cancelled-banner"]')).toBeVisible({
      timeout: 10000,
    });
    // The partial cancelled diary lives behind the closed diary disclosure —
    // the strip's Solver diary button opens and focuses it.
    await expect(page.locator('[data-testid="run-strip-diary"]')).toBeVisible();
    await page.locator('[data-testid="run-strip-diary"]').click();
    await expect(page.locator('[data-testid="diary-toggle"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const diary = page.locator('[data-testid="solver-diary"]');
    await expect(diary).toBeVisible();
    await expect(diary).toBeFocused();
    await expect(
      page.locator('[data-testid="solver-diary-outcome"]'),
    ).toHaveText("cancelled");
    await expect(
      page.locator('[data-testid="solver-diary-digest"]'),
    ).toContainText("cancelled");
    await expect(
      page.locator('[data-testid="solver-diary-digest"]'),
    ).toContainText("partial diary");
    await expect(
      page.locator('[data-testid="solver-diary-partial"]'),
    ).toBeVisible();
    expect(
      await page.locator('[data-testid="solver-diary-event"]').count(),
    ).toBeGreaterThanOrEqual(2);

    // No RunRecord is fabricated for a cancelled run: the export has no run
    // context and falls back to the model-name stem.
    const jsonDl = await captureDownload(page, () =>
      page.locator('[data-testid="solver-diary-download-json"]').click(),
    );
    expect(jsonDl.filename).toMatch(
      /^Long_pump_startup-diary-[0-9a-f]{8}\.json$/,
    );
    const payload = JSON.parse(jsonDl.text);
    expect(payload.version).toBe(1);
    expect(payload.outcome).toBe("cancelled");
    expect(payload.summary.partial).toBe(true);
    expect("run" in payload).toBe(false);
    expect(payload.provenance.modelName).toBe("Long pump startup");

    consoleWatcher.assertNoErrors();
  });

  test("4. Sweep variant diary cell + promotion threads the diary into Analysis", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);

    await page.locator('[data-testid="sweep-tab"]').click();
    await page
      .locator('[data-testid="sweep-target"]')
      .selectOption({ label: "Node Inlet · pressure" });
    const count = page.locator('[data-testid="sweep-count"]');
    await count.fill("2");
    await count.blur();
    await page.locator('[data-testid="sweep-run"]').click();

    const job = page.locator('[data-testid="sweep-job"]').first();
    await expect(job.locator('[data-testid="sweep-job-status"]')).toHaveText(
      "completed",
      { timeout: 30000 },
    );
    await expect(page.locator('[data-testid="sweep-variant-row"]')).toHaveCount(
      2,
    );

    // Compact diary cell per finalized variant (event count; tooltip digest).
    const diaryCell = page.locator('[data-testid="sweep-variant-diary-0"]');
    await expect(diaryCell).toContainText("events");
    expect(await diaryCell.getAttribute("title")).toContain("converged");
    await expect(
      page.locator('[data-testid="sweep-variant-diary-1"]'),
    ).toContainText("events");

    // Promote variant 0: the Analysis diary shows the variant's own diary
    // (Runs and Solver diary are closed disclosures — expand both).
    await page.locator('[data-testid="sweep-promote-0"]').click();
    await expect(page.locator('[data-testid="results-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await openAnalysisSection(page, "runs");
    await expect(
      page.locator('[data-testid="run-history-name"]').first(),
    ).toHaveValue("Node Inlet · pressure = 270000");
    await openAnalysisSection(page, "diary");
    const diary = page.locator('[data-testid="solver-diary"]');
    await expect(diary).toBeVisible();
    await expect(
      page.locator('[data-testid="solver-diary-outcome"]'),
    ).toHaveText("converged");
    await expect(
      page.locator('[data-testid="solver-diary-digest"]'),
    ).toContainText("converged");

    const jsonDl = await captureDownload(page, () =>
      page.locator('[data-testid="solver-diary-download-json"]').click(),
    );
    const payload = JSON.parse(jsonDl.text);
    expect(payload.run.name).toBe("Node Inlet · pressure = 270000");
    expect(jsonDl.filename).toMatch(
      /^Node_Inlet_pressure_270000-diary-[0-9a-f]{8}\.json$/,
    );
    expect(payload.provenance.configHash).toMatch(/^[0-9a-f]{16}$/);

    consoleWatcher.assertNoErrors();
  });
});
