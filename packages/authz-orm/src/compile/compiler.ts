import { AuthzConfigError, GLOBAL, SYSTEM, authzStorage } from '@spinajs/authz';
import type { Principal, ResourceFilter } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { IdentifierQuoter, SelectQueryBuilder, WhereBuilder, WhereQueryStatement, extractModelDescriptor } from '@spinajs/orm';
import type { IQueryStatement, IQueryStatementResult, IWhereBuilder, OrmDriver } from '@spinajs/orm';

import type { OrmNativeCompiler, OrmScopePolicy } from '../api.js';
import { nativeCompilers } from '../adapter.js';
import { columnsOf, idMode, numericString } from '../columns.js';
import type { ColumnInfo, IdMode } from '../columns.js';
import { classesOf, entryOf, scopePolicyOf } from '../registry.js';
import type { ModelClass, ResourceEntry } from '../registry.js';
import { pkOf } from '../rows.js';
import { AuthzStatement } from '../shield.js';
import { caseWhen, dialectFor } from './dialect.js';
import { NativeWhereBuilder, assertNoLazy } from './native.js';
import { assertSynchronous } from './sync.js';
import type { SqlDialect } from './dialect.js';
import { globTokens, isLiteral, likeTokens, wildcardTokens } from './patterns.js';
import { FALSE, TRUE, UNKNOWN, col, join, num, raw, render, subRef, sql } from './sql.js';
import type { Sql } from './sql.js';

export type QueryOp = 'read' | 'update' | 'delete';

export interface ResidualContext {
  /** The model of the builder the residual goes into. */
  readonly model: ModelClass;
  /** The delegation principal (`relationPrincipal`): `relation` and `native:*` compile for it. */
  readonly principal: Principal;
  /** The query's op; an `@OrmScope` policy scopes for it. */
  readonly op: QueryOp;
  /** Defaults to the model's registry entry. */
  readonly entry?: ResourceEntry;
  /** Defaults to the model's driver. */
  readonly driver?: OrmDriver;
  /** 'join': the target is a populated relation's query and the residual goes into its JOIN ON. */
  readonly placement?: 'where' | 'join';
}

// The evaluator's depth cap. Its work budget is not mirrored; the node cap only stops a residual
// whose shared subtrees would expand into an unbounded amount of SQL.
const MAX_DEPTH = 256;
const MAX_NODES = 125_000;

const KNOWN_CMP = new Set(['eq', 'ne', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'like', 'glob', 'wildcard', 'null', 'notnull']);
const OPERATOR: Readonly<Record<string, string>> = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
// The comparison of two equal values.
const ON_EQUAL: Readonly<Record<string, boolean>> = { eq: true, ne: false, lt: false, lte: true, gt: false, gte: true };

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/** The evaluator's literal list: every element a string or a finite number (holes fail). */
function literalList(v: unknown): (string | number)[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: (string | number)[] = [];
  for (let i = 0; i < v.length; i++) {
    const item: unknown = v[i];
    if (typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item))) return undefined;
    out.push(item);
  }
  return out;
}

/** The evaluator's copyRef: a string type, and a string id or none (null counts as none). */
function copyRef(r: unknown): { type: string; id: string | undefined } | undefined {
  if (!isObject(r) || typeof r.type !== 'string') return undefined;
  if (r.id === undefined || r.id === null) return { type: r.type, id: undefined };
  return typeof r.id === 'string' ? { type: r.type, id: r.id } : undefined;
}

const or = (parts: readonly Sql[]): Sql => (parts.length === 0 ? FALSE : parts.length === 1 ? parts[0] : sql`(${join(parts, ' OR ')})`);

const malformed = (what: string): AuthzConfigError => new AuthzConfigError(`authz-orm: malformed residual: ${what}`);

// Sub-builders run their callbacks as SYSTEM: the in-memory default `holds` runs the policy as
// SYSTEM, and the authz query middleware must neither scope the queries a policy or native compiler
// builds nor recurse into this compilation.
function asSystem<T>(fn: () => T): T {
  const storage = authzStorage();
  const { AuthzDecision: _decision, Unscoped: _unscoped, ...rest } = storage.getStore() ?? {};
  return storage.run({ ...rest, Principal: SYSTEM, AuthzCache: new Map() }, fn);
}

type Sub = { readonly kind: 'native'; readonly builder: WhereBuilder<unknown> } | { readonly kind: 'scope'; readonly inner: SelectQueryBuilder; readonly alias: string };

interface Compiled {
  readonly sql: Sql;
  readonly subs: readonly Sub[];
  readonly table: string;
  readonly database: string | undefined;
  readonly pk: string;
  readonly dialect: SqlDialect;
  readonly container: IContainer;
  readonly quoter: IdentifierQuoter;
}

/**
 * The compiled residual as one where statement, parenthesised as a whole. Columns are qualified
 * with the builder's alias (or its table) when the statement builds, so an alias that `populate()`,
 * a join or `setAlias()` assigns later is the one used.
 */
export class ResidualStatement extends AuthzStatement {
  constructor(readonly target: IWhereBuilder<unknown>, private readonly compiled: Compiled) {
    super();
  }

  public build(): IQueryStatementResult {
    const c = this.compiled;
    const quote = (name: string): string => c.quoter.quote(name);
    const t = this.target as unknown as { TableAlias?: string; Table?: string };
    const outer = quote(t.TableAlias || t.Table || c.table);
    const out = render(c.sql, {
      column: (name) => `${outer}.${quote(name)}`,
      sub: (index, bindings) => {
        const s = c.subs[index];
        if (s.kind === 'native') return whereOf(c.container, s.builder, bindings) ?? '(1 = 1)';
        const alias = quote(s.alias);
        const scope = whereOf(c.container, s.inner, bindings);
        const pk = quote(c.pk);
        return `EXISTS (SELECT 1 FROM ${c.dialect.table(quote, c.table, c.database)} AS ${alias} WHERE ${alias}.${pk} = ${outer}.${pk}${scope ? ` AND ${scope}` : ''})`;
      },
    });
    return { Statements: [`(${out.sql})`], Bindings: out.bindings };
  }

  public clone<T>(parent?: T): IQueryStatement {
    const target = (parent ?? this.target) as unknown as IWhereBuilder<unknown>;
    const subs = this.compiled.subs.map((s): Sub => (s.kind === 'native' ? { kind: 'native', builder: s.builder.clone(target) as WhereBuilder<unknown> } : { kind: 'scope', inner: s.inner.clone(), alias: s.alias }));
    return this.derived(new ResidualStatement(target, { ...this.compiled, subs }));
  }
}

/** A sub-builder's where clause through the driver's own compiler, `undefined` when it has none. */
function whereOf(container: IContainer, builder: IWhereBuilder<unknown>, bindings: unknown[]): string | undefined {
  const r = container.resolve<WhereQueryStatement>(WhereQueryStatement as never, [builder]).build();
  const text = r.Statements.join(' AND ');
  if (text === '') return undefined;
  bindings.push(...r.Bindings);
  return text;
}

/**
 * Adds `filter` to `target` as one parenthesised condition (conventions §5): in the WHERE, or with
 * `placement: 'join'` in the JOIN ON of the populated relation whose query `target` is.
 */
export function compileResidual(filter: ResourceFilter, target: IWhereBuilder<unknown>, ctx: ResidualContext): ResidualStatement {
  const statement = buildResidual(filter, target, ctx);
  if (ctx.placement === 'join') {
    target.whereOnJoin(function (this: IWhereBuilder<unknown>) {
      this.Statements.push(statement);
    });
  } else target.Statements.push(statement);
  return statement;
}

/** The compiled residual as a statement of `target`, not added to it (`placement` is ignored). */
export function buildResidual(filter: ResourceFilter, target: IWhereBuilder<unknown>, ctx: ResidualContext): ResidualStatement {
  return new ResidualStatement(target, new Compiler(target, ctx).compile(filter));
}

type Field = { readonly kind: 'column'; readonly info: ColumnInfo; readonly ref: Sql } | { readonly kind: 'none' } | { readonly kind: 'unknown' };

class Compiler {
  private readonly model: ModelClass;
  private readonly entry: ResourceEntry;
  private readonly driver: OrmDriver;
  private readonly dialect: SqlDialect;
  private readonly columns: ReadonlyMap<string, ColumnInfo>;
  private readonly pk: ColumnInfo;
  private readonly table: string;
  private readonly subs: Sub[] = [];
  private natives?: ReadonlyMap<string, OrmNativeCompiler>;
  private visited = 0;

  constructor(private readonly target: IWhereBuilder<unknown>, private readonly ctx: ResidualContext) {
    this.model = ctx.model;
    const descriptor = extractModelDescriptor(ctx.model as never);
    this.driver = ctx.driver ?? (descriptor?.Driver as OrmDriver);
    this.dialect = dialectFor(this.driver);
    if (ctx.driver !== undefined && descriptor?.Driver !== undefined && dialectFor(descriptor.Driver).name !== this.dialect.name) throw new AuthzConfigError(`authz-orm: ${(ctx.model as { name?: string })?.name} lives on a ${dialectFor(descriptor.Driver).name} connection, not ${this.dialect.name}`);
    const entry = ctx.entry ?? entryOf(ctx.model);
    if (!entry || !descriptor) throw new AuthzConfigError(`authz-orm: ${(ctx.model as { name?: string })?.name} is not an @AccessResource model`);
    this.entry = entry;
    this.table = descriptor.TableName;
    this.columns = columnsOf(ctx.model);
    const pk = this.columns.get(pkOf(ctx.model));
    if (!pk) throw new AuthzConfigError(`authz-orm: the primary key of ${ctx.model.name} is not a column of its table`);
    this.pk = pk;
  }

  compile(filter: ResourceFilter): Compiled {
    const out = this.node(filter, 1);
    return {
      sql: out,
      subs: this.subs,
      table: this.table,
      database: (this.driver.Options as { Database?: string } | undefined)?.Database,
      pk: this.pk.name,
      dialect: this.dialect,
      container: this.driver.Container,
      quoter: this.driver.Container.resolve<IdentifierQuoter>(IdentifierQuoter as never),
    };
  }

  private visit(): void {
    if (++this.visited > MAX_NODES) throw new AuthzConfigError(`authz-orm: a residual of more than ${MAX_NODES} nodes is not compiled`);
  }

  // A junction nested in one of the same op joins its parent's list (associative in Kleene logic),
  // each argument still compiled at its own depth.
  private junction(op: 'and' | 'or', f: Record<string, unknown>, depth: number, parts: Sql[]): void {
    if (!Array.isArray(f.args)) throw malformed(`${op} without args`);
    const args: unknown[] = f.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (isObject(arg) && arg.op === op && depth + 1 <= MAX_DEPTH) {
        this.visit();
        this.junction(op, arg, depth + 1, parts);
      } else parts.push(this.node(arg, depth + 1));
    }
  }

  private node(f: unknown, depth: number): Sql {
    if (depth > MAX_DEPTH) return UNKNOWN;
    this.visit();
    if (!isObject(f) || typeof f.op !== 'string') throw malformed('a node is not a filter');
    const op = f.op;
    switch (op) {
      case 'true':
        return TRUE;
      case 'false':
        return FALSE;
      case 'and':
      case 'or': {
        const parts: Sql[] = [];
        this.junction(op, f, depth, parts);
        if (parts.length === 0) return op === 'and' ? TRUE : FALSE;
        return parts.length === 1 ? parts[0] : sql`(${join(parts, op === 'and' ? ' AND ' : ' OR ')})`;
      }
      case 'not': {
        // NOT NOT x is x in Kleene logic; folding chains keeps the SQL within SQLite's parser stack.
        let negated = true;
        let arg: unknown = f.arg;
        let at = depth + 1;
        while (isObject(arg) && arg.op === 'not' && at <= MAX_DEPTH) {
          this.visit();
          negated = !negated;
          arg = arg.arg;
          at++;
        }
        const inner = this.node(arg, at);
        return negated ? sql`(NOT ${inner})` : inner;
      }
      case 'cmp':
        return this.comparison(f);
      case 'relation':
        return this.relation(f.relation);
      case 'under':
        return this.under(f.scopes);
      default:
        if (op.startsWith('native:')) return this.native(op as `native:${string}`, f.args);
        throw new AuthzConfigError(`authz-orm: unknown filter op ${JSON.stringify(op)}`);
    }
  }

  // ---- cmp ----

  private field(name: string): Field {
    const info = this.columns.get(name);
    if (!info) return { kind: 'none' };
    // Not a column of the table: nothing to read in SQL, and the hydrated value is not the DB's.
    if (info.descriptor.Virtual || info.descriptor.Aggregate) return { kind: 'unknown' };
    return { kind: 'column', info, ref: col(info.name) };
  }

  private comparison(f: Record<string, unknown>): Sql {
    const { field: name, cmp, value } = f;
    if (typeof name !== 'string') throw malformed('cmp without a field name');
    if (typeof cmp !== 'string' || !KNOWN_CMP.has(cmp)) throw new AuthzConfigError(`authz-orm: unknown cmp operator ${JSON.stringify(cmp)}`);

    if (cmp === 'in' || cmp === 'nin') {
      const list = literalList(value);
      if (list === undefined) return UNKNOWN;
      if (list.length === 0) return cmp === 'in' ? FALSE : TRUE;
      const found = this.inList(this.field(name), list);
      return cmp === 'in' ? found : sql`(NOT ${found})`;
    }

    const field = this.field(name);
    if (cmp === 'null' || cmp === 'notnull') return this.nullTest(field, cmp === 'null');
    if (field.kind !== 'column') return UNKNOWN;
    if (cmp === 'like' || cmp === 'glob' || cmp === 'wildcard') return this.pattern(field, cmp, value);
    if (!isScalar(value)) return UNKNOWN;
    return this.compare(field.info, field.ref, cmp, value);
  }

  private nullTest(field: Field, isNull: boolean): Sql {
    if (field.kind === 'none') return isNull ? TRUE : FALSE;
    if (field.kind === 'unknown') return UNKNOWN;
    switch (field.info.kind) {
      case 'boolean':
      case 'converted':
        // The hydrated value is never null.
        return isNull ? FALSE : TRUE;
      default:
        return isNull ? sql`(${field.ref} IS NULL)` : sql`(${field.ref} IS NOT NULL)`;
    }
  }

  private pattern(field: { info: ColumnInfo; ref: Sql }, cmp: string, value: unknown): Sql {
    if (field.info.kind !== 'string' || typeof value !== 'string') return UNKNOWN;
    const tokens = cmp === 'like' ? likeTokens(value) : cmp === 'glob' ? globTokens(value) : wildcardTokens(value);
    if (tokens === undefined) return UNKNOWN;
    const d = this.dialect;
    // A literal no row can hold never matches a string row.
    if (tokens.some((t) => isLiteral(t) && !d.canHold(String.fromCodePoint(t)))) return caseWhen(d.isText(field.ref), FALSE);
    return d.match(field.ref, tokens) ?? UNKNOWN;
  }

  private compare(info: ColumnInfo, c: Sql, cmp: string, value: Scalar): Sql {
    const d = this.dialect;
    const op = OPERATOR[cmp];
    const ordering = cmp !== 'eq' && cmp !== 'ne';
    switch (info.kind) {
      case 'string': {
        if (typeof value === 'number') {
          // The evaluator compares the row as a number when it is the canonical string of one, which
          // SQL cannot test: only equality with String(value) is decided, the rest stays UNKNOWN.
          return sql`(CASE WHEN ${c} = ${d.text(String(value))} THEN ${ON_EQUAL[cmp] ? TRUE : FALSE} ELSE NULL END)`;
        }
        if (typeof value !== 'string') return UNKNOWN;
        if (!d.canHold(value)) {
          if (ordering) return UNKNOWN;
          return caseWhen(d.isText(c), cmp === 'eq' ? FALSE : TRUE);
        }
        const expr = sql`(${c} ${raw(op)} ${d.text(value)})`;
        const guard = d.textGuard(c);
        return guard ? caseWhen(guard, expr) : expr;
      }
      case 'number': {
        const n = typeof value === 'number' ? value : typeof value === 'string' ? numericString(value) : undefined;
        if (n !== undefined) return caseWhen(d.isNumber(c), sql`(${c} ${raw(op)} ${d.number(n)})`);
        if (typeof value === 'boolean' && !ordering) return sql`(CASE WHEN ${c} IN (0, 1) THEN (${c} ${raw(op)} ${num(value ? 1 : 0)}) ELSE NULL END)`;
        return UNKNOWN;
      }
      case 'boolean': {
        if (ordering) return UNKNOWN;
        const b = typeof value === 'boolean' ? value : value === 0 || value === 1 ? value === 1 : undefined;
        const v = d.boolean(c, info);
        if (b === undefined || v === undefined) return UNKNOWN;
        return (cmp === 'eq') === b ? v : sql`(NOT ${v})`;
      }
      default:
        return UNKNOWN;
    }
  }

  /** The OR of the item equalities, grouped by the coerced kind of the item. */
  private inList(field: Field, list: readonly (string | number)[]): Sql {
    if (field.kind !== 'column') return UNKNOWN;
    const { info, ref: c } = field;
    const d = this.dialect;
    const parts: Sql[] = [];
    switch (info.kind) {
      case 'string': {
        const strings = list.filter((x): x is string => typeof x === 'string');
        const held = strings.filter((s) => d.canHold(s));
        const numbers = list.filter((x): x is number => typeof x === 'number');
        if (held.length > 0) {
          const expr = sql`(${d.binary(c)} IN (${join(
            held.map((s) => d.textValue(s)),
            ', ',
          )}))`;
          const guard = d.textGuard(c);
          parts.push(guard ? caseWhen(guard, expr) : expr);
        } else if (strings.length > 0) parts.push(caseWhen(d.isText(c), FALSE));
        if (numbers.length > 0)
          parts.push(
            sql`(CASE WHEN ${d.binary(c)} IN (${join(
              numbers.map((n) => d.textValue(String(n))),
              ', ',
            )}) THEN ${TRUE} ELSE NULL END)`,
          );
        break;
      }
      case 'number': {
        const numbers: number[] = [];
        let unknown = false;
        for (const x of list) {
          const n = typeof x === 'number' ? x : numericString(x);
          if (n === undefined) unknown = true;
          else numbers.push(n);
        }
        if (numbers.length > 0)
          parts.push(
            caseWhen(
              d.isNumber(c),
              sql`(${c} IN (${join(
                numbers.map((n) => d.number(n)),
                ', ',
              )}))`,
            ),
          );
        if (unknown) parts.push(UNKNOWN);
        break;
      }
      case 'boolean': {
        const v = d.boolean(c, info);
        if (v === undefined) return UNKNOWN;
        if (list.includes(1)) parts.push(v);
        if (list.includes(0)) parts.push(sql`(NOT ${v})`);
        if (list.some((x) => x !== 0 && x !== 1)) parts.push(UNKNOWN);
        break;
      }
      default:
        return UNKNOWN;
    }
    return or(parts);
  }

  // ---- relation, under, native ----

  private relation(name: unknown): Sql {
    if (typeof name !== 'string') throw malformed('relation without a name');
    if (name === 'owner' && this.entry.owner !== undefined) return this.owner(this.entry.owner);
    const policy = scopePolicyOf(this.model, name);
    if (policy !== undefined) return this.scope(policy);
    // The type has the relation through another class: its resolver answers false for this one's rows.
    const known = classesOf(this.entry.type).some((c) => (name === 'owner' && entryOf(c)?.owner !== undefined) || scopePolicyOf(c, name) !== undefined);
    if (known) return FALSE;
    throw new AuthzConfigError(`authz-orm: relation '${name}' of type '${this.entry.type}' has no SQL form; ${this.model.name} needs @Owner() or an @OrmScope(${this.model.name}, '${name}') policy`);
  }

  private get pkMode(): IdMode {
    return idMode(this.pk, this.dialect.name);
  }

  // The resolvers take the row as the subject only when its key is an id (`rowFor`); else they load
  // the row by ref, which for such a key finds nothing.
  private keyed(expr: Sql): Sql {
    return sql`(${this.dialect.hasId(col(this.pk.name), this.pk, this.pkMode)} AND ${expr})`;
  }

  private owner(property: string): Sql {
    const info = this.columns.get(property);
    if (!info) throw new AuthzConfigError(`authz-orm: @Owner() of ${this.model.name} is on '${property}', which is not a column of its table`);
    const p = this.ctx.principal;
    if (p?.type !== 'user' || typeof p.id !== 'string') return FALSE;
    return this.keyed(this.dialect.idEq(col(info.name), info, idMode(info, this.dialect.name), p.id));
  }

  private scope(policyClass: ModelClass): Sql {
    const policy = resolvePolicy(policyClass);
    const { model, driver, ctx } = this;
    const alias = `$authz_s${this.subs.length + 1}$`;
    const descriptor = extractModelDescriptor(model as never)!;
    const inner = asSystem(() => {
      const q = driver.Container.resolve<SelectQueryBuilder>(SelectQueryBuilder as never, [driver, model, undefined, false]);
      q.setTable(this.table, alias);
      // The in-memory default holds selects through the model's query, which carries these.
      const has = (c: string | undefined): c is string => c !== undefined && this.columns.has(c);
      if (has(descriptor.SoftDelete?.DeletedAt)) q.whereNull(descriptor.SoftDelete.DeletedAt);
      if (has(descriptor.Archived?.ArchivedAt)) q.whereNull(descriptor.Archived.ArchivedAt);
      q.where(function (this: IWhereBuilder<unknown>) {
        assertSynchronous(policy.scope(this as IWhereBuilder<never>, ctx.principal, ctx.op), `the @OrmScope policy ${policy.constructor.name}.scope`);
      });
      return q;
    });
    this.subs.push({ kind: 'scope', inner, alias });
    return this.keyed(subRef(this.subs.length - 1));
  }

  private under(list: unknown): Sql {
    if (!Array.isArray(list)) return UNKNOWN;
    const scopes: { type: string; id: string | undefined }[] = [];
    for (let i = 0; i < list.length; i++) {
      const ref = copyRef(list[i]);
      if (ref === undefined) return UNKNOWN;
      scopes.push(ref);
    }
    if (scopes.length === 0) return FALSE;
    // Without a row findRow finds, the adapter has no ancestors and the evaluator answers UNKNOWN.
    const findable = this.dialect.findable(col(this.pk.name), this.pk, this.pkMode);
    if (findable === undefined) return UNKNOWN;
    return caseWhen(findable, or(scopes.map((s) => this.scopeRef(s.type, s.id))));
  }

  /** Whether the row's ancestors (`OrmResourceAdapter.ancestors`) contain the scope. */
  private scopeRef(type: string, id: string | undefined): Sql {
    const d = this.dialect;
    if (id === undefined && (type === GLOBAL.type || type === this.entry.type)) return TRUE;
    const parts: Sql[] = [];
    if (id !== undefined && type === this.entry.type) parts.push(d.idEq(col(this.pk.name), this.pk, this.pkMode, id));
    for (const s of this.entry.scopeColumns) {
      if (s.scopeType !== type) continue;
      const info = this.columns.get(s.column);
      if (!info) continue;
      const mode = idMode(info, d.name);
      parts.push(id === undefined ? d.hasId(col(info.name), info, mode) : d.idEq(col(info.name), info, mode, id));
    }
    return or(parts);
  }

  private native(op: `native:${string}`, args: unknown): Sql {
    this.natives ??= nativeCompilers();
    const compiler = this.natives.get(op);
    if (compiler === undefined) throw new AuthzConfigError(`authz-orm: no OrmNativeCompiler is registered for ${op}`);
    const builder = new NativeWhereBuilder(this.target as unknown as WhereBuilder<unknown>, { op, model: this.model, driver: this.driver, table: this.table });
    asSystem(() => assertSynchronous(compiler.compile(args, builder, this.model as never, this.ctx.principal), `the OrmNativeCompiler for ${op}`));
    assertNoLazy(builder, op);
    this.subs.push({ kind: 'native', builder });
    return subRef(this.subs.length - 1);
  }
}

function resolvePolicy(cls: ModelClass): OrmScopePolicy {
  const policy = DI.resolve(cls as never) as unknown;
  if (policy !== null && typeof policy === 'object' && typeof (policy as { then?: unknown }).then === 'function') {
    (policy as Promise<unknown>).then(undefined, () => undefined);
    throw new AuthzConfigError(`authz-orm: the @OrmScope policy ${cls.name} resolves asynchronously; residuals compile synchronously, so it cannot be an AsyncService`);
  }
  return policy as OrmScopePolicy;
}
