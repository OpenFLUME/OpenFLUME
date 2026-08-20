import React from "react";
import { Handle, Position } from "@xyflow/react";
import { sourceHandleId, targetHandleId } from "../connectionGeometry";

/**
 * The eight connection handles every canvas node exposes: one source and one
 * target handle per side, with ids matching connectionGeometry. The canvas
 * picks the side pair per edge from endpoint geometry, so all four sides must
 * exist for both the source and the target role.
 *
 * Stacking: the two handles on a side occupy the same spot; the LAST one
 * rendered receives drag starts. Per side the topmost handle keeps the
 * long-standing single-handle semantics (top/left = target, bottom/right =
 * source), so click/connect ergonomics are unchanged. React Flow's loose
 * connection mode also prefers the opposite handle type on drop when handles
 * overlap, so either handle of a pair connects correctly.
 */
export default function ConnectionHandles({
  style,
  withTestIds = false,
  onHoverChange,
}: {
  style: React.CSSProperties;
  withTestIds?: boolean;
  onHoverChange?: (hovered: boolean) => void;
}) {
  const hoverProps = onHoverChange
    ? {
        onMouseEnter: () => onHoverChange(true),
        onMouseLeave: () => onHoverChange(false),
      }
    : {};
  return (
    <>
      <Handle
        type="source"
        id={sourceHandleId("top")}
        position={Position.Top}
        style={style}
        {...hoverProps}
      />
      <Handle
        type="target"
        id={targetHandleId("top")}
        position={Position.Top}
        data-testid={withTestIds ? "handle-top" : undefined}
        style={style}
        {...hoverProps}
      />
      <Handle
        type="target"
        id={targetHandleId("right")}
        position={Position.Right}
        style={style}
        {...hoverProps}
      />
      <Handle
        type="source"
        id={sourceHandleId("right")}
        position={Position.Right}
        data-testid={withTestIds ? "handle-right" : undefined}
        style={style}
        {...hoverProps}
      />
      <Handle
        type="target"
        id={targetHandleId("bottom")}
        position={Position.Bottom}
        style={style}
        {...hoverProps}
      />
      <Handle
        type="source"
        id={sourceHandleId("bottom")}
        position={Position.Bottom}
        data-testid={withTestIds ? "handle-bottom" : undefined}
        style={style}
        {...hoverProps}
      />
      <Handle
        type="source"
        id={sourceHandleId("left")}
        position={Position.Left}
        style={style}
        {...hoverProps}
      />
      <Handle
        type="target"
        id={targetHandleId("left")}
        position={Position.Left}
        data-testid={withTestIds ? "handle-left" : undefined}
        style={style}
        {...hoverProps}
      />
    </>
  );
}
