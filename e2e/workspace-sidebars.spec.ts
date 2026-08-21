/**
 * e2e/workspace-sidebars.spec.ts — Diagram-only canvas sidebars.
 *
 * The BUILD MODEL palette (left rail) and the Edit property panel (right
 * rail) render only while an editable FlowCanvas is the active center
 * content: the main Diagram tab and group/subnetwork canvas tabs (which keep
 * activeTab === 'editor'; see src/ui/workspaceLayout.ts).  Text, Model
 * Table, Sweep and Analysis UNMOUNT both rails — not width-collapsed — so:
 *
 *   - the center column expands to the full workspace width (no blank
 *     left/right rails),
 *   - the page never gains horizontal overflow (desktop and ~700px), and
 *   - hidden sidebar controls can never retain or receive keyboard focus.
 *
 * Sidebar state survives the round trip because it lives outside the
 * unmounted components: palette section collapse is persisted to
 * localStorage, and the property-panel selection lives in the zustand store.
 *
 * The workspace tab strip is a full-width sibling ABOVE the sidebar row
 * (Toolbar → tabs → sidebars+content), so the tabs never move when the
 * rails mount/unmount — every tab switch keeps the strip's bounding box
 * pixel-identical.
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

const PALETTE = '[data-testid="palette"]';
const PANEL = '[data-testid="property-panel"]';
const CENTER = '[data-testid="workspace-center"]';
const WORKSPACE = ".workspace";
const TABS = '[data-testid="workspace-tabs"]';

/** Non-canvas workspace tabs: tab testid + the root testid of the view they host. */
const NON_CANVAS_TABS = [
  { tab: "sweep-tab", view: "sweep-panel", name: "Sweep" },
  { tab: "results-tab", view: "results-view", name: "Analysis" },
] as const;

/** Both sidebars are unmounted — absent from the DOM, not merely hidden. */
async function expectSidebarsAbsent(page: Page) {
  await expect(page.locator(PALETTE)).toHaveCount(0);
  await expect(page.locator(PANEL)).toHaveCount(0);
}

async function expectSidebarsPresent(page: Page) {
  await expect(page.locator(PALETTE)).toBeVisible();
  await expect(page.locator(PANEL)).toBeVisible();
}

/** The center column spans the workspace edge to edge (no blank rails). */
async function expectCenterFullWidth(page: Page) {
  const center = await page.locator(CENTER).boundingBox();
  const workspace = await page.locator(WORKSPACE).boundingBox();
  expect(center, "center column box").not.toBeNull();
  expect(workspace, "workspace box").not.toBeNull();
  // 2px tolerance for borders/sub-pixel rounding.
  expect(center!.x, "no empty left rail").toBeGreaterThanOrEqual(
    workspace!.x - 1,
  );
  expect(center!.x, "no empty left rail").toBeLessThanOrEqual(workspace!.x + 2);
  expect(
    center!.x + center!.width,
    "no empty right rail",
  ).toBeGreaterThanOrEqual(workspace!.x + workspace!.width - 2);
}

/** The center column leaves room for both rails (palette + property panel). */
async function expectCenterBesideRails(page: Page) {
  const center = await page.locator(CENTER).boundingBox();
  const workspace = await page.locator(WORKSPACE).boundingBox();
  expect(center).not.toBeNull();
  expect(workspace).not.toBeNull();
  // Rails: 188px palette + 260px panel at ≥1101px widths (see index.css).
  expect(
    workspace!.width - center!.width,
    "rails occupy their width",
  ).toBeGreaterThanOrEqual(400);
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

/** Bounding box of the workspace tab strip (must never move between tabs). */
async function tabStripBox(page: Page) {
  const box = await page.locator(TABS).boundingBox();
  expect(box, "tab strip box").not.toBeNull();
  return box!;
}

/**
 * The tab strip sits OUTSIDE the sidebar row: switching views mounts/unmounts
 * the rails below it, but the strip keeps the exact same box.
 */
async function expectTabStripStable(
  page: Page,
  reference: { x: number; y: number; width: number },
  context: string,
) {
  const box = await tabStripBox(page);
  expect(box.x, `tab strip x stable (${context})`).toBeCloseTo(reference.x, 0);
  expect(box.y, `tab strip y stable (${context})`).toBeCloseTo(reference.y, 0);
  expect(box.width, `tab strip width stable (${context})`).toBeCloseTo(
    reference.width,
    0,
  );
}

test.describe("Workspace canvas sidebars (Diagram-only)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Reset units to SI defaults, matching the other specs' isolation.
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. sidebars are Diagram-only: unmounted + full-width on other tabs, state survives the round trip", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // --- Step 1: default Diagram shows both rails --------------------------
    await expect(page.locator('[data-testid="editor-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectSidebarsPresent(page);
    await expect(page.locator(PALETTE)).toContainText("BUILD MODEL");
    await expectCenterBesideRails(page);

    // Reference box for the tab strip: it must be identical on every tab.
    const diagramTabs = await tabStripBox(page);

    // --- Step 2: select an entity; collapse a palette section --------------
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B1"]').click();
    await expect(page.locator(PANEL)).toContainText("Node: B1");

    const advancedToggle = page.locator(
      '[data-testid="palette-section-advanced-toggle"]',
    );
    await expect(advancedToggle).toHaveAttribute("aria-expanded", "true");
    await advancedToggle.click();
    await expect(advancedToggle).toHaveAttribute("aria-expanded", "false");

    // --- Step 3: every non-canvas tab unmounts both rails ------------------
    for (const { tab, view, name } of NON_CANVAS_TABS) {
      await page.locator(`[data-testid="${tab}"]`).click();
      await expect(
        page.locator(`[data-testid="${view}"]`),
        `${name} view visible`,
      ).toBeVisible();

      await expectSidebarsAbsent(page);
      await expectCenterFullWidth(page);
      await expectNoHorizontalOverflow(page);
      // Tabs never move: same strip box as on the Diagram (sidebars shown).
      await expectTabStripStable(page, diagramTabs, `Diagram → ${name}`);

      // ~700px: still no rails, still no horizontal overflow.
      await page.setViewportSize({ width: 700, height: 720 });
      await page.waitForTimeout(150);
      await expectSidebarsAbsent(page);
      await expectCenterFullWidth(page);
      await expectNoHorizontalOverflow(page);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(150);
      // Restoring the viewport restores the reference strip box exactly.
      await expectTabStripStable(page, diagramTabs, `${name} @1280px`);
    }

    // --- Step 4: returning to Diagram restores rails and their state -------
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();
    await expectSidebarsPresent(page);
    await expectCenterBesideRails(page);
    await expectTabStripStable(page, diagramTabs, "back to Diagram");

    // Selection survived the unmount: the property editor is still on B1.
    await expect(page.locator(PANEL)).toContainText("Node: B1");
    // Palette section collapse survived (persisted to localStorage).
    await expect(
      page.locator('[data-testid="palette-section-advanced-toggle"]'),
    ).toHaveAttribute("aria-expanded", "false");

    consoleWatcher.assertNoErrors();
  });

  test("2. group/subnetwork canvas tab keeps both sidebars", async ({
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
    await page.locator('[data-testid="create-subnetwork"]').click();
    await page.waitForTimeout(500);

    // Open the group canvas tab from the container's Open button.
    await page.locator('[data-testid^="open-subnetwork-"]').first().click();
    const groupTab = page.locator('[data-testid^="group-tab-"]').first();
    await expect(groupTab).toBeVisible();
    await expect(groupTab).toHaveAttribute("aria-selected", "true");

    // The group canvas is an editable FlowCanvas: both rails stay mounted.
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();
    await expectSidebarsPresent(page);
    await expectCenterBesideRails(page);
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
    await expectSidebarsPresent(page);
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
            '[data-testid="palette"], [data-testid="property-panel"]',
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
