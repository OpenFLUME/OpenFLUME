/**
 * FindingsStrip — what a reviewer would circle, said out loud.
 *
 * Deterministic readings of the displayed result (core/resultFindings.ts) with
 * their reasons attached, each row selecting the elements it is about. Silent
 * when there is nothing to say: the panel follows the same rule as the project
 * outline's status icons, where quiet means healthy and any mark means look.
 */
import type {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "../types";
import { assessResult, type FindingSeverity } from "../../core";

export interface FindingsStripProps {
  displayConfig: NetworkConfig;
  result: SteadyResult | TransientResult | null;
  onSelectElement?: (selection: Selection) => void;
}

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  error: "Error",
  warn: "Warning",
  info: "Note",
};

export default function FindingsStrip({
  displayConfig,
  result,
  onSelectElement,
}: FindingsStripProps) {
  const findings = assessResult(displayConfig, result);
  if (findings.length === 0) return null;

  return (
    <ul className="findings-strip" data-testid="findings-strip">
      {findings.map((finding) => {
        const target = finding.targets[0];
        const clickable = target !== undefined && onSelectElement !== undefined;
        const body = (
          <>
            <span
              className={`findings-strip__severity findings-strip__severity--${finding.severity}`}
            >
              {SEVERITY_LABEL[finding.severity]}
            </span>
            <span className="findings-strip__label">{finding.label}</span>
            <span className="findings-strip__detail">{finding.detail}</span>
          </>
        );
        return (
          <li
            key={finding.id}
            className={`findings-strip__row findings-strip__row--${finding.severity}`}
            data-testid={`finding-${finding.id}`}
          >
            {clickable ? (
              <button
                type="button"
                className="findings-strip__btn"
                data-testid={`finding-select-${finding.id}`}
                title={`Select ${target.id} on the diagram`}
                onClick={() =>
                  onSelectElement?.({
                    kind: target.kind,
                    id: target.id,
                  } as Selection)
                }
              >
                {body}
              </button>
            ) : (
              <span className="findings-strip__btn">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
