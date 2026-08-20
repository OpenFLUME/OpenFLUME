import { parseExpression, ExpressionError } from "../usercode/expression";

/** Parse-check an expression string without evaluating it. */
export function checkExpression(source: unknown, label: string): string | null {
  if (typeof source !== "string" || source.trim().length === 0) {
    return `${label} must be a non-empty expression string`;
  }
  try {
    parseExpression(source);
    return null;
  } catch (e) {
    return `${label}: ${e instanceof ExpressionError ? e.message : String(e)}`;
  }
}
