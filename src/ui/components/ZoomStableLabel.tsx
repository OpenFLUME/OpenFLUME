/**
 * ZoomStableLabel — anchors canvas text at a flow-coordinate point while
 * keeping it a constant SCREEN pixel size at any zoom (the wrapper lives
 * inside the zoomed viewport; the inner box counter-scales by 1/zoom).
 *
 * The anchor is a zero-size flex point, so content stays centered on it
 * without translate-percentage/scale composition surprises.
 */
import React from "react";
import { counterScale } from "../zoomTiers";

interface ZoomStableLabelProps {
  zoom: number;
  /** Anchor offset within the positioned parent (flow units / %). */
  left: number | string;
  top: number | string;
  /** Vertical anchoring: content hangs below the anchor or is centered on it. */
  valign?: "top" | "center";
  /** pointer-events for the content box (wrapper itself never intercepts). */
  interactive?: boolean;
  children: React.ReactNode;
}

export default function ZoomStableLabel({
  zoom,
  left,
  top,
  valign = "top",
  interactive = false,
  children,
}: ZoomStableLabelProps) {
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: 0,
        height: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: valign === "center" ? "center" : "flex-start",
        pointerEvents: "none",
        zIndex: 10,
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          width: "max-content",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
          transform: counterScale(zoom),
          transformOrigin: valign === "center" ? "center center" : "top center",
          pointerEvents: interactive ? "auto" : "none",
        }}
      >
        {children}
      </div>
    </div>
  );
}
