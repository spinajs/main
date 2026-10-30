import ts from 'typescript';
import type { TypeHandler } from '../derive.js';

/** Ajv is draft-07 and validates bigint as a string pattern; `format: int64` applies only to numbers. */
export const BIGINT_SCHEMA = { type: 'string', pattern: '^-?[0-9]+$' };

// ts.pseudoBigIntToString is not part of the public API.
const bigintLiteral = ({ negative, base10Value }: ts.PseudoBigInt): string => (negative ? `-${base10Value}` : base10Value);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Only `${string}` spans become a pattern (`.*`); `${number}` and the like have no exact regex worth emitting. */
function templateLiteral(type: ts.TemplateLiteralType): { type: 'string'; pattern?: string } {
  if (!type.types.every((span) => span.flags & ts.TypeFlags.String)) return { type: 'string' };
  const { texts } = type;
  const body = texts.map(escapeRegExp).join('.*').replace(/^(\.\*)+|(\.\*)+$/g, '');
  const pattern = (texts[0] ? '^' : '') + body + (texts[texts.length - 1] ? '$' : '');
  return pattern ? { type: 'string', pattern } : { type: 'string' };
}

export const primitive: TypeHandler = (_ctx, type) => {
  const flags = type.flags;
  if (flags & ts.TypeFlags.TemplateLiteral) return templateLiteral(type as ts.TemplateLiteralType);
  if (flags & ts.TypeFlags.StringMapping) return { type: 'string' };
  if (flags & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
  if (flags & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value };
  if (flags & ts.TypeFlags.BooleanLiteral) return { const: (type as unknown as { intrinsicName: string }).intrinsicName === 'true' };
  if (flags & ts.TypeFlags.BigIntLiteral) return { const: bigintLiteral((type as ts.BigIntLiteralType).value) };
  if (flags & ts.TypeFlags.String) return { type: 'string' };
  if (flags & ts.TypeFlags.Number) return { type: 'number' };
  if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
  if (flags & ts.TypeFlags.BigInt) return { ...BIGINT_SCHEMA };
  if (flags & ts.TypeFlags.Null) return { type: 'null' };
  if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return {};
  return undefined;
};
