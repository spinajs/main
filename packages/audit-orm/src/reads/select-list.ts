import { DI } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { ColumnMethodStatement, ColumnStatement, JoinStatement, Orm, extractModelDescriptor } from '@spinajs/orm';
import type { IModelDescriptor, ModelBase, OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

/** sqlite and MySQL resolve identifiers case-insensitively, so every comparison of a column name is. */
export const lc = (name: string): string => name.toLowerCase();

/** One table whose values a select may return: the queried one, or one a populate or a join brought in. */
export interface ReadSource {
  readonly descriptor: IModelDescriptor;
  /** The models whose rules apply: every model of this table on the query's connection. */
  readonly models: readonly Constructor<ModelBase>[];
  /** The queried table itself. */
  readonly own: boolean;
  /** Row key of each returned column, by lower-cased column name. */
  readonly keys: Map<string, string>;
  /** Lower-cased columns read inside an aggregate: their values reach the caller, but not as rows of the model. */
  readonly computed: Set<string>;
  /** `*`: every column of the table, under its own name. */
  all: boolean;
  /** An expression the builder cannot read (raw, condition): it may reach any column of the table. */
  opaque: boolean;
}

function descriptorsOn(driver: OrmDriver): { type: Constructor<ModelBase>; descriptor: IModelDescriptor }[] {
  const found: { type: Constructor<ModelBase>; descriptor: IModelDescriptor }[] = [];
  for (const { type } of DI.get(Orm)?.Models ?? []) {
    const descriptor = extractModelDescriptor(type);
    if (descriptor && descriptor.Driver === driver) found.push({ type, descriptor });
  }

  return found;
}

class SelectList {
  public readonly sources = new Map<string, ReadSource>();
  private readonly models: { type: Constructor<ModelBase>; descriptor: IModelDescriptor }[];
  /** The table each join of the query is read under, by its alias; a raw join names none. */
  private readonly joins = new Map<string, IModelDescriptor>();
  private readonly joined: boolean;
  /** A raw join, or one of a table no model maps: the tables of the query are not all known. */
  private unnamedJoin = false;

  constructor(private readonly query: SelectQueryBuilder<unknown>, private readonly root: IModelDescriptor) {
    this.models = descriptorsOn(query.Driver);
    this.joined = query.JoinStatements.length > 0;
    for (const statement of query.JoinStatements) {
      if (!(statement instanceof JoinStatement)) continue;
      const { table, alias, model } = statement.Joined;
      const descriptor = (model ? extractModelDescriptor(model) : null) ?? this.models.find((m) => lc(m.descriptor.TableName) === lc(table ?? ''))?.descriptor;
      if (alias !== undefined && descriptor) {
        this.joins.set(alias, descriptor);
      } else {
        this.unnamedJoin = true;
      }
    }
  }

  /** The queried table; on a many-to-many junction select it is the junction, not the model the query carries. */
  public own(): ReadSource {
    const table = this.query.Table;
    const models = this.modelsOf(table);
    const model = this.query.Model;
    const isRoot = lc(table) === lc(this.root.TableName);
    if (model && isRoot && !models.includes(model)) models.push(model);
    const descriptor = isRoot ? this.root : this.models.find((m) => lc(m.descriptor.TableName) === lc(table))?.descriptor ?? this.root;
    return this.at('', descriptor, models, true);
  }

  /**
   * The sources a column reads, found by its statement's table alias among the query's own and its joins'. Behind an
   * alias no join names may stand any table of the connection: the column reads every table that has it, `*` all of them.
   */
  public of(tableAlias: string | undefined, column: string): ReadSource[] {
    if (!tableAlias || tableAlias === this.query.TableAlias) return [this.own()];

    const joined = this.joins.get(tableAlias);
    if (joined) return [this.joinedSource(tableAlias, joined)];

    const wildcard = column.trim() === '*';
    return this.models.filter((m) => wildcard || m.descriptor.Columns.some((c) => lc(c.Name) === lc(column))).map((m) => this.table(m.descriptor));
  }

  /**
   * The sources an aggregate reads. Its SQL names no table, so with a join the database finds the column in whichever
   * table of the query has it.
   */
  public aggregated(tableAlias: string | undefined, column: string): ReadSource[] {
    if (!this.joined) return this.of(tableAlias, column);

    const has = (descriptor: IModelDescriptor): boolean => descriptor.Columns.some((c) => lc(c.Name) === lc(column));
    const known = this.queryTables().filter((source) => has(source.descriptor));
    return this.unnamedJoin ? [...known, ...this.of('?', column)] : known;
  }

  /** The queried table and every joined one. */
  public queryTables(): ReadSource[] {
    return [this.own(), ...[...this.joins].map(([alias, descriptor]) => this.joinedSource(alias, descriptor))];
  }

  private joinedSource(alias: string, descriptor: IModelDescriptor): ReadSource {
    return this.at(alias, descriptor, this.modelsOf(descriptor.TableName), false);
  }

  private modelsOf(table: string): Constructor<ModelBase>[] {
    return this.models.filter((m) => lc(m.descriptor.TableName) === lc(table)).map((m) => m.type);
  }

  private table(descriptor: IModelDescriptor): ReadSource {
    return this.at(`?${lc(descriptor.TableName)}`, descriptor, this.modelsOf(descriptor.TableName), false);
  }

  private at(key: string, descriptor: IModelDescriptor, models: readonly Constructor<ModelBase>[], own: boolean): ReadSource {
    const known = this.sources.get(key);
    if (known) return known;

    const created: ReadSource = { descriptor, models, own, keys: new Map<string, string>(), computed: new Set<string>(), all: false, opaque: false };
    this.sources.set(key, created);
    return created;
  }
}

function addColumn(list: SelectList, statement: ColumnStatement, column: string): void {
  // `count(*)` reads no column.
  if (statement instanceof ColumnMethodStatement && column.trim() === '*') return;

  const sources = statement instanceof ColumnMethodStatement ? list.aggregated(statement.TableAlias, column) : list.of(statement.TableAlias, column);
  for (const source of sources) {
    if (statement instanceof ColumnMethodStatement) {
      source.computed.add(lc(column));
    } else if (statement.IsWildcard) {
      source.all = true;
    } else {
      source.keys.set(lc(column), statement.Alias === '' ? column : statement.Alias);
    }
  }
}

/**
 * The tables a select returns values of, each with the columns it returns. A column belongs to the table its statement's
 * table alias names: the queried table or a join of the query (a populated relation is one). An expression the builder
 * cannot read counts for every table of the query.
 */
export function selectListOf(query: SelectQueryBuilder<unknown>, root: IModelDescriptor): ReadSource[] {
  const list = new SelectList(query, root);
  const statements = query.getColumns();
  let opaque = false;

  for (const statement of statements) {
    const column = statement instanceof ColumnStatement ? statement.Column : undefined;
    if (statement instanceof ColumnStatement && typeof column === 'string') {
      addColumn(list, statement, column);
    } else {
      opaque = true;
    }
  }

  if (statements.length === 0) list.own().all = true;
  if (opaque) {
    for (const source of list.queryTables()) source.opaque = true;
  }

  return [...list.sources.values()];
}
