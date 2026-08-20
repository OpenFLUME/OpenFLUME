/**
 * Declarative component-library shape checks. Code bodies are
 * COMPILE-CHECKED here (parsed / new Function) but never executed —
 * core/solver/context.ts compiles the referenced entries for real.
 */
import type { ResolvedNetworkConfig } from "../schema";
import { checkUserCodeSyntax } from "../usercode/sandbox";

export function validateComponentLibrary(
  config: ResolvedNetworkConfig,
): string[] {
  const errors: string[] = [];
  if (config.componentLibrary === undefined) return errors;

  for (const [name, entry] of Object.entries(config.componentLibrary)) {
    const format = entry.format ?? "defineComponent";
    if (format !== "defineComponent" && format !== "inline") {
      errors.push(
        `Component library "${name}" format must be 'defineComponent' or 'inline'`,
      );
      continue;
    }
    const syntaxErr = checkUserCodeSyntax(entry.code, format);
    if (syntaxErr) {
      errors.push(
        `Component library "${name}" code does not compile: ${syntaxErr}`,
      );
    }
  }

  return errors;
}
