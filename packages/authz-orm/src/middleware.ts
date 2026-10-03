import { AccessDenied, AuthzConfigError, AuthzDomains, DecisionAudit, DefaultAuthzDomains, SYSTEM, UNATTENDED, authz, authzStorage, currentPrincipal } from '@spinajs/authz';
import type { AuthzService, Permission, Principal, ResourceFilter } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable, ResolveType, isFactory } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { CloneTableQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder, JoinStatement, QueryMiddleware, SelectQueryBuilder, TruncateTableQueryBuilder, UpdateQueryBuilder, extractModelDescriptor } from '@spinajs/orm';
import type { IJoinStatementOptions, IQueryStatement, IWhereBuilder, QueryBuilder } from '@spinajs/orm';

import type { OrmScopePolicy } from './api.js';
import { buildResidual, compileResidual } from './compile/compiler.js';
import type { QueryOp, ResidualContext } from './compile/compiler.js';
import { authorizeInsert, relationsOf } from './insert.js';
import { relationPrincipalOf, serviceConfig } from './principal.js';
import { entryOf, registeredClasses, registryVersion, scopePolicyOf } from './registry.js';
import type { ModelClass, QueryKind, ResourceEntry } from './registry.js';
import { AuthzStatement, ResidualSlot, own, ownedBy, shield } from './shield.js';
import { updateKeepsScope } from './update.js';

/** What the middleware decided for a builder at creation. */
export interface QueryScope {
  readonly service: AuthzService;
  readonly model: ModelClass;
  readonly entry: ResourceEntry;
  readonly kind: QueryKind;
  readonly permission: Permission;
  /** The request principal at creation. */
  readonly principal: Principal;
  /** Denied or deferred: the slot `beforeQueryExecution` fills (or throws for). */
  readonly slot?: ResidualSlot;
  /** The residual in the builder, once known. */
  residual?: ResourceFilter;
  /** Insert and update: the execution checks (stamp, authorizeUpdate, scope move) have run; the builder may compile. */
  checked?: boolean;
}

const scopes = new WeakMap<object, QueryScope>();

/** The middleware's record for a builder (task 7 carries it to the builders the orm derives). */
export function scopeOf(builder: object): QueryScope | undefined {
  return scopes.get(builder);
}

const domainName = (): string => {
  const configuration = DI.get(Configuration) as Configuration | undefined;
  const name: unknown = configuration?.get(['authz', 'orm', 'domain']) ?? 'root';
  if (typeof name !== 'string' || name === '') throw new AuthzConfigError(`authz-orm: authz.orm.domain must be a domain name, got ${JSON.stringify(name)}`);
  return name;
};

function kindOf(builder: QueryBuilder): QueryKind {
  if (builder instanceof SelectQueryBuilder) return 'read';
  if (builder instanceof UpdateQueryBuilder) return 'update';
  if (builder instanceof DeleteQueryBuilder) return 'delete';
  if (builder instanceof InsertQueryBuilder) return 'create';
  throw new AuthzConfigError(`authz-orm: a ${builder?.constructor?.name} on ${builder.Model?.name} is neither a select, update, delete nor insert`);
}

const raw = (builder: object): IQueryStatement[] => (builder as unknown as { _statements: IQueryStatement[] })._statements;

const carried = new WeakSet<object>();

/** A clone keeps the shield, the authz statements (as their clones) and the scope. */
function carryOnClone(builder: SelectQueryBuilder): void {
  if (carried.has(builder)) return;
  carried.add(builder);
  const clone = builder.clone;
  Object.defineProperty(builder, 'clone', {
    configurable: true,
    writable: true,
    value: function (this: SelectQueryBuilder, ...args: unknown[]) {
      const copy = (clone as (...a: unknown[]) => SelectQueryBuilder).apply(this, args);
      const source = raw(this);
      const map = <S extends IQueryStatement>(s: S): S => {
        const i = source.indexOf(s);
        return (i >= 0 ? raw(copy)[i] : s.clone(copy as never)) as S;
      };
      own(copy, ownedBy(this).map(map));
      const scope = scopes.get(this);
      if (scope) scopes.set(copy, { ...scope, ...(scope.slot ? { slot: map(scope.slot) } : {}) });
      guard(copy);
      return copy;
    },
  });
}

const isWhereBuilder = (b: unknown): b is SelectQueryBuilder | UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown> => b instanceof SelectQueryBuilder || b instanceof UpdateQueryBuilder || b instanceof DeleteQueryBuilder;

/**
 * Every select, update, delete and insert is shielded, scoped or not: a populated relation merges
 * its residual into the parent's statements, an unscoped parent's `orWhere` must not widen it, and
 * the compile check must run for any of them.
 */
function guard(builder: unknown): void {
  if (!isWhereBuilder(builder) && !(builder instanceof InsertQueryBuilder)) return;
  shield(builder, compileGate);
  if (builder instanceof SelectQueryBuilder) carryOnClone(builder);
  if (builder instanceof InsertQueryBuilder) uncheckOnChange(builder, 'values');
  if (builder instanceof UpdateQueryBuilder) uncheckOnChange(builder, 'update');
}

const watched = new WeakSet<object>();

/** New values after the execution checks ran make the builder unchecked again. */
function uncheckOnChange(builder: object, method: 'values' | 'update'): void {
  if (watched.has(builder)) return;
  watched.add(builder);
  const original = (builder as Record<string, (...a: unknown[]) => unknown>)[method];
  Object.defineProperty(builder, method, {
    configurable: true,
    writable: true,
    value: function (this: object, ...args: unknown[]) {
      const scope = scopes.get(this);
      if (scope) scope.checked = false;
      return original.apply(this, args);
    },
  });
}

const unscopedReason = (): string | undefined => {
  const reason = authzStorage().getStore()?.Unscoped;
  return typeof reason === 'string' && reason !== '' ? reason : undefined;
};

const softDeleteColumn = (model: ModelClass): string | undefined => {
  const column = extractModelDescriptor(model as never)?.SoftDelete?.DeletedAt;
  return column !== undefined && column !== '' ? column : undefined;
};

// The host resolves the audit service once, at boot, and keeps it private: resolve it the same way.
const audits = new WeakMap<AuthzService, Promise<DecisionAudit | undefined>>();

function auditOf(service: AuthzService): Promise<DecisionAudit | undefined> {
  let hit = audits.get(service);
  if (hit === undefined) {
    hit = (async () => {
      const domains: unknown = DI.get(AuthzDomains);
      if (!(domains instanceof DefaultAuthzDomains)) return undefined;
      const container = domains.container(service.domain);
      const name = serviceConfig(service).audit.service;
      if (name === undefined) return container.hasRegistered(DecisionAudit) ? ((await container.resolve(DecisionAudit)) as DecisionAudit) : undefined;
      const entry = container.Registry.getTypesChain(DecisionAudit)
        .filter((e) => !isFactory(e.type) && (e.type as { name?: string }).name === name)
        .pop();
      if (!entry) return undefined;
      const type = entry.type as Class<DecisionAudit>;
      const at = container.extractDescriptor(type).resolver === ResolveType.PerChildContainer ? container : entry.container;
      return (await at.resolve(type)) as DecisionAudit;
    })();
    audits.set(service, hit);
  }
  return hit;
}

function recordUnscoped(service: AuthzService, principal: Principal, reason: string, permission: Permission, entry: ResourceEntry): void {
  if (!serviceConfig(service).audit.unscoped) return;
  const record = { kind: 'unscoped' as const, principal: { type: principal.type, id: principal.id }, reason, permission, resource: { type: entry.type } };
  // As the host does: auditing never fails the query.
  auditOf(service)
    .then((audit) => audit?.record(record))
    .then(undefined, () => undefined);
}

/**
 * Scopes every query on an `@AccessResource` model (design §12.2, conventions §6): selects, updates
 * and deletes get the residual of `filterNow` as `(residual) AND (caller's where)`, a residual that
 * needs IO is resolved before execution, FALSE and UNATTENDED throw `AccessDenied`, inserts are
 * stamped and checked row by row.
 */
@Injectable(QueryMiddleware)
export class AuthzQueryMiddleware extends QueryMiddleware {
  public order = 100;

  afterQueryCreation(builder: QueryBuilder): void {
    guard(builder);
    const model = builder.Model as ModelClass | undefined;
    const entry = entryOf(model);
    if (!entry || !model) return;
    const kind = kindOf(builder);
    const permission = entry.permissions[kind];
    const principal = currentPrincipal();
    const unscoped = unscopedReason();
    if (unscoped !== undefined) {
      recordUnscoped(authz(domainName()), principal, unscoped, permission, entry);
      return;
    }
    if (principal === SYSTEM) return;

    const service = authz(domainName());
    const base: QueryScope = { service, model, entry, kind, permission, principal };
    if (kind === 'create') {
      scopes.set(builder, base);
      return;
    }

    // A soft-delete model's update is a delete when it writes DeletedAt, known only at execution.
    const deferred = principal === UNATTENDED || (kind === 'update' && softDeleteColumn(model) !== undefined);
    const filter = deferred ? undefined : service.filterNow(principal, permission, entry.type);
    if (filter?.op === 'true') {
      scopes.set(builder, { ...base, residual: filter });
      return;
    }
    const placement = entry.relationScope === 'join' && (builder as SelectQueryBuilder).Owner !== undefined ? 'join' : 'where';
    if (filter === undefined || filter.op === 'false') {
      const slot = new ResidualSlot(builder);
      if (placement === 'join')
        (builder as unknown as IWhereBuilder<unknown>).whereOnJoin(function (this: IWhereBuilder<unknown>) {
          this.Statements.push(slot);
        });
      else (builder as unknown as IWhereBuilder<unknown>).Statements.push(slot);
      own(builder, [slot]);
      scopes.set(builder, { ...base, slot });
      return;
    }
    const statement = compileResidual(filter, builder as unknown as IWhereBuilder<unknown>, { ...context(base, builder), placement });
    own(builder, [statement]);
    scopes.set(builder, { ...base, residual: filter });
  }

  async beforeQueryExecution(builder: QueryBuilder): Promise<void> {
    // Builders the orm makes without afterQueryCreation (a many-to-many join query) are shielded here.
    guard(builder);
    const scope = scopes.get(builder);
    await gate(builder, scope);
    if (!scope) return;
    if (scope.kind === 'create') return insert(builder as InsertQueryBuilder, scope);
    if (scope.slot && !scope.slot.resolved) {
      const statements: IQueryStatement[] = [];
      for (const kind of slotKinds(builder, scope)) {
        const residual = await allowedResidual(scope, kind);
        if (kind === scope.kind) scope.residual = residual;
        if (residual.op !== 'true') statements.push(buildResidual(residual, builder as unknown as IWhereBuilder<unknown>, context(scope, builder, kind)));
      }
      scope.slot.fill(statements);
    }
    if (scope.kind === 'update') {
      await authorizeUpdate(builder as UpdateQueryBuilder<unknown>, scope);
      scope.checked = true;
    }
  }
}

/** I5: an update of a soft-delete model that writes DeletedAt (delete or restore) needs delete; other columns need update. */
function slotKinds(builder: QueryBuilder, scope: QueryScope): QueryKind[] {
  const deletedAt = scope.kind === 'update' ? softDeleteColumn(scope.model) : undefined;
  if (deletedAt === undefined) return [scope.kind];
  const written = Object.keys((builder as UpdateQueryBuilder<unknown>).Value ?? {});
  const kinds: QueryKind[] = [];
  if (written.length === 0 || written.some((k) => k !== deletedAt)) kinds.push('update');
  if (written.includes(deletedAt)) kinds.push('delete');
  return kinds;
}

function context(scope: QueryScope, builder: QueryBuilder, kind: QueryKind = scope.kind): ResidualContext {
  return { model: scope.model, principal: relationPrincipalOf(scope.principal, scope.service), op: kind as QueryOp, entry: scope.entry, driver: builder.Driver };
}

/** The type-level decision's residual; a denial (FALSE, H16; unattended) throws `AccessDenied`. */
async function allowedResidual(scope: QueryScope, kind: QueryKind = scope.kind): Promise<ResourceFilter> {
  return decide(scope.service, scope.principal, scope.entry, kind);
}

async function decide(service: AuthzService, principal: Principal, entry: ResourceEntry, kind: QueryKind): Promise<ResourceFilter> {
  const decision = await service.check({ principal, permission: entry.permissions[kind], resource: { type: entry.type } });
  if (!decision.allowed || decision.residual.op === 'false') throw new AccessDenied(decision);
  return decision.residual;
}

// SQLite and MySQL match table names case-insensitively, and a name may come quoted or qualified.
const normal = (table: unknown): string | undefined =>
  typeof table === 'string' && table !== ''
    ? (
        table
          .replace(/["`[\]]/g, '')
          .split('.')
          .pop() ?? ''
      ).toLowerCase()
    : undefined;

const tableOf = (model: unknown): string | undefined => normal(extractModelDescriptor(model as never)?.TableName);

let tableIndex: { version: number; map: Map<string, ModelClass[]> } | undefined;

/** Registered classes by normalised table name, rebuilt when the registry changes. */
function tables(): Map<string, ModelClass[]> {
  if (tableIndex?.version === registryVersion()) return tableIndex.map;
  const map = new Map<string, ModelClass[]>();
  let complete = true;
  for (const cls of registeredClasses()) {
    const table = tableOf(cls);
    if (table === undefined) {
      complete = false;
      continue;
    }
    const list = map.get(table);
    if (list) list.push(cls);
    else map.set(table, [cls]);
  }
  // A class registered before the orm gave it a table is read again next time.
  tableIndex = complete ? { version: registryVersion(), map } : undefined;
  return map;
}

interface RelationLike {
  readonly Alias?: string;
  readonly Descriptor?: { readonly TargetModel?: unknown };
  readonly _relationQuery?: SelectQueryBuilder;
}

const relationQueryOf = (r: unknown): SelectQueryBuilder | undefined => {
  const q = (r as RelationLike | undefined)?._relationQuery;
  return q instanceof SelectQueryBuilder ? q : undefined;
};

/** The relations of a select and of its relation sub-builders, plus the relation that owns it. */
function relationsReached(builder: SelectQueryBuilder): RelationLike[] {
  const out: RelationLike[] = [];
  const visit = (r: unknown): void => {
    if (r === null || typeof r !== 'object' || out.includes(r as RelationLike)) return;
    out.push(r as RelationLike);
    for (const n of relationQueryOf(r)?.Relations ?? []) visit(n);
  };
  for (const r of builder.Relations ?? []) visit(r);
  visit(builder.Owner);
  return out;
}

/** The select's joins, with the joins nested in them. */
function joinsOf(builder: SelectQueryBuilder): IJoinStatementOptions[] {
  const out: IJoinStatementOptions[] = [];
  const visit = (list: readonly IQueryStatement[]): void => {
    for (const j of list) {
      if (!(j instanceof JoinStatement)) continue;
      const options = (j as unknown as { _options: IJoinStatementOptions })._options;
      out.push(options);
      visit((options as { nestedJoins?: IQueryStatement[] }).nestedJoins ?? []);
    }
  };
  visit(builder.JoinStatements ?? []);
  return out;
}

/**
 * A join a populated relation made, whose sub-builder carries the target model's scope, and whose
 * residual (or a clone of it) is still in the query: in its WHERE or in the join's ON.
 */
function relationJoin(builder: SelectQueryBuilder, join: IJoinStatementOptions, table: string, relations: readonly RelationLike[]): boolean {
  const present = new Set([...raw(builder), ...((join as { onStatements?: IQueryStatement[] }).onStatements ?? [])].filter((s): s is AuthzStatement => s instanceof AuthzStatement).map((s) => s.origin));
  return relations.some((r) => {
    const q = relationQueryOf(r);
    const scope = q && scopes.get(q);
    if (!(r.Alias !== undefined && r.Alias === join.joinTableAlias && normal(r.Descriptor?.TargetModel ? extractModelDescriptor(r.Descriptor.TargetModel as never)?.TableName : undefined) === table && scope !== undefined && tableOf(scope.model) === table)) return false;
    return ownedBy(q!).every((s) => present.has(s.origin));
  });
}

/**
 * I2/I3: an executing builder that reaches a scoped model's table without that model's scope (no
 * model, another class of the same name, a join, truncate, a deep clone) fails closed, unless the
 * principal is SYSTEM or the query is unscoped. Truncate and a deep clone pass with delete (read)
 * TRUE on every class of the table.
 */
async function gate(builder: QueryBuilder, scope: QueryScope | undefined): Promise<void> {
  const principal = currentPrincipal();
  if (principal === SYSTEM || unscopedReason() !== undefined) return;
  const index = tables();
  if (index.size === 0) return;
  const service = (): AuthzService => authz(domainName());

  if (builder instanceof TruncateTableQueryBuilder || builder instanceof CloneTableQueryBuilder) {
    const truncate = builder instanceof TruncateTableQueryBuilder;
    if (!truncate && (builder as CloneTableQueryBuilder).Shallow) return;
    const table = truncate ? builder.Table : (builder as CloneTableQueryBuilder).CloneSource;
    for (const cls of index.get(normal(table) ?? '') ?? []) {
      const entry = entryOf(cls)!;
      const kind = truncate ? 'delete' : 'read';
      if ((await decide(service(), principal, entry, kind)).op !== 'true') throw new Forbidden(`authz-orm: ${truncate ? 'truncating' : 'copying'} ${table} needs ${entry.permissions[kind]} on every row`);
    }
    passed.add(builder);
    return;
  }
  if (!isWhereBuilder(builder) && !(builder instanceof InsertQueryBuilder)) return;

  const kind = kindOf(builder);
  const refuse = async (cls: ModelClass, what: string, as: QueryKind): Promise<never> => {
    await decide(service(), principal, entryOf(cls)!, as);
    throw new Forbidden(`authz-orm: ${what} reaches ${tableOf(cls)}, a table of @AccessResource ${cls.name}, without its scope`);
  };
  const table = normal(builder.Table);
  const mine = table === undefined ? undefined : index.get(table);
  if (mine && !(scope !== undefined && tableOf(scope.model) === table)) await refuse(mine[0], `a ${kind} query`, kind);
}

/**
 * The synchronous half of the gate, run before every compile of a shielded builder (also one no
 * execution hook precedes): the builder's table must be its scope's, every join of a scoped table
 * must be a relation's whose residual is still in the query, and an insert must have passed its
 * create check. Joins are checked here because the orm adds a populated relation's join when the
 * query compiles.
 */
function compileGate(builder: object): void {
  const principal = currentPrincipal();
  if (principal === SYSTEM || unscopedReason() !== undefined) return;
  const scope = scopes.get(builder);
  if ((builder instanceof InsertQueryBuilder || builder instanceof UpdateQueryBuilder) && scope !== undefined && !scope.checked) throw new Forbidden(`authz-orm: a ${scope.kind} of ${scope.entry.type} compiled before its execution checks ran`);
  const index = tables();
  if (index.size === 0) return;
  const q = builder as QueryBuilder;
  const table = normal(q.Table);
  const mine = table === undefined ? undefined : index.get(table);
  const refuse = (cls: ModelClass, what: string): never => {
    throw new Forbidden(`authz-orm: ${what} reaches ${tableOf(cls)}, a table of @AccessResource ${cls.name}, without its scope`);
  };
  if (mine && !(scope !== undefined && tableOf(scope.model) === table)) refuse(mine[0], 'a query');
  if (!(builder instanceof SelectQueryBuilder)) return;
  // What SqlSelectQueryCompiler does first; compiling them here puts their joins and residuals in place.
  for (const r of builder.Relations ?? []) r.compile();
  const relations = relationsReached(builder);
  for (const join of joinsOf(builder)) {
    const joined = normal(join.joinModel ? extractModelDescriptor(join.joinModel as never)?.TableName : join.joinTable);
    const classes = joined === undefined ? undefined : index.get(joined);
    if (classes && !relationJoin(builder, join, joined!, relations)) refuse(classes[0], 'a join');
  }
}

/**
 * B20, moving a row out of scope is 403: a relation whose policy guards updates sees the values, and
 * a residual that reads a written column must still hold on the rows with the written values.
 */
async function authorizeUpdate(builder: UpdateQueryBuilder<unknown>, scope: QueryScope): Promise<void> {
  const residual = scope.residual;
  if (residual === undefined || residual.op === 'true') return;
  let principal: Principal | undefined;
  for (const name of relationsOf(residual).keys()) {
    const cls = scopePolicyOf(scope.model, name);
    if (cls === undefined) continue;
    const policy = (await DI.resolve(cls as never)) as OrmScopePolicy;
    if (typeof policy.authorizeUpdate !== 'function') continue;
    principal ??= relationPrincipalOf(scope.principal, scope.service);
    await policy.authorizeUpdate(builder as never, { ...(builder.Value as Record<string, unknown>) }, principal);
  }
  const keeps = await updateKeepsScope(builder, { model: scope.model, entry: scope.entry, principal: principal ?? relationPrincipalOf(scope.principal, scope.service), residual });
  if (!keeps) throw new Forbidden(`authz-orm: the update moves a ${scope.entry.type} row out of ${scope.permission}`);
}

async function insert(builder: InsertQueryBuilder, scope: QueryScope): Promise<void> {
  const residual = await allowedResidual(scope);
  // An upsert or a replace may change or remove a row that exists: it needs those permissions unconditionally.
  if (builder.Update || builder.Replace) {
    for (const kind of builder.Replace ? (['update', 'delete'] as const) : (['update'] as const)) {
      const f = await scope.service.filter(scope.principal, scope.entry.permissions[kind], scope.entry.type);
      if (f.op !== 'true') throw new Forbidden(`authz-orm: an insert that may overwrite ${scope.entry.type} rows needs ${scope.entry.permissions[kind]} on every row`);
    }
  }
  if (residual.op !== 'true') {
    const failed = await authorizeInsert(builder, { model: scope.model, entry: scope.entry, principal: relationPrincipalOf(scope.principal, scope.service), residual });
    if (failed >= 0) throw new Forbidden(`authz-orm: row ${failed} of the insert does not satisfy ${scope.permission}`);
  }
  scope.checked = true;
}

// Truncate and deep-clone builders that `gate` let through.
const passed = new WeakSet<object>();

/** `driver.execute()` compiles without `_run`: a truncate or deep clone of a scoped table must have passed `gate`. */
function tableCommandGate(builder: QueryBuilder): void {
  if (passed.has(builder) || currentPrincipal() === SYSTEM || unscopedReason() !== undefined) return;
  const truncate = builder instanceof TruncateTableQueryBuilder;
  if (!truncate && (builder as CloneTableQueryBuilder).Shallow) return;
  const table = normal(truncate ? builder.Table : (builder as CloneTableQueryBuilder).CloneSource);
  if (table !== undefined && tables().has(table)) throw new Forbidden(`authz-orm: ${truncate ? 'a truncate' : 'a copy'} of ${table} compiled before its authz check ran`);
}

// These builders reach no middleware hook when they are created, so their compile is guarded on the
// prototype; the mark keeps a second load of this module from wrapping twice.
for (const cls of [TruncateTableQueryBuilder, CloneTableQueryBuilder]) {
  const proto = cls.prototype as unknown as { toDB: ((...a: unknown[]) => unknown) & { authzGate?: true } };
  if (proto.toDB.authzGate) continue;
  const toDB = proto.toDB;
  const gated = Object.assign(
    function (this: QueryBuilder, ...args: unknown[]) {
      tableCommandGate(this);
      return toDB.apply(this, args);
    },
    { authzGate: true as const },
  );
  proto.toDB = gated;
}
