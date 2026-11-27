import ts from 'typescript';
import { literalValue, type LiteralContext } from '../decorators.js';
import { initializerOf, objectLiteralOf } from './object-literals.js';

/** What `@Access` options do with `fields`; a value the build cannot read is `undefined`. */
type FieldsRead = { set: false } | { set: true; value: unknown };

const FIELDS_UNSET: FieldsRead = { set: false };
const FIELDS_UNREAD: FieldsRead = { set: true, value: undefined };

function memberFields(member: ts.ObjectLiteralElementLike, ctx: LiteralContext): FieldsRead {
  if (ts.isSpreadAssignment(member)) return fieldsOf(member.expression, ctx);
  const key = ts.isComputedPropertyName(member.name) ? literalValue(member.name.expression, ctx) : member.name.text;
  if (key !== 'fields') return typeof key === 'string' || typeof key === 'number' ? FIELDS_UNSET : FIELDS_UNREAD;
  if (ts.isPropertyAssignment(member)) return { set: true, value: literalValue(member.initializer, ctx) };
  // literalValue resolves a shorthand name to the property itself, not to the variable it copies
  if (ts.isShorthandPropertyAssignment(member)) {
    const initializer = initializerOf(ctx.checker.getShorthandAssignmentValueSymbol(member), ctx);
    return initializer ? { set: true, value: literalValue(initializer, ctx) } : FIELDS_UNREAD;
  }
  return FIELDS_UNREAD;
}

/** The last member that may set `fields` decides, as in the object the runtime receives; options the build cannot follow may set it. */
export function fieldsOf(options: ts.Expression, ctx: LiteralContext): FieldsRead {
  const literal = objectLiteralOf(options, ctx);
  if (!literal) return FIELDS_UNREAD;
  for (const member of [...literal.properties].reverse()) {
    const read = memberFields(member, ctx);
    if (read.set) return read;
  }
  return FIELDS_UNSET;
}
