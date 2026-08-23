/**
 * e2e/workspace-sidebars.spec.ts — Diagram-only canvas tools (Studio shell).
 *
 * The model-builder rail renders only while an editable FlowCanvas is the
 * active center content, and the Properties inspector additionally requires
 * a selection. Sweep and Analysis unmount both; the project outline is
 * layout chrome and stays on every tab:
 *
 *   - the rail and inspector are absent from the DOM (not merely hidden) on
 *     non-canvas tabs, so hidden controls can never retain keyboard focus,
 *   - the page never gains horizontal overflow (desktop and ~700px), and
 *   - selection survives the round trip in the zustand store.
 *
 * The workspace tab strip lives inside the main column between the outline
 * and inspector docks, so mounting/unmounting the inspector must not move
 * the strip's origin.
 */
import { test, expect, Page } from "@playwright/test";

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

const RAIL = '[aria-label="Model builder tools"]';
const PANEL = '[data-testid="property-panel"]';
const INSPECTOR = '[data-testid="studio-inspector"]';
const OUTLINE = '[data-testid="studio-outline"]';
const TABS = '[data-testid="workspace-tabs"]';

/** Non-canvas workspace tabs: tab testid + the root testid of the view they host. */
const NON_CANVAS_TABS = [
  { tab: "config-tab", view: "configuration-view", name: "Configuration" },
  { tab: "sweep-tab", view: "sweep-panel", name: "Sweep" },
  { tab: "results-tab", view: "results-view", name: "Runs" },
] as const;

/** Rail and inspector are unmounted — absent from the DOM, not hidden. */
async function expectCanvasToolsAbsent(page: Page) {
  await expect(page.locator(RAIL)).toHaveCount(0);
  await expect(page.locator(INSPECTOR)).toHaveCount(0);
  await expect(page.locator(PANEL)).toHaveCount(0);
}

async function expectCanvasRailPresent(page: Page) {
  await expect(page.locator(RAIL)).toBeVisible();
}

/** No document-level horizontal overflow at the current viewport. */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(
    overflow,
    "horizontal overflow (scrollWidth - clientWidth)",
  ).toBeLessThanOrEqual(1);
}

/** Bounding box of the workspace tab strip. */
async function tabStripBox(page: Page) {
  const box = await page.locator(TABS).boundingBox();
  expect(box, "tab strip box").not.toBeNull();
  return box!;
}

/** The strip's origin never moves when panels mount/unmount beside it. */
async function expectTabStripStable(
  page: Page,
  reference: { x: number; y: number },
  context: string,
) {
  const box = await tabStripBox(page);
  expect(box.x, `tab strip x stable (${context})`).toBeCloseTo(reference.x, 0);
  expect(box.y, `tab strip y stable (${context})`).toBeCloseTo(reference.y, 0);
}

test.describe("Workspace canvas panels (Diagram-only)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Reset units to SI defaults, matching the other specs' isolation.
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. canvas tools are Diagram-only: unmounted on other tabs, outline persists, state survives the round trip", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // --- Step 1: default Diagram shows the model-builder rail --------------
    await expect(page.locator('[data-testid="editor-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectCanvasRailPresent(page);
    // The inspector is contextual: nothing selected, nothing docked.
    await expect(page.locator(INSPECTOR)).toHaveCount(0);
    await expect(page.locator(PANEL)).toHaveCount(0);

    // Reference origin for the tab strip.
    const diagramTabs = await tabStripBox(page);

    // --- Step 2: selecting an entity fills the contextual panel ------------
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B1"]').click();
    await expect(page.locator(PANEL)).toContainText("Node: B1");

    // --- Step 3: every non-canvas tab unmounts canvas tools ----------------
    for (const { tab, view, name } of NON_CANVAS_TABS) {
      await page.locator(`[data-testid="${tab}"]`).click();
      await expect(
        page.locator(`[data-testid="${view}"]`),
        `${name} view visible`,
      ).toBeVisible();

      await expectCanvasToolsAbsent(page);
      // The project outline is layout chrome: it stays on every tab.
      await expect(page.locator(OUTLINE)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectTabStripStable(page, diagramTabs, `Diagram → ${name}`);

      // ~700px: still no rails, still no horizontal overflow.
      await page.setViewportSize({ width: 700, height: 720 });
      await page.waitForTimeout(150);
      await expectCanvasToolsAbsent(page);
      await expectNoHorizontalOverflow(page);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(150);
      await expectTabStripStable(page, diagramTabs, `${name} @1280px`);
    }

    // --- Step 4: returning to Diagram restores tools and selection --------
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();
    await expectCanvasRailPresent(page);
    await expectTabStripStable(page, diagramTabs, "back to Diagram");

    // Selection survived the unmount: the property editor is still on B1.
    await expect(page.locator(PANEL)).toContainText("Node: B1");

    consoleWatcher.assertNoErrors();
  });

  test("2. group/subnetwork canvas tab keeps the canvas tools", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Fresh model with two boundary nodes (grouping requires 2+ members).
    await page.locator('[data-testid="toolbar-new"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);

    // Multi-select both nodes (Shift-click) and group them.
    await page.locator('[data-testid="node-B1"]').click();
    await page.waitForTimeout(200);
    await page
      .locator('[data-testid="node-B2"]')
      .click({ modifiers: ["Shift"] });
    await page.waitForTimeout(200);
    await page
      .getByRole("toolbar", { name: "Selection actions" })
      .getByRole("button", { name: "Create subnetwork" })
      .click();
    await page.waitForTimeout(500);

    // Open the group canvas tab from the container's Open button.
    await page.locator('[data-testid^="open-subnetwork-"]').first().click();
    const groupTab = page.locator('[data-testid^="group-tab-"]').first();
    await expect(groupTab).toBeVisible();
    await expect(groupTab).toHaveAttribute("aria-selected", "true");

    // The group canvas is an editable FlowCanvas: its rail stays mounted.
    // (Whether the inspector is docked depends on the selection, which
    // studio-shell.spec covers directly.)
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();
    await expectCanvasRailPresent(page);
    const groupTabs = await tabStripBox(page);

    // Opening Text keeps the group canvas selected behind the modal.
    await page.locator('[data-testid="canvas-text-view"]').click();
    await expect(page.locator('[data-testid="text-model-view"]')).toBeVisible();
    // The group tab remains selected because this is not workspace navigation.
    await expect(groupTab).toBeVisible();
    await expect(groupTab).toHaveAttribute("aria-selected", "true");
    // The strip itself never moved.
    await expectTabStripStable(page, groupTabs, "group tab → Text");

    await page.locator('[data-testid="model-view-dialog-close"]').click();
    await expect(groupTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();
    await expectCanvasRailPresent(page);
    await expectTabStripStable(page, groupTabs, "Text → group tab");

    consoleWatcher.assertNoErrors();
  });

  test("3. keyboard tab traversal is trapped in the Text modal", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="canvas-text-view"]').click();
    await expect(page.locator('[data-testid="text-model-view"]')).toBeVisible();

    // Walk the modal's tab order. The canvas rails remain mounted behind it,
    // but the focus trap keeps every stop inside the dialog.
    await page.locator('[data-testid="model-view-dialog-close"]').focus();
    let reachedEditor = false;
    let stops = 0;
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      stops++;
      const probe = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          inSidebar: !!el?.closest(
            '.canvas-rail, [data-testid="property-panel"], [data-testid="model-outline"]',
          ),
          testid: el?.getAttribute("data-testid"),
        };
      });
      expect(
        probe.inSidebar,
        `Tab stop #${stops} escaped into a canvas sidebar`,
      ).toBe(false);
      if (probe.testid === "text-model-editor") {
        reachedEditor = true;
        break;
      }
    }
    // Traversal genuinely moved through the page into the view's editor.
    expect(reachedEditor, "Tab traversal reached the text editor").toBe(true);

    consoleWatcher.assertNoErrors();
  });
});
