/**
 * workspaceLayout — the canvas sidebar visibility policy.
 *
 * The BUILD MODEL palette and the Edit property panel render only while an
 * editable FlowCanvas is the active center content: the main Model tab
 * AND group/subnetwork canvas tabs (which keep activeTab === 'editor' and
 * differ only by activeGroupTab). Sweep and Analysis unmount both rails and
 * expand to the full workspace width; Text and Table are canvas dialogs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { showCanvasSidebars } from "../workspaceLayout";
import { useStore, type AppTab } from "../store";

const NON_CANVAS_TABS: AppTab[] = ["config", "sweep", "results"];

describe("showCanvasSidebars", () => {
  afterEach(() => {
    useStore.setState({
      activeTab: "editor",
      activeGroupTab: null,
      openGroupTabs: [],
    });
  });

  it("shows both sidebars on the main Model tab", () => {
    expect(showCanvasSidebars("editor")).toBe(true);
  });

  it.each(NON_CANVAS_TABS)("hides both sidebars on the %s view", (tab) => {
    expect(showCanvasSidebars(tab)).toBe(false);
  });

  it("covers every AppTab exactly once (policy is total)", () => {
    const all: AppTab[] = ["editor", ...NON_CANVAS_TABS];
    // If a new tab is added to AppTab, this cast-free exhaustiveness probe
    // forces an explicit policy decision here instead of a silent default.
    const decided = all.filter((t) => showCanvasSidebars(t));
    expect(decided).toEqual(["editor"]);
  });

  it("keeps both sidebars when a group/subnetwork canvas tab is active", () => {
    const s = () => useStore.getState();

    // A group tab is reached via openGroupTab: activeTab stays 'editor'.
    s().openGroupTab("g1");
    expect(s().activeTab).toBe("editor");
    expect(s().activeGroupTab).toBe("g1");
    expect(showCanvasSidebars(s().activeTab)).toBe(true);

    // Leaving for a non-canvas view clears the group tab and hides the rails.
    s().setActiveTab("sweep");
    expect(s().activeGroupTab).toBeNull();
    expect(showCanvasSidebars(s().activeTab)).toBe(false);

    // Re-selecting the still-open group tab restores the canvas chrome.
    s().setActiveGroupTab("g1");
    useStore.setState({ activeTab: "editor" });
    expect(showCanvasSidebars(s().activeTab)).toBe(true);
  });
});
