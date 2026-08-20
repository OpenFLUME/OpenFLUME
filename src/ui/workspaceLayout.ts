/**
 * workspaceLayout — which workspace views get contextual canvas chrome.
 *
 * The contextual property panel renders only while an editable FlowCanvas is
 * active:
 *
 *   - the main Diagram tab, and
 *   - any group/subnetwork canvas tab — those are not separate AppTabs:
 *     opening a group tab keeps `activeTab === 'editor'` and distinguishes
 *     the canvas via `activeGroupTab` (see store.openGroupTab /
 *     setActiveTab, which always clears the group tab when a non-canvas
 *     view is selected). One predicate therefore covers both cases.
 *
 * Non-canvas workspaces unmount that chrome. Selection state remains in the
 * zustand store across view switches.
 */
import type { AppTab } from "./store";

/** True iff the given workspace tab hosts an editable FlowCanvas. */
export function showCanvasSidebars(tab: AppTab): boolean {
  return tab === "editor";
}
