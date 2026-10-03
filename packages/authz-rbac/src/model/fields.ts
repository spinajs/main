import { AuthzConfigError, subtractFieldGlobs, unionFieldGlobs } from '@spinajs/authz';
import type { FieldSet } from '@spinajs/authz';

/** A grant's field set as the vote reads it: both lists normalised, `hide` already subtracted. */
export interface FieldGlobs {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

const ALL: readonly string[] = Object.freeze(['*']);
const EVERY_FIELD: FieldGlobs = Object.freeze({ read: ALL, write: ALL });
const KEYS = new Set(['read', 'write', 'hide']);

/**
 * Compiles a grant's field set once, at boot. A list it leaves out is every field, as the engine reads
 * a vote. A grant's `hide` means the same as `!X` in that grant's own `read` and `write`: it limits
 * that grant only, and another grant that names the field still gives it. (The engine reads `hide`
 * only from denying votes, where it beats every permit; to hide a field whatever the roles, use a deny
 * policy or `authz.fields.neverRead`.)
 * @throws AuthzConfigError naming `where` for a malformed set, an invalid glob, or one over the work budget
 */
export function compileFieldSet(fields: FieldSet, where: string): FieldGlobs {
  const fail = (problem: string, cause?: unknown) => new AuthzConfigError(`${where}: ${problem}`, cause === undefined ? undefined : { cause });
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw fail('fields must be an object { read?, write?, hide? }');
  const unknown = Object.keys(fields).filter((k) => !KEYS.has(k));
  // A misspelt `read` would otherwise leave that list at every field.
  if (unknown.length > 0) throw fail(`fields has unknown key(s) ${unknown.map((k) => `'${k}'`).join(', ')}; use { read?, write?, hide? }`);
  const list = (name: 'read' | 'write' | 'hide'): readonly string[] | undefined => {
    const v: unknown = fields[name];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((g) => typeof g === 'string')) throw fail(`fields.${name} must be an array of field globs`);
    return v as string[];
  };
  const read = list('read');
  const write = list('write');
  const hide = list('hide') ?? [];
  try {
    return Object.freeze({ read: Object.freeze(subtractFieldGlobs(read ?? ALL, hide)), write: Object.freeze(subtractFieldGlobs(write ?? ALL, hide)) });
  } catch (err) {
    if (err instanceof AuthzConfigError) throw fail(`invalid field set: ${err.message}`, err);
    throw err;
  }
}

/**
 * The vote's fields from the grants that permit some row (§6.1.2 step 9, narrowed): the union over
 * the unconditional grants when there is one, else the intersection over the conditional ones. A
 * union over grants that may not hold on the row would give a row the fields of another grant, and
 * the vote has one field set for all its rows (§7). A grant without fields stands for every field;
 * `undefined` (every field, D-F5-2) when no grant in the chosen group carries fields.
 * @throws AuthzConfigError over the field-glob work budget; the engine makes it model_error
 */
export function voteFieldGlobs(unconditional: readonly (FieldGlobs | undefined)[], conditional: readonly (FieldGlobs | undefined)[]): FieldGlobs | undefined {
  const group = unconditional.length > 0 ? unconditional : conditional;
  if (!group.some((s) => s !== undefined)) return undefined;
  const sets = group.map((s) => s ?? EVERY_FIELD);
  if (group === unconditional) return { read: unionFieldGlobs(...sets.map((s) => s.read)), write: unionFieldGlobs(...sets.map((s) => s.write)) };
  return sets.reduce(intersectFieldGlobs);
}

/** a ∩ b as a − (a − b), with the core's exact subtract (as the engine's FieldCombiner.intersect). */
export function intersectFieldGlobs(a: FieldGlobs, b: FieldGlobs): FieldGlobs {
  const both = (x: readonly string[], y: readonly string[]) => subtractFieldGlobs(x, subtractFieldGlobs(x, y));
  return { read: both(a.read, b.read), write: both(a.write, b.write) };
}
