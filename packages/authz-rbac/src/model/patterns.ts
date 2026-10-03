import { AuthzConfigError, FALSE, TRUE, matchGlob, or, resourceKey } from '@spinajs/authz';
import type { Principal, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

import type { ResourcePattern } from '../contracts.js';

/** A literal run of the id, or a `{principal.*}` template as its property path (`['attributes', 'org', 'id']`). */
export type PatternPart = string | { readonly principal: readonly string[] };

/** A grant's `on` entry, parsed once at compile; templates are substituted per request. */
export interface CompiledPattern {
  readonly type: ResourceType;
  /** Absent: every resource of `type`. */
  readonly id?: readonly PatternPart[];
  /** A literal part holds `*`: the id is a segment-aware glob (`cmp glob`), else an exact node (`under`). */
  readonly glob: boolean;
  readonly pattern: ResourcePattern;
}

/** What a pattern is matched against: the request's resource, its path (resource, ancestors, GLOBAL) and principal. */
export interface PatternContext {
  readonly resource: ResourceRef;
  readonly path: readonly ResourceRef[];
  readonly principal: Principal;
}

const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
// The engine's glob reads only `*`; `?` and `[` are refused too, so a SQL or fs dialect that reads them cannot widen.
const GLOB_META = /[*?[]/;

/**
 * Parses one pattern. `where` names the grant (`rbac role 'r' grant 'p'`) and starts every error.
 * This is the one place that reads a pattern's syntax; boot checks on globs (§6.5 rule 11) read `id` and `glob`.
 * @throws AuthzConfigError for a pattern that is not `{ type, id? }` (unknown keys included), an empty id, or a malformed template
 */
export function compilePattern(pattern: ResourcePattern, where: string): CompiledPattern {
  const fail = (problem: string) => new AuthzConfigError(`${where}: ${problem}`);
  if (typeof pattern !== 'object' || pattern === null || Array.isArray(pattern)) throw fail('every pattern in `on` must be an object { type, id? }');
  const { type, id } = pattern as { type?: unknown; id?: unknown };
  const unknown = Object.keys(pattern).filter((k) => k !== 'type' && k !== 'id');
  // A misspelt `id` would otherwise leave a type-only pattern that admits every row of the type.
  if (unknown.length > 0) throw fail(`a pattern in \`on\` has unknown key(s) ${unknown.map((k) => `'${k}'`).join(', ')}; use { type, id? }`);
  if (typeof type !== 'string' || type === '') throw fail('a pattern in `on` has no type');
  const frozen = Object.freeze({ ...pattern });
  if (id === undefined) return Object.freeze({ type, glob: false, pattern: frozen });
  if (typeof id !== 'string' || id === '') throw fail(`pattern of type '${type}' has an id that is not a non-empty string`);

  const parts: PatternPart[] = [];
  let glob = false;
  let i = 0;
  while (i < id.length) {
    const open = id.indexOf('{', i);
    const literal = id.slice(i, open < 0 ? id.length : open);
    if (literal.includes('}')) throw fail(`pattern id '${id}' has a '}' without '{'`);
    if (literal !== '') {
      parts.push(literal);
      if (literal.includes('*')) glob = true;
    }
    if (open < 0) break;
    const close = id.indexOf('}', open + 1);
    const inner = close < 0 ? undefined : id.slice(open + 1, close);
    if (inner === undefined || inner.includes('{')) throw fail(`pattern id '${id}' has a '{' without '}'`);
    parts.push(Object.freeze({ principal: templatePath(inner, id, fail) }));
    i = close + 1;
  }
  return Object.freeze({ type, id: Object.freeze(parts), glob, pattern: frozen });
}

function templatePath(inner: string, id: string, fail: (problem: string) => Error): readonly string[] {
  const segments = inner.split('.');
  const known = segments[0] === 'principal' && ((segments.length === 2 && (segments[1] === 'id' || segments[1] === 'type')) || (segments.length > 2 && segments[1] === 'attributes'));
  if (!known) throw fail(`pattern id '${id}' has the template '{${inner}}'; use {principal.id}, {principal.type} or {principal.attributes.<path>}`);
  if (segments.some((s) => s === '' || UNSAFE_SEGMENTS.has(s))) throw fail(`pattern id '${id}' has an invalid attribute path in '{${inner}}'`);
  return Object.freeze(segments.slice(1));
}

/**
 * The id with the principal's values in place, or `undefined` when the pattern matches nothing for
 * this principal: a value is missing, null, empty, not a string, finite number or boolean, holds a
 * glob metacharacter, or could step out of its path segment (see `segmentSafe`). Not cached: the
 * result depends on the principal.
 */
export function patternId(p: CompiledPattern, principal: Principal): string | undefined {
  if (!p.id) return undefined;
  let out = '';
  for (const part of p.id) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    const value = principalValue(principal, part.principal);
    if (value === undefined || GLOB_META.test(value) || !segmentSafe(value, part.principal[0] !== 'attributes')) return undefined;
    out += value;
  }
  return out;
}

/*
 * Ids are compared as strings, so `bob/x` in `home/{principal.id}` would land in bob's tree. The
 * principal's id and type stay within one segment. Attributes come from a trusted provider and may be
 * paths. No value may hold an empty, `.` or `..` segment.
 */
function segmentSafe(value: string, oneSegment: boolean): boolean {
  const segments = value.split('/');
  return (!oneSegment || segments.length === 1) && segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

function principalValue(principal: Principal, path: readonly string[]): string | undefined {
  let v: unknown = principal;
  try {
    for (const segment of path) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, segment)) return undefined;
      v = (v as Record<string, unknown>)[segment];
    }
  } catch {
    return undefined;
  }
  if (typeof v === 'string') return v === '' ? undefined : v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === 'boolean') return String(v);
  return undefined;
}

/**
 * The rows of the request one pattern admits (§6.1.2, B16). A type-only pattern admits its type. An
 * exact id admits that node and every resource below it, of any type (`under`). A glob admits the ids
 * of its own type it matches (`cmp glob` on `id`). A concrete request is decided here, from its id
 * and path.
 */
export function patternFilter(p: CompiledPattern, at: PatternContext): ResourceFilter {
  const { resource } = at;
  const typeLevel = resource.id == null;
  if (!p.id) return resource.type === p.type ? TRUE : FALSE;
  const id = patternId(p, at.principal);
  if (id === undefined) return FALSE;
  if (p.glob) {
    if (resource.type !== p.type) return FALSE;
    if (typeLevel) return { op: 'cmp', field: 'id', cmp: 'glob', value: id };
    return matchGlob(id, resource.id!) === true ? TRUE : FALSE;
  }
  const node: ResourceRef = { type: p.type, id };
  if (typeLevel) return { op: 'under', scopes: [node] };
  const key = resourceKey(node);
  return resourceKey(resource) === key || at.path.some((r) => resourceKey(r) === key) ? TRUE : FALSE;
}

/** Several patterns of one grant OR. */
export function patternsFilter(patterns: readonly CompiledPattern[], at: PatternContext): ResourceFilter {
  return or(...patterns.map((p) => patternFilter(p, at)));
}

/**
 * Resource types a grant limited by `patterns` can admit, out of `types`. An exact id admits rows of
 * any type below its node, so it keeps them all; a type-only pattern or a glob keeps its own type.
 */
export function patternTypes(patterns: readonly CompiledPattern[], types: readonly ResourceType[]): readonly ResourceType[] {
  if (patterns.some((p) => p.id && !p.glob)) return types;
  return types.filter((t) => patterns.some((p) => p.type === t));
}
