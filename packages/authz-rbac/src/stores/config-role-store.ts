import { createHash } from 'node:crypto';
import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { Inject, Injectable } from '@spinajs/di';

import { RoleStore } from '../contracts.js';
import type { GrantDef, ImpliedRole, LadderDef, ResourcePattern, RoleDef } from '../contracts.js';

const ROOT = 'authz.rbac';
const ROLE_KEYS = ['ladder', 'extends', 'grants', 'revoke', 'implies', 'subjectSet', 'assignable', 'scopeTypes', 'description'];
const GRANT_KEYS = ['permission', 'relation', 'on', 'fields', 'requiresTag', 'grantedAt'];
const IMPLIES_KEYS = ['role', 'at', 'tags', 'bypass'];
const LADDER_KEYS = ['roles', 'resourceTypes'];
const IMPLIES_AT: readonly string[] = ['self-and-descendants', 'descendants'];
const BYPASS: readonly string[] = ['restrict', 'cap'];

type Raw = Record<string, unknown>;

const isPlain = (v: unknown): v is Raw => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const key = (path: string, k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);
const fail = (path: string, what: string): never => {
  throw new AuthzConfigError(`${path}: ${what}`);
};

function object(v: unknown, path: string, allowed?: readonly string[]): Raw {
  if (!isPlain(v)) fail(path, 'must be an object');
  if (allowed) for (const k of Object.keys(v as Raw)) if (!allowed.includes(k)) fail(key(path, k), 'is not a known key');
  return v as Raw;
}

function text(v: unknown, path: string, nonEmpty = true): string {
  if (typeof v !== 'string' || (nonEmpty && v === '')) fail(path, nonEmpty ? 'must be a non-empty string' : 'must be a string');
  return v as string;
}

function list(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be a list');
  return v as unknown[];
}

const texts = (v: unknown, path: string, allowed?: readonly string[]): string[] =>
  list(v, path).map((s, i) => {
    const t = text(s, `${path}[${i}]`);
    if (allowed && !allowed.includes(t)) fail(`${path}[${i}]`, `must be one of ${allowed.join(', ')}`);
    return t;
  });

function flag(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'must be true or false');
  return v as boolean;
}

/** Copies into `out` the keys of `src` that are set, so absent optional fields stay absent. */
function optional<T>(out: Raw, src: Raw, k: string, read: (v: unknown) => T): void {
  if (src[k] !== undefined) out[k] = read(src[k]);
}

function grant(v: unknown, path: string): GrantDef {
  if (typeof v === 'string') return { permission: text(v, path) };
  const g = object(v, path, GRANT_KEYS);
  const out: Raw = { permission: text(g.permission, `${path}.permission`) };
  optional(out, g, 'relation', (r) => (typeof r === 'string' ? text(r, `${path}.relation`) : Array.isArray(r) ? texts(r, `${path}.relation`) : fail(`${path}.relation`, 'must be a string or a list')));
  optional(out, g, 'on', (on) =>
    list(on, `${path}.on`).map((p, i): ResourcePattern => {
      const at = `${path}.on[${i}]`;
      const o = object(p, at, ['type', 'id']);
      return { type: text(o.type, `${at}.type`), ...(o.id === undefined ? {} : { id: text(o.id, `${at}.id`, false) }) };
    }),
  );
  optional(out, g, 'fields', (f) => {
    const o = object(f, `${path}.fields`, ['read', 'write', 'hide']);
    const fields: Raw = {};
    for (const k of ['read', 'write', 'hide']) optional(fields, o, k, (x) => texts(x, `${path}.fields.${k}`));
    return fields;
  });
  optional(out, g, 'requiresTag', (t) => text(t, `${path}.requiresTag`));
  optional(out, g, 'grantedAt', (t) => texts(t, `${path}.grantedAt`));
  return out as unknown as GrantDef;
}

function implied(v: unknown, path: string): ImpliedRole {
  const o = object(v, path, IMPLIES_KEYS);
  const at = text(o.at, `${path}.at`);
  if (!IMPLIES_AT.includes(at)) fail(`${path}.at`, `must be one of ${IMPLIES_AT.join(', ')}`);
  const out: Raw = { role: text(o.role, `${path}.role`), at };
  optional(out, o, 'tags', (t) => texts(t, `${path}.tags`));
  optional(out, o, 'bypass', (b) => texts(b, `${path}.bypass`, BYPASS));
  return out as unknown as ImpliedRole;
}

/**
 * `revoke` removes, after the configuration merged every fragment, each grant of this role whose permission equals a
 * listed string exactly (no globs); a string grant counts, as it reads `{ permission }`. Inherited grants are untouched.
 */
function role(name: string, v: unknown, path: string): RoleDef {
  const r = object(v, path, ROLE_KEYS);
  const revoked = new Set(r.revoke === undefined ? [] : texts(r.revoke, `${path}.revoke`));
  const grants = (r.grants === undefined ? [] : list(r.grants, `${path}.grants`)).map((g, i) => grant(g, `${path}.grants[${i}]`)).filter((g) => !revoked.has(g.permission));
  const out: Raw = { name };
  optional(out, r, 'ladder', (l) => text(l, `${path}.ladder`));
  out.extends = r.extends === undefined ? [] : texts(r.extends, `${path}.extends`);
  out.grants = grants;
  optional(out, r, 'implies', (i) => list(i, `${path}.implies`).map((x, n) => implied(x, `${path}.implies[${n}]`)));
  optional(out, r, 'subjectSet', (s) => flag(s, `${path}.subjectSet`));
  out.assignable = r.assignable === undefined ? true : flag(r.assignable, `${path}.assignable`);
  optional(out, r, 'scopeTypes', (s) => texts(s, `${path}.scopeTypes`));
  optional(out, r, 'description', (d) => text(d, `${path}.description`, false));
  out.source = 'config';
  return out as unknown as RoleDef;
}

function ladder(name: string, v: unknown, path: string): LadderDef {
  const l = object(v, path, LADDER_KEYS);
  const out: Raw = { name, roles: texts(l.roles, `${path}.roles`) };
  optional(out, l, 'resourceTypes', (t) => texts(t, `${path}.resourceTypes`));
  return out as unknown as LadderDef;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Sorted keys, so reordering an object does not change the hash; list order does.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as Raw;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Roles and ladders from `authz.rbac.roles` and `authz.rbac.ladders`. It checks shapes only: the `extends` graph,
 * unknown roles, ladders and permissions are the model's compile step.
 */
@Injectable(RoleStore)
@Inject(Configuration)
export class ConfigRoleStore extends RoleStore {
  readonly name = 'ConfigRoleStore';

  constructor(protected readonly configuration: Configuration) {
    super();
  }

  async load(): Promise<{ roles: readonly RoleDef[]; ladders: readonly LadderDef[] }> {
    const { roles, ladders } = this.raw();
    const rolesPath = `${ROOT}.roles`;
    const laddersPath = `${ROOT}.ladders`;
    const roleMap = roles === undefined ? {} : object(roles, rolesPath);
    const ladderMap = ladders === undefined ? {} : object(ladders, laddersPath);
    return deepFreeze({
      roles: Object.entries(roleMap).map(([n, r]) => role(n, r, key(rolesPath, n))),
      ladders: Object.entries(ladderMap).map(([n, l]) => ladder(n, l, key(laddersPath, n))),
    });
  }

  async version(): Promise<string> {
    const { roles, ladders } = this.raw();
    return createHash('sha256')
      .update(canonical({ roles: roles ?? {}, ladders: ladders ?? {} }))
      .digest('hex');
  }

  private raw(): { roles: unknown; ladders: unknown } {
    return { roles: this.configuration.get<unknown>(['authz', 'rbac', 'roles']), ladders: this.configuration.get<unknown>(['authz', 'rbac', 'ladders']) };
  }
}
