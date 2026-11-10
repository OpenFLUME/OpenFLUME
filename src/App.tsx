import React from "react";
import "./ui/shell/shells.css";
import { useGlobalShortcuts, useLiveValidation } from "./ui/shell/appBehavior";
import { parseEmbedMode, buildFullEditorUrl } from "./ui/embedMode";
import { setEmbedReadOnly } from "./ui/utils";
import StudioShell from "./ui/shell/studio/StudioShell";

export default function App(): React.ReactElement {
  // Cross-shell behavior: keyboard shortcuts and live validation belong to
  // the app, not to the layout.
  useGlobalShortcuts();
  useLiveValidation();

  // Read-only embed mode (issue #26): ?embed=1 disables every localStorage
  // write and shows an "Open in full editor" link instead of editing chrome.
  const embed = parseEmbedMode(window.location.search);
  React.useEffect(() => {
    setEmbedReadOnly(embed);
    document.body.classList.toggle("embed-mode", embed);
  }, [embed]);

  return (
    <>
      {embed && (
        <a
          href={buildFullEditorUrl(window.location.href)}
          data-testid="embed-open-full-editor"
          style={{ display: "block", padding: "4px 12px", fontSize: 13 }}
        >
          Open in full editor
        </a>
      )}
      <StudioShell />
    </>
  );
}
