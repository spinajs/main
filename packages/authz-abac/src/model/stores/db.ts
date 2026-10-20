import { createHash } from 'node:crypto';
import { AuthzAdminFailure, AuthzConfigError, GLOBAL, parseCondition, principalKey } from '@spinajs/authz';
import type { AuthzTx, Policy, PrincipalRef } from '@spinajs/authz';
import { UniqueViolation, ormReady } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { PolicyStore } from '../../contracts.js';
import { loadPolicy } from '../policies.js';
import { AUTHZ_POLICY_TABLE, POLICY_ACTOR_MAX_LENGTH, POLICY_ID_MAX_LENGTH, POLICY_TEXT_MAX_LENGTH, PolicyRecord, requirePolicyTransaction } from './policy-record.js';
import type { PolicyFields, PolicyValues } from './policy-record.js';

/** The store's tags for an AuthzChange after a write commits; AbacModel reloads on them. */
export const policyTags = (id: string): readonly string[] => Object.freeze(['policy', `policy:${id}`]);

/**
 * `PolicyStore` over `authz_policy` (design §9.1) on the ORM connection alias `authz`. Reads any time;
 * `put` and `delete` write only inside the transaction of an `AuthzAdmin` command on that connection
 * (design §9.2), whose handler validates the policy first and bumps `authz_version` with the rest of the
 * command. `version()` hashes the rows, so it changes with every write, also one made outside this process.
 */
export class DbPolicyStore extends PolicyStore {
  readonly name: string = 'db';

  async load(): Promise<readonly Policy[]> {
    return (await this.records()).map(recordToPolicy);
  }

  async version(): Promise<string> {
    const hash = createHash('sha256');
    for (const r of await this.records()) hash.update(JSON.stringify(versionKey(r)));
    return hash.digest('hex').slice(0, 16);
  }

  /**
   * Inserts or replaces the policy with this id. It is checked first (shape, globs, condition
   * grammar; function names are the model's business) and must fit the columns, since one bad row
   * would make every reload of the model fail.
   */
  async put(policy: Omit<Policy, 'source'>, actor: PrincipalRef | undefined, tx: AuthzTx, now: Date = new Date()): Promise<{ readonly affected: number; readonly tags: readonly string[] }> {
    const where = 'DbPolicyStore.put';
    const { policy: checked } = loadPolicy({ ...policy, source: 'db' }, 0, { source: 'db' }, (c, at) => parseCondition(c, { functions: { has: () => true }, where: at }));
    fits(checked);
    if (actor && principalKey(actor).length > POLICY_ACTOR_MAX_LENGTH) throw new AuthzConfigError(`DbPolicyStore: the actor key is longer than the created_by column (${POLICY_ACTOR_MAX_LENGTH})`);
    requirePolicyTransaction(tx, where);
    await PolicyRecord.destroy().where('id', checked.id);
    try {
      await PolicyRecord.insert(policyToRecord(checked, actor, now) as Partial<PolicyRecord>);
    } catch (err) {
      if (!(err instanceof UniqueViolation)) throw err;
      throw new AuthzAdminFailure('conflict', `${where}: another transaction wrote policy ${JSON.stringify(checked.id)} meanwhile; retry`, undefined, { cause: err });
    }
    return { affected: 1, tags: policyTags(checked.id) };
  }

  async delete(id: string, tx: AuthzTx): Promise<{ readonly affected: number; readonly tags: readonly string[] }> {
    requirePolicyTransaction(tx, 'DbPolicyStore.delete');
    // Only the id, so a row whose JSON no longer parses can still be deleted (load, version and policy reads refuse it).
    const [before] = await PolicyRecord.query().select('id').where('id', id);
    if (!before) return { affected: 0, tags: [] };
    await PolicyRecord.destroy().where('id', id);
    return { affected: 1, tags: policyTags(id) };
  }

  /** Every row, in code-unit order of the ids: neither the order nor the version depends on a collation. */
  private async records(): Promise<PolicyRecord[]> {
    // A model loads its policies at domain boot, possibly before anything resolved the Orm.
    await ormReady();
    const rows = await hydrateRecords(PolicyRecord.query());
    return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

/** Awaits a PolicyRecord query; a JSON column that does not parse becomes an AuthzConfigError naming the table. */
export async function hydrateRecords(query: PromiseLike<PolicyRecord[]>): Promise<PolicyRecord[]> {
  try {
    return await query;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new AuthzConfigError(`${AUTHZ_POLICY_TABLE}: a row holds a JSON column that does not parse (${err.message})`, { cause: err });
  }
}

const COLUMN_WIDTHS: readonly [string, (p: Policy) => string | undefined, number][] = [
  ['id', (p) => p.id, POLICY_ID_MAX_LENGTH],
  ['reason', (p) => p.reason, POLICY_TEXT_MAX_LENGTH],
  ['scope type', (p) => p.scope?.type, POLICY_TEXT_MAX_LENGTH],
  ['scope id', (p) => p.scope?.id, POLICY_TEXT_MAX_LENGTH],
];

function fits(p: Policy): void {
  for (const [what, get, max] of COLUMN_WIDTHS) {
    const v = get(p);
    if (v !== undefined && v.length > max) throw new AuthzConfigError(`DbPolicyStore: policy ${JSON.stringify(p.id.slice(0, 64))}: ${what} is longer than ${max} characters`);
  }
}

/** What version() hashes for a row: the record's values, datetimes as epoch milliseconds. */
const versionKey = (r: PolicyFields): unknown[] => [r.id, r.effect, r.permissions, r.resource_types, r.principal_types, r.actor_types, r.scope_type, r.scope_id, r.condition, r.fields, r.reason, r.priority, r.expires_at?.toMillis() ?? null, r.created_at.toMillis()];

/** The `authz_policy` values of a policy `loadPolicy` checked. */
export function policyToRecord(p: Policy, actor: PrincipalRef | undefined, now: Date): PolicyValues {
  const scope = p.scope ?? GLOBAL;
  return {
    id: p.id,
    effect: p.effect,
    permissions: p.permissions,
    resource_types: p.resourceTypes ?? null,
    principal_types: p.principalTypes ?? null,
    actor_types: p.actorTypes ?? null,
    scope_type: scope.type,
    scope_id: scope.id ?? '',
    condition: p.when ?? null,
    fields: p.fields ?? null,
    reason: p.reason ?? null,
    priority: p.priority ?? null,
    expires_at: p.expiresAt ? DateTime.fromJSDate(p.expiresAt) : null,
    created_by: actor ? principalKey(actor) : null,
    created_at: DateTime.fromJSDate(now),
  };
}

/** The policy an `authz_policy` row holds. */
export function recordToPolicy(r: PolicyFields): Policy {
  const scope = r.scope_type === GLOBAL.type && r.scope_id === '' ? undefined : r.scope_id === '' ? { type: r.scope_type } : { type: r.scope_type, id: r.scope_id };
  const optional = (key: string, v: unknown) => (v === undefined || v === null ? {} : { [key]: v });
  return {
    id: r.id,
    effect: r.effect as Policy['effect'],
    permissions: r.permissions,
    ...optional('resourceTypes', r.resource_types),
    ...optional('principalTypes', r.principal_types),
    ...optional('actorTypes', r.actor_types),
    ...optional('scope', scope),
    ...optional('when', r.condition),
    ...optional('fields', r.fields),
    ...optional('reason', r.reason),
    ...optional('priority', r.priority),
    ...optional('expiresAt', r.expires_at?.toJSDate()),
    source: 'db',
  } as Policy;
}
