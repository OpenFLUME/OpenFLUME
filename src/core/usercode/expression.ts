/**
 * Safe arithmetic/logic expression language for user-authored logic and
 * component snippets.  Hand-written tokenizer + Pratt parser + tree-walking
 * evaluator — NO eval / new Function anywhere in this file, so expressions
 * cannot touch scope beyond what the caller passes in.
 *
 * Supported syntax:
 *   literals:     12  1.5e-3  'nodeId'  "nodeId"
 *   identifiers:  t  node  branch  solid  reg  params  (scope-provided)
 *   arithmetic:   + - * / % ^   (unary - + !; ^ is right-associative and
 *                 binds tighter than unary minus, so -2^2 = -(2^2) = -4)
 *   comparisons:  < <= > >= == !=
 *   logic:        && || !  (short-circuiting; return booleans; truthiness:
 *                 nonzero number, nonempty string, boolean)
 *   ternary:      cond ? a : b
 *   calls:        f(a, b)           — builtins or scope-provided functions
 *   property:     node('n1').P      — plain-object own properties only;
 *                 __proto__/constructor/prototype are blocked
 *
 * Builtin functions: min max abs sqrt exp log sin cos tanh clamp(x,lo,hi)
 * smoothstep(e0,e1,x).  Constant `pi`.
 *
 * All errors are ExpressionError with a `phase` of 'parse' or 'evaluate'
 * and (for parse errors) a character `pos` into the source.
 */

export type ExprValue = number | string | boolean;
export type ExprScope = Record<string, unknown>;

export class ExpressionError extends Error {
  readonly phase: "parse" | "evaluate";
  readonly pos?: number;

  constructor(phase: "parse" | "evaluate", message: string, pos?: number) {
    super(pos !== undefined ? `${message} (at ${pos})` : message);
    this.name = "ExpressionError";
    this.phase = phase;
    this.pos = pos;
  }
}

/* ------------------------------------------------------------------ */
/* AST                                                                 */
/* ------------------------------------------------------------------ */

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||";

export type ExprNode =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "ident"; name: string }
  | { type: "unary"; op: "-" | "+" | "!"; arg: ExprNode }
  | { type: "binary"; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { type: "cond"; cond: ExprNode; then: ExprNode; else: ExprNode }
  | { type: "call"; callee: ExprNode; args: ExprNode[] }
  | { type: "prop"; object: ExprNode; name: string };

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "str"; value: string; pos: number }
  | { kind: "ident"; value: string; pos: number }
  | { kind: "op"; value: string; pos: number }
  | { kind: "eof"; pos: number };

const OPS = [
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "!",
  "?",
  ":",
  "(",
  ")",
  ",",
  ".",
];

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isIdentStart(c: string): boolean {
  return (
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$"
  );
}

function isIdentChar(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // Number: digits with optional . and exponent, or leading .digits
    if (
      isDigit(c) ||
      (c === "." && i + 1 < src.length && isDigit(src[i + 1]))
    ) {
      const start = i;
      while (i < src.length && isDigit(src[i])) i++;
      if (src[i] === ".") {
        i++;
        while (i < src.length && isDigit(src[i])) i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (j < src.length && isDigit(src[j])) {
          i = j;
          while (i < src.length && isDigit(src[i])) i++;
        }
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ExpressionError(
          "parse",
          `Invalid number literal "${text}"`,
          start,
        );
      }
      tokens.push({ kind: "num", value, pos: start });
      continue;
    }
    // String literal
    if (c === "'" || c === '"') {
      const start = i;
      const quote = c;
      i++;
      let out = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const esc = src[i + 1];
          if (esc === "n") out += "\n";
          else if (esc === "t") out += "\t";
          else out += esc; // \' \" \\ and any other char literally
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i >= src.length) {
        throw new ExpressionError(
          "parse",
          "Unterminated string literal",
          start,
        );
      }
      i++; // closing quote
      tokens.push({ kind: "str", value: out, pos: start });
      continue;
    }
    // Identifier
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentChar(src[i])) i++;
      tokens.push({ kind: "ident", value: src.slice(start, i), pos: start });
      continue;
    }
    // Operator (longest match first)
    let matched: string | undefined;
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched === undefined) {
      throw new ExpressionError("parse", `Unexpected character "${c}"`, i);
    }
    tokens.push({ kind: "op", value: matched, pos: i });
    i += matched.length;
  }
  tokens.push({ kind: "eof", pos: src.length });
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Parser (Pratt)                                                      */
/* ------------------------------------------------------------------ */

/** Left binding power of infix operators. */
const INFIX_BP: Record<string, number> = {
  "||": 20,
  "&&": 30,
  "==": 40,
  "!=": 40,
  "<": 50,
  "<=": 50,
  ">": 50,
  ">=": 50,
  "+": 60,
  "-": 60,
  "*": 70,
  "/": 70,
  "%": 70,
  "^": 80,
};
/** Binding power of the ternary `?:` (right-associative). */
const TERNARY_BP = 10;
/** Binding power of postfix call/property. */
const POSTFIX_BP = 100;

export function parseExpression(source: string): ExprNode {
  const tokens = tokenize(source);
  let index = 0;

  function peek(): Token {
    return tokens[index];
  }

  function next(): Token {
    return tokens[index++];
  }

  function expectOp(value: string): void {
    const tok = next();
    if (tok.kind !== "op" || tok.value !== value) {
      throw new ExpressionError("parse", `Expected "${value}"`, tok.pos);
    }
  }

  function parsePrimary(): ExprNode {
    const tok = next();
    if (tok.kind === "num") return { type: "num", value: tok.value };
    if (tok.kind === "str") return { type: "str", value: tok.value };
    if (tok.kind === "ident") return { type: "ident", name: tok.value };
    if (tok.kind === "op") {
      if (tok.value === "(") {
        const inner = parseExpr(0);
        expectOp(")");
        return inner;
      }
      if (tok.value === "-" || tok.value === "+" || tok.value === "!") {
        // Unary binds LOOSER than '^' (rbp 75 < 80) so -2^2 = -(2^2).
        const arg = parseExpr(75);
        return { type: "unary", op: tok.value, arg };
      }
    }
    throw new ExpressionError("parse", "Expected a value", tok.pos);
  }

  function parseExpr(minBp: number): ExprNode {
    let left = parsePrimary();
    for (;;) {
      const tok = peek();
      if (tok.kind !== "op") break;

      // Postfix: call and property access
      if (tok.value === "(" && POSTFIX_BP > minBp) {
        next();
        const args: ExprNode[] = [];
        if (!(
          peek().kind === "op" && (peek() as { value: string }).value === ")"
        )) {
          for (;;) {
            args.push(parseExpr(0));
            const sep = peek();
            if (sep.kind === "op" && (sep as { value: string }).value === ",") {
              next();
              continue;
            }
            break;
          }
        }
        expectOp(")");
        left = { type: "call", callee: left, args };
        continue;
      }
      if (tok.value === "." && POSTFIX_BP > minBp) {
        next();
        const name = next();
        if (name.kind !== "ident") {
          throw new ExpressionError(
            "parse",
            'Expected a property name after "."',
            name.pos,
          );
        }
        left = { type: "prop", object: left, name: name.value };
        continue;
      }

      // Ternary
      if (tok.value === "?" && TERNARY_BP >= minBp) {
        next();
        const thenBranch = parseExpr(0);
        expectOp(":");
        const elseBranch = parseExpr(TERNARY_BP - 1);
        left = { type: "cond", cond: left, then: thenBranch, else: elseBranch };
        continue;
      }

      // Infix
      const bp = INFIX_BP[tok.value];
      if (bp === undefined || bp < minBp) break;
      next();
      // '^' is right-associative: recurse with bp (not bp+1).
      const right = parseExpr(tok.value === "^" ? bp : bp + 1);
      left = { type: "binary", op: tok.value as BinaryOp, left, right };
    }
    return left;
  }

  const ast = parseExpr(0);
  const end = peek();
  if (end.kind !== "eof") {
    throw new ExpressionError("parse", "Unexpected trailing input", end.pos);
  }
  return ast;
}

/* ------------------------------------------------------------------ */
/* Evaluator                                                           */
/* ------------------------------------------------------------------ */

const BLOCKED_PROPS = new Set(["__proto__", "constructor", "prototype"]);

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return false;
}

function toNumber(v: unknown, what: string): number {
  if (typeof v !== "number") {
    throw new ExpressionError(
      "evaluate",
      `${what} requires numbers (got ${describe(v)})`,
    );
  }
  return v;
}

function describe(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : String(v);
  if (typeof v === "string") return `string "${v}"`;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "function") return "a function";
  if (v === null || v === undefined) return String(v);
  return "an object";
}

function fn1(f: (x: number) => number): (x: unknown) => number {
  return (x: unknown) => f(toNumber(x, "builtin argument"));
}

const BUILTINS: Record<string, unknown> = Object.freeze({
  min: (...args: unknown[]) => Math.min(...args.map((a) => toNumber(a, "min"))),
  max: (...args: unknown[]) => Math.max(...args.map((a) => toNumber(a, "max"))),
  abs: fn1(Math.abs),
  sqrt: fn1(Math.sqrt),
  exp: fn1(Math.exp),
  log: fn1(Math.log),
  sin: fn1(Math.sin),
  cos: fn1(Math.cos),
  tanh: fn1(Math.tanh),
  clamp: (x: unknown, lo: unknown, hi: unknown) => {
    const xv = toNumber(x, "clamp");
    const loV = toNumber(lo, "clamp");
    const hiV = toNumber(hi, "clamp");
    return Math.min(Math.max(xv, loV), hiV);
  },
  smoothstep: (e0: unknown, e1: unknown, x: unknown) => {
    const e0v = toNumber(e0, "smoothstep");
    const e1v = toNumber(e1, "smoothstep");
    const xv = toNumber(x, "smoothstep");
    if (e1v === e0v) return xv < e0v ? 0 : 1;
    const t = Math.min(Math.max((xv - e0v) / (e1v - e0v), 0), 1);
    return t * t * (3 - 2 * t);
  },
  pi: Math.PI,
});

function evalBinary(op: BinaryOp, left: unknown, right: unknown): ExprValue {
  switch (op) {
    case "&&":
      return truthy(left) && truthy(right);
    case "||":
      return truthy(left) || truthy(right);
    case "==": {
      if (typeof left === typeof right) return left === right;
      return false;
    }
    case "!=": {
      if (typeof left === typeof right) return left !== right;
      return true;
    }
  }
  const a = toNumber(left, `operator "${op}"`);
  const b = toNumber(right, `operator "${op}"`);
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "%":
      return a % b;
    case "^":
      return Math.pow(a, b);
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      throw new ExpressionError("evaluate", `Unknown operator "${op}"`);
  }
}

function evalNode(node: ExprNode, scope: ExprScope | undefined): unknown {
  switch (node.type) {
    case "num":
      return node.value;
    case "str":
      return node.value;
    case "ident": {
      if (Object.prototype.hasOwnProperty.call(BUILTINS, node.name)) {
        return BUILTINS[node.name];
      }
      if (
        scope !== undefined &&
        scope !== null &&
        Object.prototype.hasOwnProperty.call(scope, node.name)
      ) {
        return scope[node.name];
      }
      throw new ExpressionError(
        "evaluate",
        `Unknown identifier "${node.name}"`,
      );
    }
    case "unary": {
      const v = evalNode(node.arg, scope);
      if (node.op === "!") return !truthy(v);
      const n = toNumber(v, `unary "${node.op}"`);
      return node.op === "-" ? -n : n;
    }
    case "binary": {
      // '&&' / '||' SHORT-CIRCUIT: the right side is not evaluated (and so
      // cannot throw — e.g. unknown identifiers, bad property reads) when
      // the left side already decides the result.
      if (node.op === "&&") {
        const left = evalNode(node.left, scope);
        return truthy(left) ? truthy(evalNode(node.right, scope)) : false;
      }
      if (node.op === "||") {
        const left = evalNode(node.left, scope);
        return truthy(left) ? true : truthy(evalNode(node.right, scope));
      }
      return evalBinary(
        node.op,
        evalNode(node.left, scope),
        evalNode(node.right, scope),
      );
    }
    case "cond":
      return truthy(evalNode(node.cond, scope))
        ? evalNode(node.then, scope)
        : evalNode(node.else, scope);
    case "prop": {
      const obj = evalNode(node.object, scope);
      if (BLOCKED_PROPS.has(node.name)) {
        throw new ExpressionError(
          "evaluate",
          `Property "${node.name}" is not allowed`,
        );
      }
      if (
        obj === null ||
        obj === undefined ||
        (typeof obj !== "object" && typeof obj !== "function")
      ) {
        throw new ExpressionError(
          "evaluate",
          `Cannot read property "${node.name}" of ${describe(obj)}`,
        );
      }
      // OWN properties only: inherited members (toString, hasOwnProperty,
      // valueOf, …) are not reachable from expressions.
      if (!Object.prototype.hasOwnProperty.call(obj, node.name)) {
        throw new ExpressionError(
          "evaluate",
          `Unknown property "${node.name}"`,
        );
      }
      return (obj as Record<string, unknown>)[node.name];
    }
    case "call": {
      const callee = evalNode(node.callee, scope);
      if (typeof callee !== "function") {
        throw new ExpressionError(
          "evaluate",
          `Attempted to call ${describe(callee)}`,
        );
      }
      const args = node.args.map((a) => evalNode(a, scope));
      return (callee as (...a: unknown[]) => unknown)(...args);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface CompiledExpression {
  readonly source: string;
  readonly ast: ExprNode;
  /** Evaluate, returning a number | string | boolean. */
  evaluate(scope?: ExprScope): ExprValue;
  /** Evaluate and require a number result. */
  evaluateNumber(scope?: ExprScope): number;
  /** Evaluate and coerce to boolean via truthiness. */
  evaluateBoolean(scope?: ExprScope): boolean;
}

/** Parse + compile an expression.  Throws ExpressionError('parse') on syntax errors. */
export function compileExpression(source: string): CompiledExpression {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new ExpressionError("parse", "Expression must be a non-empty string");
  }
  const ast = parseExpression(source);
  const compiled: CompiledExpression = {
    source,
    ast,
    evaluate(scope?: ExprScope): ExprValue {
      const v = evalNode(ast, scope);
      if (
        typeof v === "number" ||
        typeof v === "string" ||
        typeof v === "boolean"
      )
        return v;
      throw new ExpressionError(
        "evaluate",
        `Expression returned ${describe(v)}, expected a number, string, or boolean`,
      );
    },
    evaluateNumber(scope?: ExprScope): number {
      return toNumber(evalNode(ast, scope), "Expression result");
    },
    evaluateBoolean(scope?: ExprScope): boolean {
      return truthy(evalNode(ast, scope));
    },
  };
  return Object.freeze(compiled);
}

/** One-shot convenience: compile and evaluate. */
export function evaluateExpression(
  source: string,
  scope?: ExprScope,
): ExprValue {
  return compileExpression(source).evaluate(scope);
}

/** Names of the builtin functions/constants (for docs/UI introspection). */
export function expressionBuiltinNames(): string[] {
  return Object.keys(BUILTINS);
}
