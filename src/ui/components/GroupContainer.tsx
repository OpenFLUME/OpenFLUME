import React from "react";
import { useViewport } from "@xyflow/react";
import { useStore } from "../store";
import { GROUP_FILL, GROUP_LINE } from "../canvasPalette";
import { counterScale } from "../zoomTiers";
import { GROUP_WIDTH, GROUP_HEIGHT } from "../canvasGeometry";
import ConnectionHandles from "./ConnectionHandles";

interface GroupContainerData {
  groupId: string;
  label: string;
  memberCount: number;
  selected: boolean;
}

export default React.memo(function GroupContainer({
  data,
  id,
}: {
  data: GroupContainerData;
  id: string;
}) {
  const { groupId, label, memberCount, selected } = data;
  const openGroupTab = useStore((s) => s.openGroupTab);
  const { zoom } = useViewport();

  const width = GROUP_WIDTH;
  const height = GROUP_HEIGHT;

  const handleStyleBase: React.CSSProperties = {
    width: 8,
    height: 8,
    opacity: 0.001,
    background: "transparent",
    border: "none",
    borderRadius: "50%",
    zIndex: 20,
  };

  return (
    <div
      data-testid={`group-${groupId}`}
      onDoubleClick={() => openGroupTab(groupId)}
      style={{
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        cursor: "pointer",
      }}
    >
      <svg width={width} height={height}>
        <rect
          x={2}
          y={2}
          width={width - 4}
          height={height - 4}
          rx={12}
          fill={GROUP_FILL}
          stroke={GROUP_LINE}
          strokeWidth={2}
          strokeDasharray="6 4"
        />
      </svg>
      {selected && (
        <div
          style={{
            position: "absolute",
            inset: -3,
            border: "2px solid var(--select)",
            borderRadius: 15,
            boxShadow: "0 0 6px rgba(201, 154, 67, 0.45)",
            pointerEvents: "none",
          }}
        />
      )}
      {/* Subnetwork text stays screen-size invariant; the subnetwork label is
          the one label kept visible at every zoom tier. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 0,
          height: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
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
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--info)",
            }}
          >
            Subnetwork
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text-1)",
              textAlign: "center",
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              data-testid={`subnetwork-members-${groupId}`}
              style={{
                fontSize: 10,
                color: "var(--text-2)",
                background: "var(--bg-0)",
                padding: "2px 8px",
                borderRadius: 10,
              }}
            >
              {memberCount} member{memberCount === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              data-testid={`open-subnetwork-${groupId}`}
              className="btn btn--sm"
              style={{
                pointerEvents: "auto",
                padding: "1px 8px",
                fontSize: 10,
              }}
              title="Open subnetwork tab (or double-click)"
              aria-label={`Open subnetwork ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                openGroupTab(groupId);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              ⧉ Open
            </button>
          </div>
        </div>
      </div>
      <ConnectionHandles style={handleStyleBase} />
    </div>
  );
});
