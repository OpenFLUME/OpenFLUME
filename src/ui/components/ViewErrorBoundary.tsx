/**
 * ViewErrorBoundary — a render-crash in one workspace view (canvas, analysis,
 * model table, palette, property panel) must never white-screen the whole
 * app: the toolbar (run/save/history) and the session survive. Shows a card
 * with the error message, a Reload-view retry, and a Save-model escape hatch
 * so work is never lost to a rendering bug.
 */
import React from "react";
import { useStore } from "../store";
import { downloadModelText } from "../utils";

interface ViewErrorBoundaryProps {
  /** Human-readable region name shown in the fallback ("Analysis view"). */
  name: string;
  children: React.ReactNode;
}

interface ViewErrorBoundaryState {
  error: Error | null;
}

export default class ViewErrorBoundary extends React.Component<
  ViewErrorBoundaryProps,
  ViewErrorBoundaryState
> {
  state: ViewErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ViewErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Full detail to the console; the UI shows only the message.
    console.error(
      `[ViewErrorBoundary:${this.props.name}]`,
      error,
      info?.componentStack ?? "",
    );
  }

  /** Retry: drop the error state and re-render the subtree. */
  handleRetry = (): void => {
    this.setState({ error: null });
  };

  /** Save model: the crash must not be able to destroy the session's work. */
  handleSaveModel = (): void => {
    try {
      const s = useStore.getState();
      // The whole file, variants included — a crash must not silently drop
      // the alternatives the user built.
      downloadModelText(s.baseConfig);
      s.markSaved();
    } catch (err) {
      console.error("[ViewErrorBoundary] Save model failed:", err);
    }
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return <>{this.props.children}</>;
    return (
      <div
        data-testid="view-error-boundary"
        role="alert"
        style={{
          height: "100%",
          minHeight: 160,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          overflow: "auto",
        }}
      >
        <div className="card" style={{ maxWidth: 520 }}>
          <div className="banner banner--error" style={{ marginBottom: 12 }}>
            <strong>{this.props.name}</strong> hit a rendering error. The rest
            of the app (toolbar, run history, saved session) is intact.
          </div>
          <div
            data-testid="view-error-message"
            style={{
              fontFamily: "monospace",
              fontSize: 12,
              color: "var(--text-2)",
              marginBottom: 12,
              wordBreak: "break-word",
            }}
          >
            {error.message || String(error)}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="view-error-retry"
              className="btn btn--primary"
              onClick={this.handleRetry}
            >
              Reload view
            </button>
            <button
              type="button"
              data-testid="view-error-save"
              className="btn"
              onClick={this.handleSaveModel}
              title="Download the current model (.fn file, unchanged by this error)"
            >
              Save model
            </button>
          </div>
        </div>
      </div>
    );
  }
}
