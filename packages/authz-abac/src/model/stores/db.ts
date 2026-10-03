import { createHash } from 'node:crypto';
import { AuthzConfigError, GLOBAL, parseCondition, principalKey } from '@spinajs/authz';
import type { AuthzTx, Policy, PrincipalRef } from '@spinajs/authz';
import { OrmDriver } from '@spinajs/orm';

import { PolicyStore } from '../../contracts.js';
import { loadPolicy } from '../policies.js';

export const AUTHZ_POLICY_TABLE = 'authz_policy';

interface PolicyRow {
  id: string;
  effect: string;
  permissions: string;
  resource_types: string | null;
  principal_types: string | null;
  actor_types: string | null;
  scope_type: string;
  scope_id: string;
  condition: string | null;
  fields: string | null;
  reason: string | null;
  priority: number | string | null;
  expires_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
}

/** The store's tags for an AuthzChange after a write commits; AbacModel reloads on them. */
export const policyTags = (id: string): readonly string[] => Object.freeze(['policy', `policy:${id}`]);

/**
 * `PolicyStore` over `authz_policy` (design §9.1). Reads any time; `put` and `delete` write only
 * inside the transaction of an `AuthzAdmin` command (design §9.2), whose handler validates the
 * policy first and bumps `authz_version` with the rest of the command. `version()` hashes the rows,
 * so it changes with every write, also one made outside this process.
 */
export class DbPolicyStore extends PolicyStore {
  readonly name: string = 'db';

  /** `driver`: the connection, or how to get it (resolved on first use). */
  constructor(private readonly driver: OrmDriver | (() => OrmDriver | Promise<OrmDriver>)) {
    super();
  }

  async load(): Promise<readonly Policy[]> {
    return (await this.rows()).map(rowToPolicy);
  }

  async version(): Promise<string> {
    const rows = await this.rows();
    const hash = createHash('sha256');
    for (const r of rows) hash.update(JSON.stringify([r.id, r.effect, r.permissions, r.resource_types, r.principal_types, r.actor_types, r.scope_type, r.scope_id, r.condition, r.fields, r.reason, r.priority, iso(r.expires_at), iso(r.created_at)]));
    return hash.digest('hex').slice(0, 16);
  }

  /**
   * Inserts or replaces the policy with this id. It is checked first (shape, globs, condition
   * grammar; function names are the model's business) and must fit the columns, since one bad row
   * would make every reload of the model fail.
   */
  async put(policy: Omit<Policy, 'source'>, actor: PrincipalRef | undefined, tx: AuthzTx, now: Date = new Date()): Promise<{ readonly affected: number; readonly tags: readonly string[] }> {
    loadPolicy({ ...policy, source: 'db' }, 0, { source: 'db' }, (c, where) => parseCondition(c, { functions: { has: () => true }, where }));
    fits(policy);
    const driver = writeDriver(tx);
    await driver.del().from(AUTHZ_POLICY_TABLE).where('id', policy.id);
    await driver.insert().into(AUTHZ_POLICY_TABLE).values(policyToRow(policy, actor, now));
    return { affected: 1, tags: policyTags(policy.id) };
  }

  async delete(id: string, tx: AuthzTx): Promise<{ readonly affected: number; readonly tags: readonly string[] }> {
    const driver = writeDriver(tx);
    const before = await driver.select().from(AUTHZ_POLICY_TABLE).where('id', id);
    if ((before as unknown[]).length === 0) return { affected: 0, tags: [] };
    await driver.del().from(AUTHZ_POLICY_TABLE).where('id', id);
    return { affected: 1, tags: policyTags(id) };
  }

  private async rows(): Promise<PolicyRow[]> {
    const driver = typeof this.driver === 'function' ? await this.driver() : this.driver;
    return (await driver.select().from(AUTHZ_POLICY_TABLE).orderBy('id')) as unknown as PolicyRow[];
  }
}

const COLUMN_LENGTHS: readonly [string, (p: Omit<Policy, 'source'>) => string | undefined, number][] = [
  ['id', (p) => p.id, 64],
  ['reason', (p) => p.reason, 64],
  ['scope type', (p) => p.scope?.type, 64],
  ['scope id', (p) => p.scope?.id, 64],
];

function fits(p: Omit<Policy, 'source'>): void {
  for (const [what, get, max] of COLUMN_LENGTHS) {
    const v = get(p);
    if (v !== undefined && v.length > max) throw new AuthzConfigError(`DbPolicyStore: policy ${JSON.stringify(p.id.slice(0, 64))}: ${what} is longer than ${max} characters`);
  }
}

/** Any transaction on the driver passes; AuthzAdmin is the only caller that should open one for a store write. */
function writeDriver(tx: AuthzTx): OrmDriver {
  const driver = tx?.driver;
  if (!(driver instanceof OrmDriver)) throw new AuthzConfigError('DbPolicyStore: AuthzTx.driver must be the OrmDriver of an AuthzAdmin transaction');
  if (driver.CurrentTransaction === undefined) throw new AuthzConfigError('DbPolicyStore: writes run only inside an AuthzAdmin transaction, and none is in scope');
  return driver;
}

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export function policyToRow(p: Omit<Policy, 'source'>, actor: PrincipalRef | undefined, now: Date): PolicyRow {
  const scope = p.scope ?? GLOBAL;
  return {
    id: p.id,
    effect: p.effect,
    permissions: JSON.stringify(p.permissions),
    resource_types: json(p.resourceTypes),
    principal_types: json(p.principalTypes),
    actor_types: json(p.actorTypes),
    scope_type: scope.type,
    scope_id: scope.id ?? '',
    condition: json(p.when),
    fields: json(p.fields),
    reason: p.reason ?? null,
    priority: p.priority ?? null,
    expires_at: p.expiresAt ? new Date(p.expiresAt) : null,
    created_by: actor ? principalKey(actor) : null,
    created_at: now,
  };
}

export function rowToPolicy(r: PolicyRow): Policy {
  const parse = (column: string, v: string | null): unknown => {
    if (v === null || v === undefined) return undefined;
    try {
      return JSON.parse(v);
    } catch (e) {
      throw new AuthzConfigError(`authz_policy ${JSON.stringify(r.id)}: column ${column} is not JSON`, { cause: e });
    }
  };
  const scope = r.scope_type === GLOBAL.type && r.scope_id === '' ? undefined : r.scope_id === '' ? { type: r.scope_type } : { type: r.scope_type, id: r.scope_id };
  const optional = (key: string, v: unknown) => (v === undefined || v === null ? {} : { [key]: v });
  return {
    id: r.id,
    effect: r.effect as Policy['effect'],
    permissions: parse('permissions', r.permissions) as string[],
    ...optional('resourceTypes', parse('resource_types', r.resource_types)),
    ...optional('principalTypes', parse('principal_types', r.principal_types)),
    ...optional('actorTypes', parse('actor_types', r.actor_types)),
    ...optional('scope', scope),
    ...optional('when', parse('condition', r.condition)),
    ...optional('fields', parse('fields', r.fields)),
    ...optional('reason', r.reason),
    ...optional('priority', r.priority === null ? null : Number(r.priority)),
    ...optional('expiresAt', r.expires_at === null ? null : new Date(r.expires_at)),
    source: 'db',
  } as Policy;
}
