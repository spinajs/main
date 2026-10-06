import { createHash } from 'node:crypto';
import { AuthzConfigError, GLOBAL, resourceKey } from '@spinajs/authz';
import type { ResourceRef, RuleDef } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import type { Configuration } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';

import { RuleStore } from '../contracts.js';

type Raw = Record<string, unknown>;

const COMMON_KEYS = ['id', 'kind', 'scope', 'resourceTypes', 'subjects', 'when', 'expiresAt', 'source'];
const RULE_KEYS: ReadonlyMap<unknown, readonly string[]> = new Map([
  ['restrict', [...COMMON_KEYS, 'allow']],
  ['cap', [...COMMON_KEYS, 'ladder', 'maxRole', 'stripTags', 'assignments']],
  ['threshold', [...COMMON_KEYS, 'permissions', 'resource', 'minRole', 'ladder', 'at', 'reason']],
]);

const isPlain = (v: unknown): v is Raw => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const isNames = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '');

function refuse(bad: boolean, at: string, what: string): void {
  if (bad) throw new AuthzConfigError(`${at}: ${what}`);
}

/*
 * Floors for rules the schema never saw (Configuration.set, the constructor seam). Each refuses a rule that would apply
 * to fewer requests than it says, which reads as broader access: a kind no step runs, a misspelt key, a bare-type scope
 * (on no check path), a selector that selects nothing, a rank without exactly one bound, a cap that does nothing.
 * The model compile refuses the other malformed values.
 */
function floor(r: Raw, scope: unknown, at: string): void {
  const keys = RULE_KEYS.get(r.kind);
  refuse(keys === undefined, at, `kind must be one of ${[...RULE_KEYS.keys()].join(', ')}`);
  const unknown = Object.keys(r).find((k) => !keys!.includes(k));
  refuse(unknown !== undefined, at, `'${unknown}' is not a key of a ${r.kind as string} rule`);
  refuse(!isPlain(scope) || typeof scope.type !== 'string' || (scope.id == null && scope.type !== GLOBAL.type), at, 'scope must be $global or a node with an id');
  const subjects = isPlain(r.subjects) ? r.subjects : {};
  const assignments = isPlain(r.assignments) ? r.assignments : {};
  const lists = { resourceTypes: r.resourceTypes, permissions: r.permissions, 'subjects.principalTypes': subjects.principalTypes, 'subjects.actorTypes': subjects.actorTypes, 'assignments.scopeTypes': assignments.scopeTypes, 'assignments.subjectTypes': assignments.subjectTypes };
  for (const [key, v] of Object.entries(lists)) refuse(v !== undefined && !isNames(v), at, `${key} must be a non-empty list of names`);
  refuse(r.kind === 'threshold' && r.permissions === undefined, at, 'a threshold needs permissions');
  const refs = subjects.refs;
  refuse(refs !== undefined && !(Array.isArray(refs) && refs.length > 0 && refs.every((p) => isPlain(p) && typeof p.type === 'string' && typeof p.id === 'string')), at, 'subjects.refs must be a non-empty list of { type, id }');
  const rank = subjects.rank;
  refuse(rank !== undefined && (!isPlain(rank) || ['lt', 'eq', 'gte'].filter((k) => rank[k] !== undefined).length !== 1), at, 'subjects.rank needs exactly one of lt, eq, gte');
  refuse(r.kind === 'cap' && r.maxRole === undefined && r.stripTags !== true, at, 'a cap needs maxRole or stripTags: true');
}

/**
 * Rules as frozen RuleDefs: a rule without a scope applies at GLOBAL (design §5.8; §8.5 writes none), `source` is
 * filled and an ISO `expiresAt` becomes a Date. AUTHZ_RBAC_CONFIGURATION_SCHEMA checks the shape of
 * `authz.rbac.rules`; the RBAC model checks ladders, roles, permissions and conditions when it compiles them.
 * @throws AuthzConfigError for a rule the schema would refuse that would read as broader access, or an `expiresAt`
 *   that is not a date (a list given to ConfigRuleStore skips the schema)
 */
export function readRuleDefs(rules: readonly unknown[], source = 'config'): readonly RuleDef[] {
  refuse(!Array.isArray(rules), 'authz.rbac.rules', 'must be a list of rules');
  return Object.freeze(
    rules.map((given, i) => {
      const r = given as RuleDef;
      const at = `authz.rbac.rules[${i}]${typeof r?.id === 'string' ? ` (id '${r.id}')` : ''}`;
      refuse(!isPlain(given), at, 'must be an object');
      const scope = r.scope === undefined ? GLOBAL : r.scope;
      floor(given as Raw, scope, at);
      return deepFreeze({ ...r, scope, source: r.source ?? source, ...expiry(r.expiresAt, at) });
    }),
  );
}

function expiry(value: unknown, at: string): { expiresAt?: Date | null } {
  if (value === undefined || value === null) return value === null ? { expiresAt: null } : {};
  const ms = typeof value === 'string' ? Date.parse(value) : Object.prototype.toString.call(value) === '[object Date]' ? Date.prototype.getTime.call(value) : NaN;
  if (Number.isNaN(ms)) throw new AuthzConfigError(`${at}: expiresAt must be a date or an ISO date string`);
  return { expiresAt: new Date(ms) };
}

/**
 * Rules from config (design §8.2 `authz.rbac.rules`) through @Config, or from a list or a Configuration given to the
 * constructor (tests, a host that builds the model itself). Registered by its class name; `registerRbacStores` binds
 * it to `RuleStore` when `authz.rbac.stores.rules` names it (the default).
 */
@Injectable()
export class ConfigRuleStore extends RuleStore {
  readonly name = 'ConfigRuleStore';

  @Config('authz.rbac.rules')
  protected Rules: readonly unknown[] | undefined;

  private loaded?: readonly RuleDef[];
  private hash?: string;

  constructor(private readonly source?: Pick<Configuration, 'get'> | readonly RuleDef[]) {
    super();
  }

  /** Every rule, expired ones included; the model reads them without IO. */
  all(): readonly RuleDef[] {
    this.loaded ??= readRuleDefs(this.configured() ?? []);
    return this.loaded;
  }

  /** The rules live at `at` whose scope is one of `path`. */
  rulesOn(path: readonly ResourceRef[], at: Date): readonly RuleDef[] {
    const keys = new Set(path.map(resourceKey));
    return this.all().filter((r) => keys.has(resourceKey(r.scope)) && (r.expiresAt == null || r.expiresAt.getTime() > at.getTime()));
  }

  async forPath(path: readonly ResourceRef[], at: Date): Promise<readonly RuleDef[]> {
    return this.rulesOn(path, at);
  }

  async version(): Promise<string> {
    this.hash ??= createHash('sha256').update(JSON.stringify(this.all())).digest('hex');
    return this.hash;
  }

  private configured(): readonly unknown[] | undefined {
    if (Array.isArray(this.source)) return this.source as readonly RuleDef[];
    const configuration = this.source as Pick<Configuration, 'get'> | undefined;
    return configuration ? configuration.get<readonly unknown[] | undefined>(['authz', 'rbac', 'rules']) : this.Rules;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value) && !(value instanceof Date)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
