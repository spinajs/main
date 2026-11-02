import type ts from 'typescript';
import type { JsonSchema, TypeHandler } from '../derive.js';

export const arrayType: TypeHandler = (ctx, type) => {
  if (!ctx.checker.isArrayType(type)) return undefined;
  const [element] = ctx.checker.getTypeArguments(type as ts.TypeReference);
  return { type: 'array', items: ctx.derive(ctx, element) };
};

/** draft-07 tuple: `items` as an array plus `additionalItems`; `prefixItems` needs 2020-12, which the runtime Ajv is not. */
export const tupleType: TypeHandler = (ctx, type) => {
  if (!ctx.checker.isTupleType(type)) return undefined;
  const reference = type as ts.TypeReference;
  const target = reference.target as ts.TupleType;
  const elements = ctx.checker.getTypeArguments(reference);
  const fixed = target.hasRestElement ? elements.slice(0, -1) : elements;
  const schema: JsonSchema = { type: 'array', items: fixed.map((element) => ctx.derive(ctx, element)), minItems: target.minLength };
  if (target.hasRestElement) {
    schema.additionalItems = ctx.derive(ctx, elements[elements.length - 1]);
  } else {
    schema.maxItems = fixed.length;
    schema.additionalItems = false;
  }
  return schema;
};
