import ts from 'typescript';
import { findDecorator, literalValue } from '../decorators.js';
import type { DeriveContext, JsonSchema } from './derive.js';

export interface ResolvedLiteral {
  value: unknown;
  /** Sub-expressions `literalValue` could not evaluate; `value` lacks whatever they contribute. */
  unresolved: ts.Node[];
}

/** `literalValue` collecting the sub-expressions it could not evaluate instead of reporting them; it follows identifiers to the initializer of their `const`. */
export function resolveLiteral(checker: ts.TypeChecker, expression: ts.Expression): ResolvedLiteral {
  const unresolved: ts.Node[] = [];
  const value = literalValue(expression, { checker, info: (_code, _message, node) => unresolved.push(node ?? expression) });
  return { value, unresolved };
}

export interface ExplicitSchema {
  schema: JsonSchema;
  id?: string;
  /** Non-empty when the `@Schema` argument was only partly evaluated: `schema` is then not the runtime schema. */
  unresolved: ts.Node[];
}

export function explicitSchema(ctx: DeriveContext, type: ts.Type): ExplicitSchema | undefined {
  const declaration = type.getSymbol()?.declarations?.find(ts.isClassDeclaration);
  const argument = declaration && findDecorator(declaration, 'Schema')?.args[0];
  if (!argument) return undefined;
  const { value, unresolved } = resolveLiteral(ctx.checker, argument);
  if (typeof value === 'string') return { schema: { $ref: value }, unresolved };
  if (value && typeof value === 'object') {
    const schema = value as JsonSchema;
    return { schema, id: typeof schema.$id === 'string' ? schema.$id : undefined, unresolved };
  }
  return unresolved.length ? { schema: {}, unresolved } : undefined;
}
