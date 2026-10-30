import ts from 'typescript';

export type IdentifierResolver = (expr: ts.Identifier | ts.PropertyAccessExpression) => string | undefined;

/** Evaluates a token key: string literals, template literals and `+` concatenation, with names resolved by the caller. */
export function evaluateKey(expr: ts.Expression, resolve: IdentifierResolver): string | undefined {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) return evaluateKey(expr.expression, resolve);
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) return resolve(expr);
  if (ts.isTemplateExpression(expr)) {
    let out = expr.head.text;
    for (const span of expr.templateSpans) {
      const part = evaluateKey(span.expression, resolve);
      if (part === undefined) return undefined;
      out += part + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateKey(expr.left, resolve);
    const right = left === undefined ? undefined : evaluateKey(expr.right, resolve);
    return right === undefined ? undefined : left + right;
  }
  return undefined;
}
