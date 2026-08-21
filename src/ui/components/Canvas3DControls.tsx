/**
 * Canvas3DControls — orientation chrome for the projected 3D view.
 *
 * Two jobs: name the standard viewpoints, and answer "which way am I looking?"
 * An orthographic projection of a sparse network gives very few depth cues, so
 * without a triad an orbited model is easy to misread. The triad is a passive
 * indicator; orbiting itself is a drag on the canvas (see FlowCanvas).
 */
import { AXIS_X, AXIS_Y, AXIS_Z } from "../canvasPalette";
import {
  project,
  VIEW_PRESETS,
  VIEW_PRESET_LABELS,
  VIEW_PRESET_ORDER,
  isFrontCamera,
  type Camera3D,
  type ViewPresetId,
} from "../projection3d";

const TRIAD_SIZE = 62;
const TRIAD_RADIUS = 20;

const AXES: Array<{
  id: "x" | "y" | "z";
  label: string;
  color: string;
  vector: { x: number; y: number; z: number };
}> = [
  { id: "x", label: "X", color: AXIS_X, vector: { x: 1, y: 0, z: 0 } },
  { id: "y", label: "Y", color: AXIS_Y, vector: { x: 0, y: 1, z: 0 } },
  { id: "z", label: "Z", color: AXIS_Z, vector: { x: 0, y: 0, z: 1 } },
];

/**
 * Axis triad. Axes are drawn back-to-front by depth so the one pointing at the
 * viewer overlaps the others, which is the only cue distinguishing an axis
 * coming toward you from the same axis going away.
 */
function AxisTriad({ camera }: { camera: Camera3D }) {
  const centre = TRIAD_SIZE / 2;
  const drawn = AXES.map((axis) => {
    const p = project(axis.vector, camera);
    return {
      ...axis,
      screenX: p.x * TRIAD_RADIUS,
      screenY: p.y * TRIAD_RADIUS,
      depth: p.depth,
    };
  }).sort((a, b) => b.depth - a.depth);

  return (
    <svg
      width={TRIAD_SIZE}
      height={TRIAD_SIZE}
      viewBox={`0 0 ${TRIAD_SIZE} ${TRIAD_SIZE}`}
      role="img"
      aria-label={`Axis orientation: yaw ${Math.round(camera.yaw)} degrees, pitch ${Math.round(camera.pitch)} degrees`}
      data-testid="canvas-3d-triad"
    >
      {drawn.map((axis) => {
        const tipX = centre + axis.screenX;
        const tipY = centre + axis.screenY;
        // An axis pointing nearly at the camera projects to almost nothing;
        // its letter alone has to carry it, so skip the degenerate stub.
        const foreshortened = Math.hypot(axis.screenX, axis.screenY) < 3;
        return (
          <g key={axis.id}>
            {!foreshortened && (
              <line
                x1={centre}
                y1={centre}
                x2={tipX}
                y2={tipY}
                stroke={axis.color}
                strokeWidth={1.6}
                strokeLinecap="round"
              />
            )}
            <circle cx={tipX} cy={tipY} r={6.5} fill={axis.color} />
            <text
              x={tipX}
              y={tipY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={8}
              fontWeight={700}
              fill="#12151a"
            >
              {axis.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Canvas3DControls({
  camera,
  onCameraChange,
}: {
  camera: Camera3D;
  onCameraChange: (camera: Camera3D) => void;
}) {
  const activePreset = (Object.keys(VIEW_PRESETS) as ViewPresetId[]).find(
    (id) =>
      VIEW_PRESETS[id].yaw === camera.yaw &&
      VIEW_PRESETS[id].pitch === camera.pitch,
  );

  return (
    <div className="canvas-3d-controls" data-testid="canvas-3d-controls">
      <AxisTriad camera={camera} />
      <div className="canvas-3d-controls__body">
        <div
          className="canvas-3d-controls__presets"
          role="group"
          aria-label="Camera presets"
        >
          {VIEW_PRESET_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              className="chip canvas-3d-controls__preset"
              data-testid={`canvas-3d-preset-${id}`}
              aria-pressed={activePreset === id}
              title={
                id === "front"
                  ? "Front — matches the 2D schematic layout"
                  : `${VIEW_PRESET_LABELS[id]} view`
              }
              onClick={() => onCameraChange(VIEW_PRESETS[id])}
            >
              {VIEW_PRESET_LABELS[id]}
            </button>
          ))}
        </div>
        <div
          className="canvas-3d-controls__readout"
          data-testid="canvas-3d-readout"
        >
          {isFrontCamera(camera)
            ? "Front · matches 2D"
            : `yaw ${Math.round(camera.yaw)}° · pitch ${Math.round(camera.pitch)}°`}
        </div>
        <div className="canvas-3d-controls__hint">
          Drag to orbit · right-drag to pan
        </div>
      </div>
    </div>
  );
}
