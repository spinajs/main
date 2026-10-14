import { AuthzAdminFailure, AuthzClock, GLOBAL, principalKey } from '@spinajs/authz';
import type { AssignmentSubject, AuthzTx, PrincipalRef, ResourceRef, RuleDef } from '@spinajs/authz';
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';

import { AdminRuleStore } from '../admin/ports.js';
import type { Page } from '../admin/ports.js';
import { scopeFromColumns, scopeToColumns, subjectFromColumns, subjectToColumns, toDate } from './columns.js';
import type { ScopeColumns } from './columns.js';
import { storeConnection, storeDomain, storeTransactionDriver } from './context.js';
import { isUniqueViolation, pageWindow, whereLive } from './queries.js';
import { AUTHZ_RULE_SUBJECT_TABLE, AUTHZ_RULE_TABLE, toRuleRows } from './rule-rows.js';
import type { RuleRow, RuleSubjectList, RuleSubjectRow } from './rule-rows.js';
import { readVersion, bumpVersion } from './version.js';

/** `AuthzAdmin.list({ kind: 'rules' })` without the kind. */
export interface RuleListQuery {
  readonly scope?: ResourceRef;
  readonly page?: { readonly limit: number; readonly offset: number };
}

/** An `authz_rule_subject` row as a subject of a rule's list. */
export interface RuleSubjectRef {
  readonly ruleId: string;
  readonly list: RuleSubjectList;
  readonly subject: AssignmentSubject;
}

/** What `forgetScope` deleted: the rules at the scope, and the list entries of other rules naming a subject set there. */
export interface RuleForgetResult {
  readonly rules: readonly RuleDef[];
  readonly subjects: readonly RuleSubjectRef[];
}

/** The most rules one `list` call returns, with or without a page. */
export const RULE_LIST_MAX_LIMIT = 1000;

const SCOPE_BATCH = 250;
const ID_BATCH = 500;
const INSERT_BATCH = 100;

type StoredRuleRow = RuleRow & { readonly id: string; readonly definition: string; readonly created_by: string | null; readonly created_at: Date | string };

/**
 * `RuleStore` over `authz_rule` and `authz_rule_subject` (design §9.1): scoped DB rules, check-only:
 * the rule is its `definition` JSON. Reads use the `authz.rbac.connection` connection; writes run on
 * the `AuthzTx` of `AuthzAdmin` and bump `authz_version` of the store's domain once per call (B27).
 * Registered by class name only; a domain uses it by registering it as `AdminRuleStore` and `RuleStore`.
 */
@PerChildInstance()
@Injectable()
@Inject(Container)
export class DbRuleStore extends AdminRuleStore {
  readonly name: string = 'DbRuleStore';

  protected readonly scopeBatch: number = SCOPE_BATCH;
  protected readonly maxListLimit: number = RULE_LIST_MAX_LIMIT;

  constructor(protected readonly container: IContainer) {
    super();
  }

  /**
   * Live rules (`expires_at` null or after `at`) held at a node of `path` or at GLOBAL, which every
   * path ends in; so an empty path gives the GLOBAL rules.
   */
  async forPath(path: readonly ResourceRef[], at: Date): Promise<readonly RuleDef[]> {
    const scopes = uniqueScopes([...path, GLOBAL]);
    const driver = await this.connection();
    const rows: StoredRuleRow[] = [];

    for (let i = 0; i < scopes.length; i += this.scopeBatch) {
      const query = driver.select().from(AUTHZ_RULE_TABLE);
      whereScopes(query, scopes.slice(i, i + this.scopeBatch));
      whereLive(query, at);
      rows.push(...(await rulesOf(query)));
    }

    return this.rulesOf(
      driver,
      rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
  }

  async version(): Promise<string> {
    return readVersion(await this.connection(), this.domain());
  }

  /** Expired rules too; null for an unknown id. */
  async byId(id: string): Promise<RuleDef | null> {
    const driver = await this.connection();
    const row = await ruleById(driver, id);
    return row ? (await this.rulesOf(driver, [row]))[0] : null;
  }

  /** Inserts the rule, or replaces the one with its id (row and subject rows; the first `created_at` and `created_by` stay). */
  async put(rule: Omit<RuleDef, 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    const driver = await this.writeDriver(tx, `${this.name}.put`);
    const rows = toRuleRows(rule);
    const { id, ...columns } = rows.rule;

    if (await this.existingRule(driver, id)) {
      await driver.update().in(AUTHZ_RULE_TABLE).update(columns).where('id', id);
      await driver.del().from(AUTHZ_RULE_SUBJECT_TABLE).where('rule_id', id);
    } else {
      try {
        await driver.insert().into(AUTHZ_RULE_TABLE).values({ ...rows.rule, created_by: principalKey(actor), created_at: this.now() });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        throw new AuthzAdminFailure('conflict', `${this.name}.put: another transaction wrote rule ${JSON.stringify(id)}; retry`, 'id', { cause: err });
      }
    }

    for (let i = 0; i < rows.subjects.length; i += INSERT_BATCH) {
      await driver
        .insert()
        .into(AUTHZ_RULE_SUBJECT_TABLE)
        .values(rows.subjects.slice(i, i + INSERT_BATCH));
    }

    await bumpVersion(driver, this.domain());
  }

  /** What the columns cannot hold, refused before the batch transaction ({@link toRuleRows}). */
  assertStorable(rule: Omit<RuleDef, 'source'>): void {
    toRuleRows(rule);
  }

  /** `rule.delete` as {@link remove}. */
  async delete(id: string, tx: AuthzTx): Promise<void> {
    await this.remove(id, tx);
  }

  /** Deletes the rule and its subject rows and returns it; unknown id ⇒ `not_found`. */
  async remove(id: string, tx: AuthzTx): Promise<RuleDef> {
    const driver = await this.writeDriver(tx, `${this.name}.delete`);
    const row = await ruleById(driver, id);
    if (!row) throw new AuthzAdminFailure('not_found', `Rule ${JSON.stringify(id)} does not exist`, 'id');

    const [rule] = await this.rulesOf(driver, [row]);
    await driver.del().from(AUTHZ_RULE_SUBJECT_TABLE).where('rule_id', id);
    await driver.del().from(AUTHZ_RULE_TABLE).where('id', id);
    await bumpVersion(driver, this.domain());
    return rule;
  }

  /** `scope.forget` as {@link forgetScopeEntries}; returns the deleted rules. */
  async forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly RuleDef[]> {
    return (await this.forgetScopeEntries(scope, tx)).rules;
  }

  /**
   * Deletes the rules AT `scope` (not below it; expired ones too) with their subject rows, and the
   * `allow` entries of other rules that name a subject set living at `scope`, so a later scope with
   * the same id is never allowed by them. GLOBAL and type-level refs are refused
   * (`wrong_scope_type`).
   */
  async forgetScopeEntries(scope: ResourceRef, tx: AuthzTx): Promise<RuleForgetResult> {
    if (scope.type === GLOBAL.type || !scope.id) {
      throw new AuthzAdminFailure('wrong_scope_type', `${this.name}.forgetScope: only a scope node can be forgotten, not ${scope.type === GLOBAL.type ? 'GLOBAL' : `the type-level ref ${scope.type}`}`, 'scope');
    }

    const driver = await this.writeDriver(tx, `${this.name}.forgetScope`);
    const columns = scopeToColumns(scope);

    const ruleRows = await rulesOf(driver.select().from(AUTHZ_RULE_TABLE).where(columns).orderBy('id'));
    const rules = await this.rulesOf(driver, ruleRows);
    for (let i = 0; i < ruleRows.length; i += ID_BATCH) {
      const ids = ruleRows.slice(i, i + ID_BATCH).map((r) => r.id);
      await driver.del().from(AUTHZ_RULE_SUBJECT_TABLE).whereIn('rule_id', ids);
      await driver.del().from(AUTHZ_RULE_TABLE).whereIn('id', ids);
    }

    const setAtScope = { subject_type: columns.scope_type, subject_id: columns.scope_id };
    const subjectRows = await subjectRowsOf(driver.select().from(AUTHZ_RULE_SUBJECT_TABLE).where(setAtScope).where('subject_role', '!=', ''));
    if (subjectRows.length > 0) await driver.del().from(AUTHZ_RULE_SUBJECT_TABLE).where(setAtScope).where('subject_role', '!=', '');

    await bumpVersion(driver, this.domain());
    return {
      rules,
      subjects: subjectRows.map((s) => ({ ruleId: s.rule_id, list: s.list, subject: subjectFromColumns(s.subject_type, s.subject_id, s.subject_role) })),
    };
  }

  /**
   * Page for `AuthzAdmin.list` (kind `rules`), expired rules included, oldest first; `total` counts
   * the unpaged result. At most {@link RULE_LIST_MAX_LIMIT} rows; a negative or fractional `limit`
   * or `offset` is `invalid_page`.
   */
  async list(q: RuleListQuery = {}): Promise<{ items: readonly RuleDef[]; total: number }> {
    return this.select(q.scope, pageWindow(q.page, this.maxListLimit, `${this.name}.list`));
  }

  /** `AdminRuleStore.find`: with a page, as {@link list}; without one, every rule of the scope (one rule query). */
  async find(q: { readonly scope?: ResourceRef }, page?: Page): Promise<{ items: readonly RuleDef[]; total: number }> {
    return this.select(q.scope, page ? pageWindow(page, this.maxListLimit, `${this.name}.find`) : undefined);
  }

  protected connection(): Promise<OrmDriver> {
    return storeConnection(this.container);
  }

  /** Rules oldest first; `window` undefined reads every match in one rule query. */
  private async select(scope: ResourceRef | undefined, window: { limit: number; offset: number } | undefined): Promise<{ items: readonly RuleDef[]; total: number }> {
    const driver = await this.connection();
    const filtered = () => {
      const query = driver.select().from(AUTHZ_RULE_TABLE);
      if (scope) query.where(scopeToColumns(scope));
      return query;
    };

    if (!window) {
      const items = await this.rulesOf(driver, await rulesOf(filtered().orderBy('created_at').orderBy('id')));
      return { items, total: items.length };
    }

    const total = Number(await filtered().selectCount());
    if (window.limit === 0) return { items: [], total };

    const query = filtered().orderBy('created_at').orderBy('id').take(window.limit);
    if (window.offset > 0) query.skip(window.offset);

    return { items: await this.rulesOf(driver, await rulesOf(query)), total };
  }

  /** The driver of `tx`, which must be a transaction on {@link connection}. */
  protected async writeDriver(tx: AuthzTx, where: string): Promise<OrmDriver> {
    return storeTransactionDriver(tx, await this.connection(), where);
  }

  protected existingRule(driver: OrmDriver, id: string): Promise<StoredRuleRow | undefined> {
    return ruleById(driver, id);
  }

  protected domain(): string {
    return storeDomain(this.container);
  }

  protected now(): Date {
    return this.container.hasRegistered(AuthzClock) ? this.container.resolve(AuthzClock).now() : new Date();
  }

  /** The rows as rules, with their subject rows loaded in batches. */
  private async rulesOf(driver: OrmDriver, rows: readonly StoredRuleRow[]): Promise<RuleDef[]> {
    if (rows.length === 0) return [];

    const subjects = new Map<string, RuleSubjectRow[]>();
    for (let i = 0; i < rows.length; i += ID_BATCH) {
      const ids = rows.slice(i, i + ID_BATCH).map((r) => r.id);
      for (const s of await subjectRowsOf(driver.select().from(AUTHZ_RULE_SUBJECT_TABLE).whereIn('rule_id', ids))) {
        subjects.set(s.rule_id, [...(subjects.get(s.rule_id) ?? []), s]);
      }
    }

    return rows.map((r) => rowToRule(r, subjects.get(r.id) ?? []));
  }
}

/**
 * A stored rule: `definition` plus the id, kind, scope and expiry columns, `source: 'db'`. `allow`
 * and `subjects.refs` keep only the entries that still have a subject row, so what `forgetScope`
 * removed is gone.
 */
export function rowToRule(row: RuleRow & { readonly definition: unknown }, subjectRows: readonly RuleSubjectRow[]): RuleDef {
  const def = JSON.parse(String(row.definition)) as Partial<RuleDef>;
  const held = new Set(subjectRows.map((s) => subjectKey(s.list, s)));
  const keep = <T extends AssignmentSubject>(list: RuleSubjectList, xs: readonly T[]) => xs.filter((s) => held.has(subjectKey(list, subjectToColumns(s))));

  return {
    ...def,
    ...(def.allow ? { allow: keep('allow', def.allow) } : {}),
    ...(def.subjects?.refs ? { subjects: { ...def.subjects, refs: keep('refs', def.subjects.refs) } } : {}),
    id: String(row.id),
    kind: row.kind as RuleDef['kind'],
    scope: scopeFromColumns(String(row.scope_type), row.scope_id as string | null),
    expiresAt: toDate(row.expires_at),
    source: 'db',
  };
}

function subjectKey(list: string, s: { subject_type: string; subject_id: string; subject_role: string }): string {
  return JSON.stringify([list, s.subject_type, s.subject_id, s.subject_role]);
}

function uniqueScopes(refs: readonly ResourceRef[]): ScopeColumns[] {
  const seen = new Map<string, ScopeColumns>();
  for (const r of refs) {
    const c = scopeToColumns(r);
    seen.set(JSON.stringify([c.scope_type, c.scope_id]), c);
  }
  return [...seen.values()];
}

/** `(scope_type = ? AND scope_id IN (…)) OR …`, one group per type; row-value `IN` is not portable. */
function whereScopes(query: IWhereBuilder<unknown>, scopes: readonly ScopeColumns[]): void {
  const byType = new Map<string, string[]>();
  for (const s of scopes) byType.set(s.scope_type, [...(byType.get(s.scope_type) ?? []), s.scope_id]);

  query.where(function () {
    for (const [type, ids] of byType) {
      this.orWhere(function () {
        this.where('scope_type', type).whereIn('scope_id', ids);
      });
    }
  });
}

async function rulesOf(query: PromiseLike<unknown>): Promise<StoredRuleRow[]> {
  return (await query) as StoredRuleRow[];
}

async function subjectRowsOf(query: PromiseLike<unknown>): Promise<RuleSubjectRow[]> {
  return (await query) as RuleSubjectRow[];
}

async function ruleById(driver: OrmDriver, id: string): Promise<StoredRuleRow | undefined> {
  const [row] = await rulesOf(driver.select().from(AUTHZ_RULE_TABLE).where('id', id));
  return row;
}
