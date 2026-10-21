import type { ResourceRef } from '@spinajs/authz';

import type { SubjectSet, Tuple, TupleSubject } from './contracts.js';

/** Namespace, relation and permission names; keeps ':' and '#' out of keys. */
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export const isSubjectSet = (s: TupleSubject): s is SubjectSet => typeof s === 'object' && s !== null && 'object' in s;

const escapeType = (t: string): string => t.replace(/%/g, '%25').replace(/:/g, '%3A');
const escapeId = (id: string): string => id.replace(/%/g, '%25').replace(/#/g, '%23');

/** `type:id`, escaped so that it never collides with a subject-set key. */
export const objectKey = (ref: { readonly type: string; readonly id?: string }): string => `${escapeType(ref.type)}:${escapeId(ref.id ?? '')}`;

/** `type:id` for a principal or an object, `type:id#relation` for a subject set. */
export const subjectKey = (s: TupleSubject): string => (isSubjectSet(s) ? `${objectKey(s.object)}#${s.relation}` : objectKey(s));

/** One string per tuple, equal for equal tuples. */
export const tupleKey = (t: Tuple): string => JSON.stringify([t.object.type, t.object.id, t.relation, subjectKey(t.subject)]);

/** The order `TupleStore.find` promises. */
export const sortKey = (t: Tuple): string => JSON.stringify([objectKey(t.object), t.relation, subjectKey(t.subject)]);

export const sameRef = (a: ResourceRef, b: ResourceRef): boolean => a.type === b.type && (a.id ?? undefined) === (b.id ?? undefined);

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isName = (v: unknown): v is string => nonEmpty(v) && NAME_PATTERN.test(v);

/** `{ type, id }` with both non-empty, as a plain copy. */
function readRef(v: unknown, fail: () => never): { type: string; id: string } {
  if (!isRecord(v) || !nonEmpty(v.type) || !nonEmpty(v.id)) return fail();
  return { type: v.type, id: v.id };
}

/** A plain copy of a well-formed tuple; throws TypeError naming the problem otherwise. */
export function readTuple(v: unknown, where = 'tuple'): Tuple {
  const fail = (what: string) => (): never => {
    throw new TypeError(`${where}${what}`);
  };
  if (!isRecord(v)) return fail(' must be an object')();
  const object = readRef(v.object, fail('.object must name one object { type, id }'));
  if (!isName(v.relation)) return fail('.relation must be a relation name')();
  const s = v.subject;
  if (!isRecord(s)) return fail('.subject must be a principal { type, id } or a subject set { object, relation }')();
  if (!('object' in s)) return { object, relation: v.relation, subject: readRef(s, fail('.subject must be a principal { type, id }')) };
  const badSet = fail('.subject must name a subject set { object: { type, id }, relation }');
  if (!isName(s.relation)) return badSet();
  return { object, relation: v.relation, subject: { object: readRef(s.object, badSet), relation: s.relation } };
}
