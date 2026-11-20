import ts from 'typescript';
import type { ExtractorContext } from '../context.js';
import { literalValue } from '../decorators.js';
import { unwrap } from '../flow/query-values.js';

export function stringArg(expr: ts.Expression | undefined, ctx: ExtractorContext, fallback = ''): string {
  const v = literalValue(expr, ctx);
  return typeof v === 'string' ? v : fallback;
}

/** The trimmed text of a string literal written in place. Nothing is evaluated: a constant, a call or an empty string gives undefined. */
export function literalText(expr: ts.Expression | undefined): string | undefined {
  const literal = expr && unwrap(expr);
  const text = literal && ts.isStringLiteralLike(literal) ? literal.text.trim() : '';
  return text === '' ? undefined : text;
}
