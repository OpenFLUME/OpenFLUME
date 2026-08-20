/**
 * ViewErrorBoundary — unit-level class-logic coverage (vitest runs in a node
 * environment with no DOM renderer, so we exercise getDerivedStateFromError /
 * componentDidCatch / render directly rather than mounting).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import ViewErrorBoundary from "../components/ViewErrorBoundary";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ViewErrorBoundary", () => {
  it("renders children untouched when there is no error (SSR smoke)", () => {
    const html = renderToString(
      <ViewErrorBoundary name="Canvas view">
        <div data-testid="child-ok">still here</div>
      </ViewErrorBoundary>,
    );
    expect(html).toContain("still here");
    expect(html).not.toContain("view-error-boundary");
  });

  it("getDerivedStateFromError captures the error into state", () => {
    const err = new Error("RangeError: Invalid array length");
    expect(ViewErrorBoundary.getDerivedStateFromError(err)).toEqual({
      error: err,
    });
  });

  it("componentDidCatch logs the error and component stack to the console", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const inst = new ViewErrorBoundary({
      name: "Analysis view",
      children: null,
    });
    const err = new Error("boom");
    inst.componentDidCatch(err, {
      componentStack: "at InteractiveChart",
    } as React.ErrorInfo);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[ViewErrorBoundary:Analysis view]");
    expect(spy.mock.calls[0][1]).toBe(err);
  });

  it("error-state render offers message, Reload view, and Save model", () => {
    const inst = new ViewErrorBoundary({
      name: "Analysis view",
      children: <div>child</div>,
    });
    inst.state = { error: new Error("Invalid array length") };
    const tree = inst.render() as React.ReactElement;
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain("view-error-boundary");
    expect(serialized).toContain("view-error-retry");
    expect(serialized).toContain("view-error-save");
    expect(serialized).toContain("Invalid array length");
    expect(serialized).toContain("Analysis view");
  });

  it("handleRetry clears the error state (re-renders children)", () => {
    const inst = new ViewErrorBoundary({
      name: "Canvas view",
      children: <div>child</div>,
    });
    // Capture the setState payload without a mounted renderer.
    let applied: any = null;
    (inst as any).setState = (next: any) => {
      applied = next;
    };
    inst.handleRetry();
    expect(applied).toEqual({ error: null });
  });
});
