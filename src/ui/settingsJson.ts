import type { NetworkConfig } from "./types";

export type AdvancedConfigSection = "registers" | "logic" | "controllers";
export type AdvancedConfigValue =
  | NetworkConfig["registers"]
  | NetworkConfig["logic"]
  | NetworkConfig["controllers"];

export function parseAdvancedConfigJson(
  section: AdvancedConfigSection,
  text: string,
):
  | { value: AdvancedConfigValue; error?: undefined }
  | { value?: undefined; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (section === "registers") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { error: "Registers must be a JSON object." };
    if (
      Object.values(value).some(
        (entry) => typeof entry !== "number" || !Number.isFinite(entry),
      )
    ) {
      return { error: "Register values must be finite numbers." };
    }
  } else {
    if (!Array.isArray(value))
      return {
        error: `${section === "logic" ? "Logic rules" : "Controllers"} must be a JSON array.`,
      };
    if (
      value.some(
        (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
      )
    ) {
      return { error: "Each array entry must be a JSON object." };
    }
  }
  return { value: value as AdvancedConfigValue };
}
