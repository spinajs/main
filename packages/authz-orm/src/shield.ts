import { QueryStatement, WhereBoolean, WhereQueryStatement } from '@spinajs/orm';
import type { IQueryStatement, IQueryStatementResult, OrmDriver } from '@spinajs/orm';

/** A where statement the authz middleware puts on a builder: the shield keeps it outside the caller's where. */
export abstract class AuthzStatement extends QueryStatement {
  /** The statement this one was cloned from, transitively: a cloned query still carries the same residual. */
  origin: AuthzStatement = this;

  /** The builder whose table (or alias) the statement reads; a residual merged into a parent keeps its relation query. */
  abstract readonly target: unknown;

  protected derived<T extends AuthzStatement>(copy: T): T {
    copy.origin = this.origin;
    copy.OnJoin = this.OnJoin;
    return copy;
  }
}

/**
 * The residual of a query whose filter is not known yet (deferred, or denied until the type-level
 * check runs). It renders FALSE until `fill`; a builder that never executes keeps FALSE.
 */
export class ResidualSlot extends AuthzStatement {
  // undefined: not resolved (FALSE); empty: TRUE (renders nothing); else the AND of the statements.
  private filled: readonly IQueryStatement[] | undefined;

  constructor(readonly target: unknown) {
    super();
  }

  get resolved(): boolean {
    return this.filled !== undefined;
  }

  fill(statements: readonly IQueryStatement[]): void {
    this.filled = [...statements];
  }

  build(): IQueryStatementResult {
    if (this.filled === undefined) return { Statements: ['(1 = 0)'], Bindings: [] };
    const built = this.filled.map((s) => s.build());
    const parts = built.flatMap((b) => b.Statements);
    if (parts.length === 0) return { Statements: [], Bindings: [] };
    return { Statements: [`(${parts.join(' AND ')})`], Bindings: built.flatMap((b) => b.Bindings) };
  }

  clone<T>(parent?: T): IQueryStatement {
    const slot = this.derived(new ResidualSlot(parent ?? this.target));
    slot.filled = this.filled?.map((s) => s.clone(parent as never));
    return slot;
  }
}

/** The caller's statements as one parenthesised group, compiled by the driver's own where compiler. */
class CallerGroup extends QueryStatement {
  constructor(private readonly container: Resolver, private readonly statements: IQueryStatement[]) {
    super();
  }

  build(): IQueryStatementResult {
    const group = this.container.resolve<WhereQueryStatement>(WhereQueryStatement as never, [{ Statements: this.statements }]);
    return group.build();
  }

  clone(): IQueryStatement {
    return new CallerGroup(this.container, this.statements);
  }
}

interface Resolver {
  resolve<T>(type: never, args: unknown[]): T;
}

interface Shielded {
  readonly Statements: IQueryStatement[];
  readonly Driver: OrmDriver;
  toDB(...args: unknown[]): unknown;
  clearWhere?(...args: unknown[]): unknown;
}

const shielded = new WeakSet<object>();
// Statements the middleware put on a builder: a caller's clearWhere() must not drop them.
const owned = new WeakMap<object, readonly AuthzStatement[]>();

export function own(builder: object, statements: readonly AuthzStatement[]): void {
  owned.set(builder, statements);
}

export function ownedBy(builder: object): readonly AuthzStatement[] {
  return owned.get(builder) ?? [];
}

function getterOf(target: object, name: string): ((this: unknown) => unknown) | undefined {
  for (let p: object | null = Object.getPrototypeOf(target); p !== null; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d?.get) return d.get;
  }
  return undefined;
}

/**
 * The orm joins a builder's where statements without grouping them, so a caller's `orWhere` would
 * reach past the residual. While the builder compiles (`toDB`), its `Statements` read as
 * `[authz statements…, (caller statements), aggregates…]`, giving `(residual) AND (caller's where)`.
 * Outside a compile they are the plain list, so the orm's own bookkeeping (merge, alias, OnJoin)
 * sees what it always did. `clearWhere` keeps every authz statement, including the residuals that
 * populated relations merged in. `check` runs before every compile, also one that no execution hook
 * precedes (a sub-select, `driver.execute(builder)`); a builder without a where (insert) gets only that.
 */
export function shield(builder: object, check: (builder: object) => void): void {
  if (shielded.has(builder)) return;
  shielded.add(builder);
  const b = builder as Shielded;
  const statements = getterOf(builder, 'Statements');
  const toDB = b.toDB;
  const clearWhere = b.clearWhere;
  let compiling = 0;

  Object.defineProperty(builder, 'toDB', {
    configurable: true,
    writable: true,
    value: function (this: Shielded, ...args: unknown[]) {
      check(this);
      compiling++;
      try {
        return toDB.apply(this, args);
      } finally {
        compiling--;
      }
    },
  });
  if (statements === undefined) return;

  Object.defineProperty(builder, 'Statements', {
    configurable: true,
    get(this: Shielded) {
      const raw = statements.call(this) as IQueryStatement[];
      return compiling > 0 ? grouped(this, raw, this.Driver.Container as unknown as Resolver) : raw;
    },
  });
  if (typeof clearWhere === 'function') {
    Object.defineProperty(builder, 'clearWhere', {
      configurable: true,
      writable: true,
      value: function (this: Shielded, ...args: unknown[]) {
        const keep = new Set<IQueryStatement>([...(statements.call(this) as IQueryStatement[]).filter((s) => s instanceof AuthzStatement), ...ownedBy(this)]);
        const out = clearWhere.apply(this, args);
        (statements.call(this) as IQueryStatement[]).push(...keep);
        return out;
      },
    });
  }
}

const groups = new WeakSet<object>();

/**
 * A where group (not a query, so it never compiles on its own) that holds authz statements: they
 * read first, ANDed with the group's other statements as one, whenever the group is read.
 */
export function shieldGroup(group: object): void {
  if (groups.has(group)) return;
  groups.add(group);
  const statements = getterOf(group, 'Statements');
  if (statements === undefined) return;
  Object.defineProperty(group, 'Statements', {
    configurable: true,
    get(this: { readonly Container: Resolver }) {
      return grouped(this, statements.call(this) as IQueryStatement[], this.Container);
    },
  });
}

function grouped(builder: object, raw: IQueryStatement[], container: Resolver): IQueryStatement[] {
  const ours: IQueryStatement[] = ownedBy(builder).filter((s) => !raw.includes(s));
  const callers: IQueryStatement[] = [];
  const aggregates: IQueryStatement[] = [];
  for (const s of raw) {
    if (s instanceof AuthzStatement) ours.push(s);
    else if ((s as { IsAggregate?: boolean }).IsAggregate) aggregates.push(s);
    else callers.push(s);
  }
  if (ours.length === 0) return raw;
  for (const s of ours) s.Boolean = WhereBoolean.AND;
  return [...ours, ...(callers.length > 0 ? [new CallerGroup(container, callers)] : []), ...aggregates];
}

/** `SelectQueryBuilder.clone` rebuilds the where statements without their connectors (`orWhere` became AND); give them back. */
export function keepBooleans(source: object, copy: object): void {
  const from = (source as { _statements?: IQueryStatement[] })._statements ?? [];
  const to = (copy as { _statements?: IQueryStatement[] })._statements ?? [];
  from.forEach((s, i) => {
    if (i < to.length) to[i].Boolean = s.Boolean;
  });
}
