import ts from 'typescript';
import type { TypeHandler } from '../derive.js';

/** `enum E { … }`: the type of E is a union of enum literal types; the values are its members. */
export const enumType: TypeHandler = (_ctx, type) => {
  if (!(type.flags & ts.TypeFlags.EnumLiteral) || !type.isUnion()) return undefined;
  const values = type.types.map((member) => (member as ts.LiteralType).value as string | number);
  return { enum: values };
};
