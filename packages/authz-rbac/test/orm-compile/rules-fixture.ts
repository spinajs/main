import { CONDITION_UNKNOWN, DefaultConditionCompiler, GLOBAL, evaluateResidual, flattenAttributes, unflattenAttributes } from '@spinajs/authz';
import type { Condition, DecisionRequest, EvaluationContext, Principal, ResourceFilter, ResourceRef, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';
// The engine merges attribute layers with these but does not export them; read its build directly
// (`builtEngineIsFresh` guards against a stale build).
import { mergeAttributes, schemaIndex } from '../../../authz/lib/mjs/engine/attributes.js';
import { AuthzScopeAttribute_2026_10_02_00_00_00, DbScopeAttributeStore } from '@spinajs/authz-orm';
import { IdentifierQuoter, QueryContext } from '@spinajs/orm';
import { statSync } from 'node:fs';
import type { OrmDriver } from '@spinajs/orm';

import { AuthzRbac_2026_10_01_00_00_00, fromSqlForm, toSqlForm } from '../../src/index.js';
import type { LadderDef } from '../../src/index.js';
import { renderSql, rsql } from '../../src/orm/index.js';
import type { RbacResourceField, RbacScopePath, RbacSql } from '../../src/orm/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { DbKind, TestDb } from '../support/db.js';

export type Cell = string | number | null;
export type Row = Readonly<Record<string, Cell>>;
export type Three = true | false | null;

export const NOW = new Date('2026-10-01T12:00:00.000Z');
export const RULE = 'authz_r';
const ACTOR = { type: 'user', id: 'root' };

/** The real migrations: authz-rbac's (authz_rule, authz_rule_subject) and authz-orm's (authz_scope_attribute). */
export async function bootRulesDb(ctx: Mocha.Context, kind: DbKind, suite: string): Promise<TestDb> {
  const db = await bootDb(ctx, kind, suite, { migrate: false });
  await new AuthzRbac_2026_10_01_00_00_00().up(db.driver);
  await new AuthzScopeAttribute_2026_10_02_00_00_00().up(db.driver);
  return db;
}

export const quoterOf = (driver: OrmDriver): IdentifierQuoter => driver.Container.resolve(IdentifierQuoter);

/** A whole statement built as a fragment; `outer(column)` names the scoped row under the plain-text alias `r`. */
export async function select(driver: OrmDriver, statement: RbacSql): Promise<Array<Record<string, unknown>>> {
  const q = quoterOf(driver);
  const { text, bindings } = renderSql(statement, { driver, outer: (column) => `${q.quote('r')}.${q.quote(column)}`, outerName: 'r' });
  return (await rawQuery(driver, text, [...bindings])) as Array<Record<string, unknown>>;
}

/** 1, 0 or NULL for a predicate: TRUE, FALSE or UNKNOWN. */
export const three = (block: RbacSql): RbacSql => rsql`CASE WHEN ${block} THEN 1 WHEN NOT (${block}) THEN 0 END`;

export const asThree = (v: unknown): Three => (v === null || v === undefined ? null : Number(v) === 1);

export async function analyze(driver: OrmDriver, tables: readonly string[]): Promise<void> {
  const q = quoterOf(driver);
  for (const t of tables) await rawQuery(driver, `ANALYZE ${q.quote(t)}`, [], QueryContext.Schema);
}

export async function clear(driver: OrmDriver, tables: readonly string[]): Promise<void> {
  const q = quoterOf(driver);
  for (const t of tables) await rawQuery(driver, `DELETE FROM ${q.quote(t)}`, [], QueryContext.Delete);
}

/** Rules as toSqlForm writes them (the columns DbRuleStore stores), rule ids unique. */
export async function writeRules(driver: OrmDriver, rules: readonly Omit<RuleDef, 'source'>[], ladders: readonly LadderDef[] = []): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  const subjects: Record<string, unknown>[] = [];
  for (const rule of rules) {
    const form = toSqlForm(rule, ladders);
    rows.push({ ...form.rule, created_by: 'user:root', created_at: NOW });
    subjects.push(...form.subjects.map((s) => ({ ...s })));
  }
  for (let i = 0; i < rows.length; i += 50)
    await driver
      .insert()
      .into('authz_rule')
      .values(rows.slice(i, i + 50));
  for (let i = 0; i < subjects.length; i += 100)
    await driver
      .insert()
      .into('authz_rule_subject')
      .values(subjects.slice(i, i + 100));
}

/** Scope attributes as AuthzAdmin writes them: flattenAttributes, then DbScopeAttributeStore.write in a transaction. */
export async function writeAttributes(db: TestDb, nodes: ReadonlyArray<readonly [ResourceRef, Record<string, unknown>]>): Promise<void> {
  const store = new DbScopeAttributeStore({ container: db.container });
  await db.driver.transaction(async (driver: OrmDriver) => {
    for (const [ref, attributes] of nodes) {
      await store.forget(ref, { driver });
      const { set } = flattenAttributes(attributes);
      if (Object.keys(set).length > 0) await store.write(ref, { set, remove: [] }, ACTOR, { driver });
    }
  });
}

export async function storedRules(driver: OrmDriver): Promise<Map<string, ReturnType<typeof fromSqlForm>>> {
  const rows = (await driver.select().from('authz_rule')) as Record<string, unknown>[];
  const subjects = (await driver.select().from('authz_rule_subject')) as Record<string, unknown>[];
  return new Map(rows.map((r) => [String(r.id), fromSqlForm(r as never, subjects.filter((s) => s.rule_id === r.id) as never)]));
}

// ---- oracle: the core's condition compiler and residual evaluator ----

const PRINCIPAL: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'session', attributes: {} };

/** Ancestors as authz-orm's adapter gives them: the row, each non-NULL scope column as text, GLOBAL. */
export function adapterAncestors(path: RbacScopePath, row: Row): ResourceRef[] {
  const out: ResourceRef[] = [{ type: path.type, id: String(row[path.idColumn]) }];
  for (const s of path.scopes) if (row[s.column] !== null && row[s.column] !== undefined) out.push({ type: s.scopeType, id: String(row[s.column]) });
  out.push(GLOBAL);
  return out;
}

export interface Oracle {
  /** The node's attributes as the engine layers them: schema defaults ⊕ the adapter's layer ⊕ the store's rows. */
  attributes(node: ResourceRef): Promise<Readonly<Record<string, unknown>> | null>;
}

/** An adapter's `scopeAttributes` for a type: its attribute columns of the node row, or null when there is no row. */
export type AdapterLayer = (node: ResourceRef) => Promise<Readonly<Record<string, unknown>> | null>;

/**
 * The engine's attributes of a node (`authorizer.loadAttributes`), with the store's rows read back from the
 * database. A node whose id is '' gets null, as authz-orm's adapter answers for a row it cannot find (the engine
 * then throws). `adapters` give the adapter layer of their types; other types have none.
 */
export function oracle(db: TestDb, schemas: readonly ScopeAttributeSchema[], adapters: Readonly<Record<string, AdapterLayer>> = {}): Oracle {
  const defaults = schemaIndex(schemas);
  const store = new DbScopeAttributeStore({ container: db.container });
  // Read once per node: an oracle serves one state of the table, so build a new one after writing.
  const memo = new Map<string, Promise<Readonly<Record<string, unknown>> | null>>();
  const load = async (node: ResourceRef) => {
    if (node.type !== GLOBAL.type && node.id === '') return null;
    const own = Object.hasOwn(adapters, node.type) ? await adapters[node.type](node) : {};
    return own === null ? null : mergeAttributes([defaults.get(node.type) ?? {}, own, unflattenAttributes(await store.rows(node))]);
  };
  return {
    attributes(node) {
      const key = JSON.stringify([node.type, node.id ?? null]);
      let hit = memo.get(key);
      if (!hit) memo.set(key, (hit = load(node)));
      return hit;
    },
  };
}

export type CoreTruth = true | false | 'unknown' | 'throw';

const compiler = new DefaultConditionCompiler();

function context(path: RbacScopePath, row: Row, o: Oracle): EvaluationContext {
  const ancestors = adapterAncestors(path, row);
  return { domain: 'root', now: NOW, ancestors: async () => ancestors, attributes: (ref: ResourceRef) => o.attributes(ref) } as unknown as EvaluationContext;
}

const requestFor = (path: RbacScopePath, row: Row): DecisionRequest => ({ principal: PRINCIPAL, permission: 'file:read', resource: { type: path.type, id: String(row[path.idColumn]) } });

function truthOf(f: ResourceFilter): CoreTruth {
  if (f.op === 'true') return true;
  if (f.op === 'false') return false;
  if (f.op === 'cmp' && f.field === (CONDITION_UNKNOWN as { field: string }).field) return 'unknown';
  throw new Error(`the core left a residual on the row: ${JSON.stringify(f)}`);
}

/** The core's answer for a rule's `when` on a row: the compiled filter's constant, 'unknown', or 'throw' (B39). */
export async function coreWhen(when: Condition, path: RbacScopePath, row: Row, o: Oracle): Promise<CoreTruth> {
  try {
    return truthOf((await compiler.compile(when, requestFor(path, row), context(path, row, o))).filter);
  } catch {
    return 'throw';
  }
}

/** The core's answer for a rule's `resource` on a row: the residual cmp evaluated against the row; the adapter reads each field from its column. */
export async function coreResource(resource: Condition, path: RbacScopePath, row: Row, fields: readonly RbacResourceField[], o: Oracle): Promise<CoreTruth> {
  const ctx = context(path, row, o);
  let filter: ResourceFilter;
  try {
    filter = (await compiler.compile(resource, requestFor(path, row), ctx)).filter;
  } catch {
    return 'throw';
  }
  const env = {
    principal: PRINCIPAL,
    ref: requestFor(path, row).resource,
    attribute: (subject: unknown, field: string) => {
      const f = fields.find((x) => x.field === field);
      return f === undefined ? undefined : (subject as Row)[f.column];
    },
    relation: () => undefined,
    ancestors: async () => null,
    native: () => undefined,
    ctx,
  };
  const v = await evaluateResidual(filter, row, env);
  return v === undefined ? 'unknown' : v;
}

/** Whether authz's built attributes.js (the oracle's merge) is at least as new as its source. */
export function builtEngineIsFresh(): { fresh: boolean; built: Date; source: Date } {
  const built = statSync(new URL('../../../authz/lib/mjs/engine/attributes.js', import.meta.url)).mtime;
  const source = statSync(new URL('../../../authz/src/engine/attributes.ts', import.meta.url)).mtime;
  return { fresh: built.getTime() >= source.getTime(), built, source };
}
