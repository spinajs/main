import ts from 'typescript';
import type { ExtractorContext } from './context.js';

/** The slice of the extractor context that literal evaluation needs. */
export type LiteralContext = Pick<ExtractorContext, 'checker' | 'info'>;

export interface DecoratorInfo {
  name: string;
  args: readonly ts.Expression[];
  node: ts.Decorator;
}

function calleeName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return expr.getText();
}

export function decoratorsOf(node: ts.HasDecorators): DecoratorInfo[] {
  return (ts.getDecorators(node) ?? []).map((decorator) => {
    const expr = decorator.expression;
    if (ts.isCallExpression(expr)) return { name: calleeName(expr.expression), args: expr.arguments, node: decorator };
    return { name: calleeName(expr), args: [], node: decorator };
  });
}

export function findDecorator(node: ts.HasDecorators, ...names: string[]): DecoratorInfo | undefined {
  return decoratorsOf(node).find((d) => names.includes(d.name));
}

export function isArrayOfType(expr: ts.Expression | undefined): boolean {
  return (
    !!expr &&
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === 'Array' &&
    expr.expression.name.text === 'ofType'
  );
}

export function identifierName(expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (isArrayOfType(expr)) return identifierName((expr as ts.CallExpression).arguments[0]);
  return undefined;
}

function propName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : name.getText();
}

function propertyKey(name: ts.PropertyName, ctx: LiteralContext): string | undefined {
  if (!ts.isComputedPropertyName(name)) return propName(name);
  const key = literalValue(name.expression, ctx);
  return typeof key === 'string' || typeof key === 'number' ? String(key) : undefined;
}

function objectLiteralValue(expr: ts.ObjectLiteralExpression, ctx: LiteralContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of expr.properties) {
    if (ts.isPropertyAssignment(p)) {
      const key = propertyKey(p.name, ctx);
      if (key !== undefined) out[key] = literalValue(p.initializer, ctx);
    } else if (ts.isShorthandPropertyAssignment(p)) out[p.name.text] = literalValue(p.name, ctx);
    else if (ts.isSpreadAssignment(p)) Object.assign(out, literalValue(p.expression, ctx) ?? {});
    else ctx.info('CMP001', `non-literal object member: ${p.getText()}`, p);
  }
  return out;
}

function primitiveValue(expr: ts.Expression): { value: unknown } | undefined {
  if (ts.isStringLiteralLike(expr)) return { value: expr.text };
  if (ts.isNumericLiteral(expr)) return { value: Number(expr.text) };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { value: null };
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand)) {
    return { value: -Number(expr.operand.text) };
  }
  return undefined;
}

function boundValue(expr: ts.Identifier | ts.PropertyAccessExpression, ctx: LiteralContext): { value: unknown } | undefined {
  const symbol = ctx.checker.getSymbolAtLocation(ts.isIdentifier(expr) ? expr : expr.name);
  const decl = symbol && (symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol).valueDeclaration;
  if (!decl) return undefined;
  if (ts.isClassDeclaration(decl)) return { value: decl.name?.text };
  if (ts.isEnumMember(decl)) return { value: ctx.checker.getConstantValue(decl) };
  if (ts.isVariableDeclaration(decl) && decl.initializer) return { value: literalValue(decl.initializer, ctx) };
  return undefined;
}

export function literalValue(expr: ts.Expression | undefined, ctx: LiteralContext): unknown {
  if (!expr) return undefined;
  const primitive = primitiveValue(expr);
  if (primitive) return primitive.value;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return literalValue(expr.expression, ctx);
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.map((e) => literalValue(e, ctx));
  if (ts.isObjectLiteralExpression(expr)) return objectLiteralValue(expr, ctx);
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
    const bound = boundValue(expr, ctx);
    if (bound) return bound.value;
  }
  ctx.info('CMP001', `non-literal decorator argument: ${expr.getText()}`, expr);
  return undefined;
}
