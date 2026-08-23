import React from "react";
import "./ui/shell/shells.css";
import { useGlobalShortcuts, useLiveValidation } from "./ui/shell/appBehavior";
import StudioShell from "./ui/shell/studio/StudioShell";

export default function App(): React.ReactElement {
  // Cross-shell behavior: keyboard shortcuts and live validation belong to
  // the app, not to the layout.
  useGlobalShortcuts();
  useLiveValidation();

  return <StudioShell />;
}
