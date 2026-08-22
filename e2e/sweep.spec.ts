/**
 * e2e/sweep.spec.ts — Sweep workspace end-to-end: definition UX on a fast
 * steady example, sequential 3-variant execution with per-variant rows,
 * CSV export provenance, promote → Analysis, frozen-snapshot staleness,
 * session-only semantics (reload drops jobs), canonical-model isolation
 * (localStorage/text/undo untouched), mutual exclusion with the manual
 * Run button, and cancellation of a transient sweep.
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

const readAutosave = (page: Page) =>
  page.evaluate(() => localStorage.getItem("fluids-network-config-v1"));

test.describe("Sweep workspace", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Reset units to SI defaults so value assertions are deterministic.
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. Steady sweep: define, run 3 variants, export CSV, promote, staleness, session-only", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const consoleWatcher = attachConsoleWatcher(page);

    // Diagram remains the default tab.
    await expect(page.locator('[data-testid="editor-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);
    const configBefore = await readAutosave(page);
    expect(configBefore).toBeTruthy();

    // Open the Sweep workspace.
    await page.locator('[data-testid="sweep-tab"]').click();
    await expect(page.locator('[data-testid="sweep-panel"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="sweep-session-note"]'),
    ).toContainText("session-only");
    await expect(page.locator('[data-testid="sweep-empty"]')).toBeVisible();

    // Pick a fast steady target: the inlet boundary pressure.  Defaults are
    // ±10% around the current value (300000 Pa) with 5 variants.
    await page
      .locator('[data-testid="sweep-target"]')
      .selectOption({ label: "Node Inlet · pressure" });
    await expect(page.locator('[data-testid="sweep-start"]')).toHaveValue(
      "270000",
    );
    await expect(page.locator('[data-testid="sweep-end"]')).toHaveValue(
      "330000",
    );
    await expect(page.locator('[data-testid="sweep-count"]')).toHaveValue("5");

    await page.locator('[data-testid="sweep-count"]').fill("3");
    await page.locator('[data-testid="sweep-count"]').blur();

    // The values preview reflects the committed definition (in Pa).
    await expect(
      page.locator('[data-testid="sweep-values-preview"]'),
    ).toContainText("270000");
    await expect(
      page.locator('[data-testid="sweep-values-preview"]'),
    ).toContainText("330000");

    await page.locator('[data-testid="sweep-run"]').click();

    // Job runs to completion; variants complete strictly in order.
    const job = page.locator('[data-testid="sweep-job"]').first();
    await expect(job.locator('[data-testid="sweep-job-status"]')).toHaveText(
      "completed",
      { timeout: 30000 },
    );
    await expect(page.locator('[data-testid="sweep-variant-row"]')).toHaveCount(
      3,
    );
    for (const i of [0, 1, 2]) {
      await expect(
        page.locator(`[data-testid="sweep-variant-status-${i}"]`),
      ).toHaveText("completed");
      await expect(
        page.locator(`[data-testid="sweep-variant-converged-${i}"]`),
      ).toHaveText("yes");
    }
    await expect(
      page.locator('[data-testid="sweep-variant-value-0"]'),
    ).toHaveText("270,000");
    await expect(
      page.locator('[data-testid="sweep-variant-value-2"]'),
    ).toHaveText("330,000");
    await expect(page.locator('[data-testid="sweep-progress"]')).toContainText(
      "3/3 completed",
    );

    // Manual Run is available again once the sweep is done.
    await expect(page.locator('[data-testid="toolbar-run"]')).toBeEnabled();

    // The canonical model, its text, and localStorage are untouched.
    expect(await readAutosave(page)).toBe(configBefore);
    await expect(
      page.locator('[data-testid="network-name-dirty-dot"]'),
    ).not.toBeVisible();

    // CSV export: provenance comments + header + one row per variant.
    const csv = await captureTextDownload(page, async () => {
      await job.locator('[data-testid="sweep-export-csv"]').click();
    });
    expect(csv).toContain("# base_config_hash=");
    expect(csv).toContain("# sweep_target=Node Inlet · pressure");
    expect(csv).toContain("# sweep_start=270000");
    expect(csv).toContain("# sweep_end=330000");
    expect(csv).toContain("# sweep_count=3");
    const lines = csv.trim().split("\n");
    const headerIdx = lines.findIndex((l) => l.startsWith("index,"));
    expect(headerIdx).toBeGreaterThan(0);
    expect(lines[headerIdx]).toContain("value (Pa)");
    const dataRows = lines.slice(headerIdx + 1);
    expect(dataRows).toHaveLength(3);
    expect(dataRows[0]).toContain("completed");

    // Promote variant 0 → Analysis tab shows the run in history + results
    // (both behind their closed disclosures in the redesigned Analysis view).
    await page.locator('[data-testid="sweep-promote-0"]').click();
    await expect(page.locator('[data-testid="results-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The promoted run is the newest history entry (rendered first); its
    // editable name input carries the "target = value" label.
    await openAnalysisSection(page, "runs");
    await expect(
      page.locator('[data-testid="run-history-name"]').first(),
    ).toHaveValue("Node Inlet · pressure = 270000");
    await openAnalysisSection(page, "final");
    await expect(
      page.locator('[data-testid="steady-branches-table"]'),
    ).toBeVisible();

    // Editing the model marks the sweep's frozen base snapshot as stale.
    await page.locator('[data-testid="editor-tab"]').click();
    await page.locator('[data-testid="node-in"]').click();
    const pressureInput = page
      .getByRole("textbox", { name: /^Pressure \(/ })
      .first();
    await pressureInput.click();
    await pressureInput.fill("250000");
    await pressureInput.press("Enter");
    await page.waitForTimeout(300);
    await page.locator('[data-testid="sweep-tab"]').click();
    await expect(
      page.locator('[data-testid="sweep-stale-banner"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="sweep-stale-banner"]'),
    ).toContainText("frozen snapshot");

    // Session-only: a reload drops the job list entirely.
    await page.reload();
    await page.waitForTimeout(400);
    await expect(page.locator('[data-testid="editor-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.locator('[data-testid="sweep-tab"]').click();
    await expect(page.locator('[data-testid="sweep-empty"]')).toBeVisible();
    await expect(page.locator('[data-testid="sweep-job"]')).toHaveCount(0);

    consoleWatcher.assertNoErrors();
  });

  test("2. Invalid definition is blocked with visible errors and no job is created", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);
    await page.locator('[data-testid="sweep-tab"]').click();

    // Pipe diameter must be positive; sweeping to -1 makes validateNetwork
    // reject most variant values.
    await page
      .locator('[data-testid="sweep-target"]')
      .selectOption({ label: "Pipe Pipe 1 · diameter" });
    const end = page.locator('[data-testid="sweep-end"]');
    await end.fill("-1");
    await end.blur();

    await expect(
      page.locator('[data-testid="sweep-invalid-values"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="sweep-run"]')).toBeDisabled();
    await expect(page.locator('[data-testid="sweep-create"]')).toBeDisabled();
    await expect(page.locator('[data-testid="sweep-job"]')).toHaveCount(0);

    // A non-numeric endpoint is flagged on the field and blocks submission.
    const start = page.locator('[data-testid="sweep-start"]');
    await start.fill("abc");
    await start.blur();
    await expect(start).toHaveAttribute("aria-invalid", "true");
    await expect(
      page.locator('[data-testid="sweep-form-incomplete"]'),
    ).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("3. Transient sweep: manual Run is locked out while running; cancel keeps finished rows", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Tank blowdown");
    await page.waitForTimeout(300);
    const configBefore = await readAutosave(page);

    await page.locator('[data-testid="sweep-tab"]').click();
    await page
      .locator('[data-testid="sweep-target"]')
      .selectOption({ label: "Settings · endTime" });
    // Defaults are ±10% around 5 s; widen slightly and run 3 variants so the
    // sweep stays alive long enough to observe the running state.
    const end = page.locator('[data-testid="sweep-end"]');
    await end.fill("20");
    await end.blur();
    const count = page.locator('[data-testid="sweep-count"]');
    await count.fill("3");
    await count.blur();

    await page.locator('[data-testid="sweep-run"]').click();

    // While the sweep is running the manual Run button is disabled, and the
    // workspace stays navigable.
    await expect(page.locator('[data-testid="sweep-cancel"]')).toBeVisible();
    await expect(page.locator('[data-testid="toolbar-run"]')).toBeDisabled();
    await expect(page.locator('[data-testid="sweep-progress"]')).toContainText(
      "Running variant 1/3",
    );
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();
    await page.locator('[data-testid="sweep-tab"]').click();
    await expect(page.locator('[data-testid="sweep-cancel"]')).toBeVisible();

    // Cancel: pending/running variants become cancelled; the model is untouched.
    await page.locator('[data-testid="sweep-cancel"]').click();
    const job = page.locator('[data-testid="sweep-job"]').first();
    await expect(job.locator('[data-testid="sweep-job-status"]')).toHaveText(
      "cancelled",
    );
    await expect(page.locator('[data-testid="toolbar-run"]')).toBeEnabled();
    await expect(
      job.locator('[data-testid="sweep-rerun-incomplete"]'),
    ).toBeVisible();
    await expect(job.locator('[data-testid="sweep-rerun-all"]')).toBeVisible();

    const statuses = await page
      .locator('[data-testid^="sweep-variant-status-"]')
      .allTextContents();
    expect(statuses.length).toBe(3);
    expect(statuses).toContain("cancelled");
    expect(statuses).not.toContain("pending");
    expect(statuses).not.toContain("running");

    expect(await readAutosave(page)).toBe(configBefore);

    consoleWatcher.assertNoErrors();
  });
});
