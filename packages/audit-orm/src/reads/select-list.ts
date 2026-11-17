import { DI } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { ColumnMethodStatement, ColumnStatement, Orm, extractModelDescriptor } from '@spinajs/orm';
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

function targetOf(descriptor: IModelDescriptor, relation: string): IModelDescriptor | undefined {
  for (const candidate of descriptor.Relations.values()) {
    if (candidate.Name === relation) return extractModelDescriptor(candidate.TargetModel) ?? undefined;
  }

  return undefined;
}

class SelectList {
  public readonly sources = new Map<string, ReadSource>();
  private readonly models: { type: Constructor<ModelBase>; descriptor: IModelDescriptor }[];

  constructor(private readonly query: SelectQueryBuilder<unknown>, private readonly root: IModelDescriptor) {
    this.models = descriptorsOn(query.Driver);
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

  /** The sources a column reads, found by its statement's table alias. A column under an alias that names no model reads every table that has a column of its name. */
  public of(tableAlias: string | undefined, column: string): ReadSource[] {
    if (!tableAlias || tableAlias === this.query.TableAlias) return [this.own()];

    const descriptor = this.joined(tableAlias);
    if (descriptor) return [this.at(tableAlias, descriptor, this.modelsOf(descriptor.TableName), false)];

    return this.models.filter((m) => m.descriptor.Columns.some((c) => lc(c.Name) === lc(column))).map((m) => this.table(m.descriptor));
  }

  /** Every table of the connection: what an expression may read in a query that joins tables the builder does not name. */
  public everyTable(): void {
    for (const { descriptor } of this.models) this.table(descriptor);
  }

  /** A populate path walked through the relation descriptors, else a join's model class or table name. */
  private joined(tableAlias: string): IModelDescriptor | undefined {
    const separator = this.query.Driver.Options.AliasSeparator ?? '';
    const path = (separator === '' ? tableAlias : tableAlias.split(separator).join('')).split('.').filter((part) => part !== '');
    const owner = this.query.Owner;
    let current: IModelDescriptor | undefined = this.root;
    let rest = path;
    // A many-to-many or recursive relation query carries the target model and prefixes its columns with the relation's own alias.
    if (owner && rest[0] === owner.Name && targetOf(this.root, rest[0]) === undefined) {
      current = extractModelDescriptor(owner.Descriptor.TargetModel) ?? undefined;
      rest = rest.slice(1);
    }
    for (const name of rest) {
      current = current ? targetOf(current, name) : undefined;
    }
    if (current || path.length === 0) return current;

    const last = lc(path[path.length - 1]);
    return (this.models.find((m) => lc(m.descriptor.Name) === last) ?? this.models.find((m) => lc(m.descriptor.TableName) === last))?.descriptor;
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

  for (const source of list.of(statement.TableAlias, column)) {
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
 * table alias names: the queried table, a populate path or a joined model. What the builder cannot attribute is read as
 * widely as it could reach: a column under an unknown alias reads every table that has a column of its name, and an
 * expression reads every table of the query, or of the connection when the query has a join.
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
    list.own();
    if (query.JoinStatements.length > 0) list.everyTable();
    for (const source of list.sources.values()) source.opaque = true;
  }

  return [...list.sources.values()];
}
