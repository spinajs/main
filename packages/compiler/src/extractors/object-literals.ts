import ts from 'typescript';
import { literalValue, type LiteralContext } from '../decorators.js';

export function initializerOf(symbol: ts.Symbol | undefined, ctx: LiteralContext): ts.Expression | undefined {
  const decl = symbol && (symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol).valueDeclaration;
  // a let or var may be reassigned before the decorator runs, so only a const is held to its initializer
  return decl && ts.isVariableDeclaration(decl) && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const ? decl.initializer : undefined;
}

/** The object literal `expr` is written as, through wrappers and constants. */
export function objectLiteralOf(expr: ts.Expression, ctx: LiteralContext): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return objectLiteralOf(expr.expression, ctx);
  if (ts.isCallExpression(expr) && expr.expression.getText() === 'Object.freeze' && expr.arguments[0]) return objectLiteralOf(expr.arguments[0], ctx);
  if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return undefined;
  const initializer = initializerOf(ctx.checker.getSymbolAtLocation(ts.isIdentifier(expr) ? expr : expr.name), ctx);
  return initializer && objectLiteralOf(initializer, ctx);
}

/** What an options object does with one key: nothing, or sets it to `value`, absent when the build cannot follow it. */
export type MemberRead = { set: false } | { set: true; value?: ts.Expression };

const MEMBER_UNSET: MemberRead = { set: false };
const MEMBER_UNREAD: MemberRead = { set: true };

function memberRead(member: ts.ObjectLiteralElementLike, key: string, ctx: LiteralContext): MemberRead {
  if (ts.isSpreadAssignment(member)) return memberOf(member.expression, key, ctx);
  const name = ts.isComputedPropertyName(member.name) ? literalValue(member.name.expression, ctx) : member.name.text;
  if (name !== key) return typeof name === 'string' || typeof name === 'number' ? MEMBER_UNSET : MEMBER_UNREAD;
  if (ts.isPropertyAssignment(member)) return { set: true, value: member.initializer };
  // literalValue resolves a shorthand name to the property itself, not to the variable it copies
  if (ts.isShorthandPropertyAssignment(member)) {
    const initializer = initializerOf(ctx.checker.getShorthandAssignmentValueSymbol(member), ctx);
    return initializer ? { set: true, value: initializer } : MEMBER_UNREAD;
  }
  return MEMBER_UNREAD;
}

/** The last member that may set `key` decides, as in the object the runtime receives; options the build cannot follow may set it. */
export function memberOf(options: ts.Expression, key: string, ctx: LiteralContext): MemberRead {
  const literal = objectLiteralOf(options, ctx);
  if (!literal) return MEMBER_UNREAD;
  for (const member of [...literal.properties].reverse()) {
    const read = memberRead(member, key, ctx);
    if (read.set) return read;
  }
  return MEMBER_UNSET;
}

function symbolReadsConstantsOnly(symbol: ts.Symbol | undefined, ctx: LiteralContext): boolean {
  const decl = symbol && (symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol).valueDeclaration;
  if (decl && ts.isClassDeclaration(decl)) return false;
  if (!decl || !ts.isVariableDeclaration(decl)) return true;
  const initializer = initializerOf(symbol, ctx);
  return !!initializer && readsConstantsOnly(initializer, ctx);
}

function memberReadsConstantsOnly(member: ts.ObjectLiteralElementLike, ctx: LiteralContext): boolean {
  if (ts.isSpreadAssignment(member)) return readsConstantsOnly(member.expression, ctx);
  if (ts.isShorthandPropertyAssignment(member)) return symbolReadsConstantsOnly(ctx.checker.getShorthandAssignmentValueSymbol(member), ctx);
  if (!ts.isPropertyAssignment(member)) return true;
  return (!ts.isComputedPropertyName(member.name) || readsConstantsOnly(member.name.expression, ctx)) && readsConstantsOnly(member.initializer, ctx);
}

/**
 * False when `expr` reads a `let` or `var` at any depth (it may be reassigned before the value is used) or a class, which
 * `literalValue` reads as its name.
 */
export function readsConstantsOnly(expr: ts.Expression, ctx: LiteralContext): boolean {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return readsConstantsOnly(expr.expression, ctx);
  if (ts.isCallExpression(expr)) return expr.arguments.every((a) => readsConstantsOnly(a, ctx));
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.every((e) => readsConstantsOnly(ts.isSpreadElement(e) ? e.expression : e, ctx));
  if (ts.isObjectLiteralExpression(expr)) return expr.properties.every((member) => memberReadsConstantsOnly(member, ctx));
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) return symbolReadsConstantsOnly(ctx.checker.getSymbolAtLocation(ts.isIdentifier(expr) ? expr : expr.name), ctx);
  return true;
}

export function isPlainJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).every(isPlainJson);
  return false;
}

/** The value of `expr` when the build reads all of it: literals and constants only, nothing that needs a `CMP001` note. */
export function constantValueOf(expr: ts.Expression, ctx: LiteralContext): { value: unknown } | undefined {
  if (!readsConstantsOnly(expr, ctx)) return undefined;
  let unread = false;
  const value = literalValue(expr, {
    checker: ctx.checker,
    info: () => {
      unread = true;
    },
  });
  return unread || !isPlainJson(value) ? undefined : { value };
}
