import type { PrincipalRef, ResourceRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import type { FileMeta } from '../api.js';

/** Principal types that never own a file: no one in particular, or an id many share (anonymous callers, every bearer of a link). */
export const FS_NO_OWNER_TYPES: ReadonlySet<string> = new Set(['system', 'unattended', 'anonymous', 'link']);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * A frozen copy of `meta` holding only the FileMeta fields, or InvalidArgument: `owner` needs a type and an id,
 * `scope` a type (its id is optional), `tags` is a list of strings.
 */
export function checkFileMeta(meta: unknown, at = 'FileMeta'): FileMeta {
  if (!isObject(meta)) throw new InvalidArgument(`${at} must be an object, got ${show(meta)}`, 'meta');
  const out: { owner?: PrincipalRef; scope?: ResourceRef; tags?: readonly string[] } = {};
  if (meta.owner !== undefined) {
    const owner = meta.owner;
    if (!isObject(owner) || !text(owner.type) || !text(owner.id)) throw new InvalidArgument(`${at}.owner must be { type, id } with non-empty strings, got ${show(owner)}`, 'meta');
    out.owner = Object.freeze({ type: owner.type, id: owner.id });
  }
  if (meta.scope !== undefined) {
    const scope = meta.scope;
    if (!isObject(scope) || !text(scope.type) || (scope.id !== undefined && !text(scope.id))) throw new InvalidArgument(`${at}.scope must be { type, id? } with non-empty strings, got ${show(scope)}`, 'meta');
    out.scope = Object.freeze(scope.id === undefined ? { type: scope.type } : { type: scope.type, id: scope.id });
  }
  if (meta.tags !== undefined) {
    if (!Array.isArray(meta.tags) || !meta.tags.every((t) => typeof t === 'string')) throw new InvalidArgument(`${at}.tags must be a list of strings, got ${show(meta.tags)}`, 'meta');
    out.tags = Object.freeze([...(meta.tags as string[])]);
  }
  return Object.freeze(out);
}

export function sameFileMeta(a: FileMeta | null, b: FileMeta | null): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const canonical = (m: FileMeta | null): unknown => (m === null ? null : [m.owner?.type, m.owner?.id, m.scope?.type, m.scope?.id, m.tags]);

/** A non-empty filesystem name without ':' (the first ':' of a ref id ends the name). */
export function checkFsName(fsName: unknown): string {
  if (!text(fsName) || fsName.includes(':')) throw new InvalidArgument(`fs name must be a non-empty string without ':', got ${show(fsName)}`, 'fsName');
  return fsName;
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
