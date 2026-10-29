import ts from 'typescript';
import { findDecorator, literalValue } from '../decorators.js';
import type { DeriveContext, JsonSchema } from './derive.js';

/** `literalValue` without diagnostics; it follows identifiers to the initializer of their `const`. */
export function resolveLiteral(checker: ts.TypeChecker, expression: ts.Expression): unknown {
  return literalValue(expression, { checker, info: () => undefined });
}

export function explicitSchema(ctx: DeriveContext, type: ts.Type): { schema: JsonSchema; id?: string } | undefined {
  const declaration = type.getSymbol()?.declarations?.find(ts.isClassDeclaration);
  const argument = declaration && findDecorator(declaration, 'Schema')?.args[0];
  if (!argument) return undefined;
  const value = resolveLiteral(ctx.checker, argument);
  if (typeof value === 'string') return { schema: { $ref: value } };
  if (value && typeof value === 'object') {
    const schema = value as JsonSchema;
    return { schema, id: typeof schema.$id === 'string' ? schema.$id : undefined };
  }
  return undefined;
}
