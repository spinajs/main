import ts from 'typescript';
import { deriveType, type DeriveContext, type JsonSchema, type TypeHandler } from '../derive.js';

const isLiteral = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)) !== 0;
const isIgnored = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;

/** Collapses `true | false` back to `boolean`; TS stores `boolean | 'x'` as `true | false | 'x'`. */
function collapseBooleans(members: ts.Type[]): Array<ts.Type | 'boolean'> {
  const bools = members.filter((member) => member.flags & ts.TypeFlags.BooleanLiteral);
  if (bools.length !== 2) return members;
  const out: Array<ts.Type | 'boolean'> = [];
  let placed = false;
  for (const member of members) {
    if (member.flags & ts.TypeFlags.BooleanLiteral) {
      if (!placed) {
        out.push('boolean');
        placed = true;
      }
    } else out.push(member);
  }
  return out;
}

/** A union of object types that all carry the same property with a distinct single literal type. */
export function discriminatorOf(ctx: DeriveContext, members: ts.Type[]): { propertyName: string; values: Map<ts.Type, string | number> } | undefined {
  if (members.length < 2 || !members.every((member) => member.flags & ts.TypeFlags.Object)) return undefined;
  const candidates = ctx.checker.getPropertiesOfType(members[0]).map((property) => property.name);
  for (const name of candidates) {
    const values = new Map<ts.Type, string | number>();
    for (const member of members) {
      const property = ctx.checker.getPropertyOfType(member, name);
      if (!property) break;
      const propertyType = ctx.checker.getTypeOfSymbolAtLocation(property, ctx.node);
      if (!(propertyType.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral))) break;
      values.set(member, (propertyType as ts.LiteralType).value as string | number);
    }
    if (values.size === members.length && new Set(values.values()).size === members.length) return { propertyName: name, values };
  }
  return undefined;
}

export const unionType: TypeHandler = (ctx, type) => {
  if (!type.isUnion()) return undefined;
  const members = type.types.filter((member) => !isIgnored(member));
  if (members.length === 0) return {};
  if (members.length === 1) return deriveType(ctx, members[0]);

  if (members.every(isLiteral) && !members.some((member) => member.flags & ts.TypeFlags.BooleanLiteral)) {
    return { enum: members.map((member) => (member as ts.LiteralType).value as string | number) };
  }

  const nonNull = members.filter((member) => !(member.flags & ts.TypeFlags.Null));
  const hasNull = nonNull.length !== members.length;

  if (hasNull && nonNull.length === 1) {
    const inner = deriveType(ctx, nonNull[0]);
    if (typeof inner.type === 'string') return { ...inner, type: [inner.type, 'null'] };
    return { anyOf: [inner, { type: 'null' }] };
  }

  const discriminator = discriminatorOf(ctx, nonNull);
  const parts: JsonSchema[] = collapseBooleans(nonNull).map((member) => (member === 'boolean' ? { type: 'boolean' } : deriveType(ctx, member)));
  if (hasNull) parts.push({ type: 'null' });

  if (discriminator) {
    const mapping: Record<string, string> = {};
    for (const [member, value] of discriminator.values) {
      const part = parts[nonNull.indexOf(member)];
      if (typeof part.$ref === 'string') mapping[String(value)] = part.$ref;
    }
    const schema: JsonSchema = { oneOf: parts };
    if (Object.keys(mapping).length === parts.length) schema['x-discriminator'] = { propertyName: discriminator.propertyName, mapping };
    return schema;
  }
  return { anyOf: parts };
};

export const intersectionType: TypeHandler = (ctx, type) => {
  if (!type.isIntersection()) return undefined;
  return { allOf: type.types.map((member) => deriveType(ctx, member)) };
};
