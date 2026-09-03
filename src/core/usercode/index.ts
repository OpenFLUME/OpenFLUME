/**
 * Sandboxed user code — public entry point.
 *
 *   expression.ts   Expression language (parseExpression/compileExpression/
 *                   evaluateExpression) used by logic rules, controllers, and
 *                   parameter bindings.
 *   sandbox.ts       User-defined component compiler (defineComponent /
 *                   compileUserComponent) backing components/userDefinedComponent.ts,
 *                   plus syntax-only checking for the UI editor.
 *   rewriteIds.ts    Entity-id rewriting inside formula expressions
 *                   (rewriteExpressionIds) for authoring transforms.
 */
export {
  ExpressionError,
  parseExpression,
  compileExpression,
  evaluateExpression,
  expressionBuiltinNames,
} from "./expression";
export type {
  ExprValue,
  ExprScope,
  ExprNode,
  BinaryOp,
  CompiledExpression,
} from "./expression";

export {
  UserCodeError,
  defineComponent,
  compileUserComponent,
  compileInlinePressureDrop,
  checkUserCodeSyntax,
} from "./sandbox";
export type {
  UserCodePhase,
  UserComponentParamSpec,
  UserComponentMetadata,
  UserPressureDropArgs,
  UserHeatArgs,
  UserComponentDefinition,
} from "./sandbox";

export { rewriteExpressionIds } from "./rewriteIds";
