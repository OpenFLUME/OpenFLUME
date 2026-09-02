/**
 * e2e/settings-tabs.spec.ts — the Setup tab's six sections and the
 * fields they newly expose.
 *
 * Everything asserted here used to require hand-editing the model text: the
 * compressible formulation flags, the Newton strategy knobs, the closure
 * constants, and the species block. The point of the spec is that a user can
 * now reach them through the UI, that the edits land in the saved model, and
 * that a compressible solve driven entirely from Setup converges.
 */
import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";

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

async function openSettings(page: Page, tab?: string) {
  await page.locator('[data-testid="config-tab"]').click();
  await expect(
    page.locator('[data-testid="configuration-view"]'),
  ).toBeVisible();
  if (tab) {
    await page.locator(`[data-testid="settings-tab-${tab}"]`).click();
    await expect(
      page.locator(`[data-testid="settings-tab-panel-${tab}"]`),
    ).toBeVisible();
  }
}

async function closeSettings(page: Page) {
  await page.locator('[data-testid="editor-tab"]').click();
  await expect(
    page.locator('[data-testid="configuration-view"]'),
  ).not.toBeVisible();
}

/** The `settings` singleton line of the saved .fn document, parsed. */
function savedSettings(fnText: string): Record<string, unknown> {
  const line = fnText
    .split("\n")
    .find((l) => l.startsWith("settings:"))
    ?.slice("settings:".length)
    .trim();
  if (!line) throw new Error("no settings line in saved model");
  return JSON.parse(line) as Record<string, unknown>;
}

test.describe("Configuration sections", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("1. Lands on Solver, navigates between sections, and resets on leaving", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await openSettings(page);
    // Solver is the landing section.
    await expect(
      page.locator('[data-testid="settings-tab-panel-solver"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="settings-tab-solver"]'),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="settings-mode"]')).toBeVisible();

    // Each section is real navigation: the previous panel is gone.
    for (const tab of [
      "physics",
      "fluids",
      "species",
      "units",
      "extensibility",
    ]) {
      await page.locator(`[data-testid="settings-tab-${tab}"]`).click();
      await expect(
        page.locator(`[data-testid="settings-tab-panel-${tab}"]`),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="settings-tab-panel-solver"]'),
      ).toHaveCount(0);
    }

    // Reopening returns to the basics rather than the last section used.
    await closeSettings(page);
    await openSettings(page);
    await expect(
      page.locator('[data-testid="settings-tab-panel-solver"]'),
    ).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("2. Physics tab writes the compressible flags into the saved model", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await openSettings(page, "physics");

    // Off by default, and the scheme select is inert until momentum flux is on.
    const scheme = page.locator('[data-testid="settings-momentum-scheme"]');
    await expect(scheme).toBeDisabled();
    await expect(
      page.locator('[data-testid="settings-formulation-summary"]'),
    ).toContainText("No flux terms");

    await page.locator('[data-testid="settings-momentum-flux"]').check();
    await page.locator('[data-testid="settings-kinetic-energy"]').check();
    await expect(scheme).toBeEnabled();
    await expect(
      page.locator('[data-testid="settings-formulation-summary"]'),
    ).toContainText("Quasi-1-D compressible");

    // The second-law audit becomes applicable under the central scheme.
    const audit = page.locator(
      '[data-testid="settings-transonic-admissibility"]',
    );
    await expect(audit).toBeDisabled();
    await scheme.selectOption("central");
    await expect(audit).toBeEnabled();
    await expect(audit).toBeChecked();
    await audit.uncheck();

    await closeSettings(page);

    const fnText = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="toolbar-save"]').click();
    });
    const settings = savedSettings(fnText);
    expect(settings.momentumFlux).toBe(true);
    expect(settings.kineticEnergy).toBe(true);
    expect(settings.momentumFluxScheme).toBe("central");
    expect(settings.transonicAdmissibility).toBe(false);

    consoleWatcher.assertNoErrors();
  });

  test("3. Accepting a default leaves the key out of the saved model", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await openSettings(page, "physics");
    // Toggle on and back off: the model must end up as it started, not with an
    // explicit false.
    const momentum = page.locator('[data-testid="settings-momentum-flux"]');
    await momentum.check();
    await momentum.uncheck();
    await closeSettings(page);

    const fnText = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="toolbar-save"]').click();
    });
    const settings = savedSettings(fnText);
    expect("momentumFlux" in settings).toBe(false);
    expect("transonicAdmissibility" in settings).toBe(false);

    consoleWatcher.assertNoErrors();
  });

  test("4. Advanced numerics and closure constants persist", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await openSettings(page, "solver");
    await page.locator('[data-testid="settings-numerics-toggle"]').click();
    await page.locator('[data-testid="settings-jacobian"]').selectOption("fd");
    await page
      .locator('[data-testid="settings-globalization"]')
      .selectOption("lineSearch");

    await page.locator('[data-testid="settings-tab-physics"]').click();
    await page.locator('[data-testid="settings-closure-toggle"]').click();
    const leading = page.locator(
      '[data-testid="closure-dittusBoelter-leadingCoefficient"]',
    );
    await leading.fill("0.03");
    await leading.blur();
    await expect(
      page.locator('[data-testid="settings-closure-toggle"]'),
    ).toContainText("1 override");

    await closeSettings(page);

    const fnText = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="toolbar-save"]').click();
    });
    const settings = savedSettings(fnText);
    expect(settings.jacobian).toBe("fd");
    expect(settings.globalization).toBe("lineSearch");
    expect(fnText).toContain('"dittusBoelter":{"leadingCoefficient":0.03}');

    consoleWatcher.assertNoErrors();
  });

  test("5. Species transport is created and removed from the Species section", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await openSettings(page, "species");
    // Water is the default fluid, so the tab explains why transport cannot run.
    await expect(
      page.locator('[data-testid="settings-tab-panel-species"]'),
    ).toContainText("only supported for the idealGas fluid model");

    await page.locator('[data-testid="settings-tab-fluids"]').click();
    await page
      .locator('[data-testid="settings-fluid-model"]')
      .selectOption("idealGas");
    await page.locator('[data-testid="settings-tab-species"]').click();
    await expect(
      page.locator('[data-testid="settings-tab-panel-species"]'),
    ).not.toContainText("only supported for the idealGas fluid model");

    await page.locator('[data-testid="species-enable"]').click();
    await expect(page.locator('[data-testid="species-table"]')).toBeVisible();
    await page.locator('[data-testid="species-add"]').click();
    await expect(page.locator('[data-testid="species-name-2"]')).toBeVisible();

    // A reaction over the declared roster.
    await page.locator('[data-testid="reaction-add"]').click();
    await expect(page.locator('[data-testid="reaction-0"]')).toBeVisible();

    await closeSettings(page);
    const fnText = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="toolbar-save"]').click();
    });
    expect(fnText).toContain("species:");
    expect(fnText).toContain('"N2"');

    // Removing transport takes the whole block with it.
    await openSettings(page, "species");
    await page.locator('[data-testid="species-disable"]').click();
    await expect(page.locator('[data-testid="species-enable"]')).toBeVisible();
    await closeSettings(page);
    const cleared = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="toolbar-save"]').click();
    });
    expect(cleared).not.toContain("species:");

    consoleWatcher.assertNoErrors();
  });

  test("6. A quasi-1-D solve configured entirely from the UI converges", async ({
    page,
  }) => {
    test.setTimeout(90000);
    const consoleWatcher = attachConsoleWatcher(page);

    // Tank blowdown is the shipped transient ideal-gas network, so the
    // momentum-flux and stagnation-enthalpy terms are non-trivial here.
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Tank blowdown");
    await page.waitForTimeout(300);

    await openSettings(page, "physics");
    await page.locator('[data-testid="settings-momentum-flux"]').check();
    await page.locator('[data-testid="settings-kinetic-energy"]').check();
    await closeSettings(page);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 60000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    consoleWatcher.assertNoErrors();
  });
});
