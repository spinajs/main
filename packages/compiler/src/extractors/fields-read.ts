import ts from 'typescript';
import { literalValue, type LiteralContext } from '../decorators.js';
import { memberOf } from './object-literals.js';

/** What `@Access` options do with `fields`; a value the build cannot read is `undefined`. */
type FieldsRead = { set: false } | { set: true; value: unknown };

/** The last member that may set `fields` decides, as in the object the runtime receives; options the build cannot follow may set it. */
export function fieldsOf(options: ts.Expression, ctx: LiteralContext): FieldsRead {
  const read = memberOf(options, 'fields', ctx);
  if (!read.set) return read;
  return { set: true, value: read.value ? literalValue(read.value, ctx) : undefined };
}
