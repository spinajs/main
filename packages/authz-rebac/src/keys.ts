import { createHash } from 'node:crypto';
import type { ResourceRef } from '@spinajs/authz';
import { stableStringify } from '@spinajs/authz-ir';

import type { CaveatValue, SubjectSet, Tuple, TupleCaveat, TupleSubject } from './contracts.js';

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

/** The longest canonical JSON a tuple's caveat context may have. */
export const CAVEAT_CONTEXT_MAX = 4096;

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isCaveatValue = (v: unknown): v is CaveatValue => typeof v === 'string' || typeof v === 'boolean' || isFiniteNumber(v) || (Array.isArray(v) && (v.every((x) => typeof x === 'string') || v.every(isFiniteNumber)));

/** sha256 of the caveat name and its canonical context: equal for equal caveats. */
export const caveatKey = (c: TupleCaveat): string => createHash('sha256').update(stableStringify([c.name, c.context ?? {}])).digest('hex');

export const sameCaveat = (a: TupleCaveat | undefined, b: TupleCaveat | undefined): boolean => (a === undefined || b === undefined ? a === b : caveatKey(a) === caveatKey(b));

function readCaveat(v: unknown, where: string): TupleCaveat {
  const fail = (what: string): never => {
    throw new TypeError(`${where}.caveat${what}`);
  };
  if (!isRecord(v) || Object.keys(v).some((k) => k !== 'name' && k !== 'context')) return fail(' must be { name, context? }');
  if (!isName(v.name)) return fail('.name must be a caveat name');
  if (v.context === undefined) return { name: v.name };
  if (!isRecord(v.context) || Array.isArray(v.context)) return fail('.context must be an object of parameter values');
  const context: Record<string, CaveatValue> = {};
  for (const path of Object.keys(v.context).sort()) {
    const value = v.context[path];
    if (path.split('.').some((s) => s === '' || UNSAFE.has(s))) return fail(`.context: ${JSON.stringify(path)} is not a parameter path`);
    if (!isCaveatValue(value)) return fail(`.context: ${path} must be a string, number, boolean or a list of strings or numbers`);
    context[path] = Array.isArray(value) ? value.slice() : value;
  }
  if (stableStringify(context).length > CAVEAT_CONTEXT_MAX) return fail(`.context is longer than ${CAVEAT_CONTEXT_MAX} characters as JSON`);
  return Object.keys(context).length === 0 ? { name: v.name } : { name: v.name, context };
}

/** A plain copy of a well-formed tuple, its caveat included; throws TypeError naming the problem otherwise. */
export function readTuple(v: unknown, where = 'tuple'): Tuple {
  const tuple = readBareTuple(v, where);
  const caveat = isRecord(v) ? v.caveat : undefined;
  return caveat === undefined ? tuple : { ...tuple, caveat: readCaveat(caveat, where) };
}

function readBareTuple(v: unknown, where: string): Tuple {
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
