import { createHash } from 'node:crypto';
import { AuthzConfigError } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import type { Configuration } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';

import { RoleStore } from '../contracts.js';
import type { GrantDef, LadderDef, RoleDef } from '../contracts.js';

/** One `authz.rbac.roles.<name>` entry as configured; AUTHZ_RBAC_CONFIGURATION_SCHEMA checks it. */
interface RoleEntry extends Partial<Omit<RoleDef, 'name' | 'grants' | 'source'>> {
  readonly grants?: readonly (string | GrantDef)[];
  readonly revoke?: readonly string[];
}

type LadderEntry = Omit<LadderDef, 'name'>;
type Raw = Record<string, unknown>;

const ROLE_KEYS = ['ladder', 'extends', 'grants', 'revoke', 'implies', 'subjectSet', 'assignable', 'scopeTypes', 'description'];
const GRANT_KEYS = ['permission', 'relation', 'on', 'fields', 'requiresTag', 'grantedAt'];
const LADDER_KEYS = ['roles', 'resourceTypes'];

const isPlain = (v: unknown): v is Raw => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/*
 * Floors for values the schema never saw (Configuration.set, the constructor seam). Each refuses a shape that would read
 * as a broader role: a misspelt key drops the restriction it names, a `revoke` string revokes nothing, a `grantedAt`
 * string is matched by substring. The model compile refuses the other malformed values.
 */
function refuse(bad: boolean, path: string, what: string): void {
  if (bad) throw new AuthzConfigError(`${path}: ${what}`);
}

function closed(v: unknown, keys: readonly string[], path: string): void {
  refuse(!isPlain(v), path, 'must be an object');
  const unknown = Object.keys(v as Raw).find((k) => !keys.includes(k));
  refuse(unknown !== undefined, `${path}.${unknown}`, 'is not a known key');
}

// A plain copy: the result is frozen and must not alias the configuration.
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as unknown as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)])) as T;
  return value;
}

function grant(g: string | GrantDef, path: string): GrantDef {
  if (typeof g === 'string') return { permission: g };
  closed(g, GRANT_KEYS, path);
  refuse(g.grantedAt !== undefined && !isNames(g.grantedAt), `${path}.grantedAt`, 'must be a list of scope types');
  return g;
}

/**
 * `revoke` removes, after the configuration merged every fragment, each grant of this role whose permission equals a
 * listed string exactly (no globs); a string grant counts, as it reads `{ permission }`. Inherited grants are untouched.
 */
function role(name: string, entry: RoleEntry, path: string): RoleDef {
  closed(entry, ROLE_KEYS, path);
  const { revoke = [], grants = [], extends: parents = [], assignable = true, ...rest } = copy(entry);
  refuse(!isNames(revoke), `${path}.revoke`, 'must be a list of permissions');
  refuse(!Array.isArray(grants), `${path}.grants`, 'must be a list');
  const revoked = new Set(revoke);
  return {
    name,
    ...rest,
    extends: parents,
    grants: grants.map((g, i) => grant(g, `${path}.grants[${i}]`)).filter((g) => !revoked.has(g.permission)),
    assignable,
    source: 'config',
  };
}

function ladder(name: string, entry: LadderEntry, path: string): LadderDef {
  closed(entry, LADDER_KEYS, path);
  return { name, ...copy(entry) };
}

function entries<T>(map: Readonly<Record<string, T>> | undefined, path: string): [string, T][] {
  refuse(map !== undefined && !isPlain(map), path, 'must be an object');
  return Object.entries(map ?? {});
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
 * Roles and ladders from `authz.rbac.roles` and `authz.rbac.ladders`. AUTHZ_RBAC_CONFIGURATION_SCHEMA checks their
 * shape at boot; the `extends` graph, unknown roles, ladders and permissions are the model's compile step.
 *
 * Registered by class name only: AuthzAdmin reads every `RoleStore` a domain registers, so one
 * registered as `RoleStore` at import would join every domain.
 */
@Injectable()
export class ConfigRoleStore extends RoleStore {
  readonly name = 'ConfigRoleStore';

  @Config('authz.rbac.roles')
  protected Roles: Readonly<Record<string, RoleEntry>> | undefined;

  @Config('authz.rbac.ladders')
  protected Ladders: Readonly<Record<string, LadderEntry>> | undefined;

  /** `configuration`: read in place of the Configuration of the store's container (tests, a host that builds the model itself). */
  constructor(protected readonly configuration?: Pick<Configuration, 'get'>) {
    super();
  }

  async load(): Promise<{ roles: readonly RoleDef[]; ladders: readonly LadderDef[] }> {
    const { roles, ladders } = this.raw();
    return deepFreeze({
      roles: entries(roles, 'authz.rbac.roles').map(([n, r]) => role(n, r, `authz.rbac.roles.${n}`)),
      ladders: entries(ladders, 'authz.rbac.ladders').map(([n, l]) => ladder(n, l, `authz.rbac.ladders.${n}`)),
    });
  }

  async version(): Promise<string> {
    const { roles, ladders } = this.raw();
    return createHash('sha256')
      .update(canonical({ roles: roles ?? {}, ladders: ladders ?? {} }))
      .digest('hex');
  }

  private raw(): { roles?: Readonly<Record<string, RoleEntry>>; ladders?: Readonly<Record<string, LadderEntry>> } {
    if (this.configuration) {
      return {
        roles: this.configuration.get<Readonly<Record<string, RoleEntry>> | undefined>(['authz', 'rbac', 'roles']),
        ladders: this.configuration.get<Readonly<Record<string, LadderEntry>> | undefined>(['authz', 'rbac', 'ladders']),
      };
    }
    return { roles: this.Roles, ladders: this.Ladders };
  }
}
