import type ts from 'typescript';
import type { ExtractorContext } from '../context.js';
import { literalValue } from '../decorators.js';

export function stringArg(expr: ts.Expression | undefined, ctx: ExtractorContext, fallback = ''): string {
  const v = literalValue(expr, ctx);
  return typeof v === 'string' ? v : fallback;
}
