import type { UserComponentMetadata, UserComponentParamSpec } from "../core";
import { parseLocalComponent } from "./componentLibrary";

export interface ComponentDraft {
  name: string;
  label: string;
  description: string;
  version: string;
  params: string | UserComponentParamSpec[];
  pressureDropBody: string;
  heatBody?: string;
}

export type ComponentDraftField =
  "name" | "params" | "pressureDropBody" | "heatBody";

export interface ComponentDraftValidation {
  errors: Partial<Record<ComponentDraftField, string>>;
  params?: UserComponentParamSpec[];
  source?: string;
}

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;
const PARAM_KEYS = new Set(["name", "label", "unit", "default", "min", "max"]);

export function suggestedComponentFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_.]{2,}/g, "-");
  return `${slug || "component"}.component.js`;
}

function parseParams(
  value: ComponentDraft["params"],
): UserComponentParamSpec[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(
        `Parameters must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!Array.isArray(parsed))
    throw new Error("Parameters must be a JSON array.");

  const names = new Set<string>();
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Parameter ${index + 1} must be an object.`);
    }
    const candidate = item as Record<string, unknown>;
    const unknownKey = Object.keys(candidate).find(
      (key) => !PARAM_KEYS.has(key),
    );
    if (unknownKey)
      throw new Error(
        `Parameter ${index + 1} has unknown field "${unknownKey}".`,
      );
    if (typeof candidate.name !== "string" || !SAFE_KEY.test(candidate.name)) {
      throw new Error(
        `Parameter ${index + 1} name must use only letters, numbers, dots, underscores, or hyphens.`,
      );
    }
    if (names.has(candidate.name))
      throw new Error(`Parameter name "${candidate.name}" is duplicated.`);
    names.add(candidate.name);
    for (const key of ["label", "unit"] as const) {
      if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
        throw new Error(
          `Parameter "${candidate.name}" ${key} must be a string.`,
        );
      }
    }
    for (const key of ["default", "min", "max"] as const) {
      if (key === "default" && candidate[key] === undefined) {
        throw new Error(
          `Parameter "${candidate.name}" requires a finite numeric default.`,
        );
      }
      if (
        candidate[key] !== undefined &&
        (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key]))
      ) {
        throw new Error(
          `Parameter "${candidate.name}" ${key} must be a finite number.`,
        );
      }
    }
    if (
      typeof candidate.min === "number" &&
      typeof candidate.max === "number" &&
      candidate.min > candidate.max
    ) {
      throw new Error(`Parameter "${candidate.name}" min cannot exceed max.`);
    }
    if (
      typeof candidate.default === "number" &&
      ((typeof candidate.min === "number" &&
        candidate.default < candidate.min) ||
        (typeof candidate.max === "number" &&
          candidate.default > candidate.max))
    ) {
      throw new Error(
        `Parameter "${candidate.name}" default must be within its bounds.`,
      );
    }
    return candidate as unknown as UserComponentParamSpec;
  });
}

function functionSource(name: "pressureDrop" | "heat", body: string): string {
  const indented = body
    .trim()
    .split("\n")
    .map((line) => `    ${line.replace(/\s+$/g, "")}`)
    .join("\n");
  return `  ${name}(args) {\n${indented}\n  }`;
}

export function generateComponentSource(
  draft: ComponentDraft,
  params = parseParams(draft.params),
): string {
  const metadata: UserComponentMetadata = { name: draft.name.trim() };
  if (draft.label.trim()) metadata.label = draft.label.trim();
  if (draft.description.trim()) metadata.description = draft.description.trim();
  if (draft.version.trim()) metadata.version = draft.version.trim();
  if (params.length > 0) metadata.params = params;

  const metadataSource = JSON.stringify(metadata, null, 2).replace(
    /\n/g,
    "\n  ",
  );
  const members = [
    `  metadata: ${metadataSource}`,
    functionSource("pressureDrop", draft.pressureDropBody),
  ];
  if (draft.heatBody?.trim())
    members.push(functionSource("heat", draft.heatBody));
  return `defineComponent({\n${members.join(",\n")}\n});\n`;
}

export function validateComponentDraft(
  draft: ComponentDraft,
): ComponentDraftValidation {
  const errors: ComponentDraftValidation["errors"] = {};
  if (!draft.name.trim()) errors.name = "Component key is required.";
  else if (!SAFE_KEY.test(draft.name.trim()))
    errors.name = "Use only letters, numbers, dots, underscores, or hyphens.";
  if (!draft.pressureDropBody.trim())
    errors.pressureDropBody = "Pressure-drop body is required.";
  else {
    try {
      new Function("args", `"use strict";\n${draft.pressureDropBody}`);
    } catch (error) {
      errors.pressureDropBody = `Invalid function body: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (draft.heatBody?.trim()) {
    try {
      new Function("args", `"use strict";\n${draft.heatBody}`);
    } catch (error) {
      errors.heatBody = `Invalid function body: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  let params: UserComponentParamSpec[] | undefined;
  try {
    params = parseParams(draft.params);
  } catch (error) {
    errors.params = error instanceof Error ? error.message : String(error);
  }

  if (Object.keys(errors).length === 0 && params) {
    try {
      const source = generateComponentSource(draft, params);
      parseLocalComponent({
        path: suggestedComponentFileName(draft.name),
        source,
        modifiedAt: 0,
      });
      return { errors, params, source };
    } catch (error) {
      errors.pressureDropBody =
        error instanceof Error ? error.message : String(error);
    }
  }
  return { errors, params };
}
