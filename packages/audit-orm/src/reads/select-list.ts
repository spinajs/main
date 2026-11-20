import type { Constructor } from '@spinajs/di';
import { ColumnMethodStatement, ColumnStatement, extractModelDescriptor } from '@spinajs/orm';
import type { IModelDescriptor, ModelBase, SelectQueryBuilder } from '@spinajs/orm';

/** sqlite and MySQL resolve identifiers case-insensitively, so every comparison of a column name is. */
export const lc = (name: string): string => name.toLowerCase();

/** One table whose values a select may return: the queried one, or one a populate joined in. */
export interface ReadSource {
  readonly descriptor: IModelDescriptor;
  /** The models whose rules apply. */
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

interface Joined {
  readonly model: Constructor<ModelBase>;
  readonly descriptor: IModelDescriptor;
}

function unwrapped(part: string, separator: string): string {
  const wrapped = separator !== '' && part.length > 2 * separator.length && part.startsWith(separator) && part.endsWith(separator);
  return wrapped ? part.slice(separator.length, -separator.length) : part;
}

/** `$Owner$.$Company$.Name` gives ['Owner', 'Company']; undefined for an alias without a path. */
function relationPath(alias: string, separator: string): string[] | undefined {
  const parts = alias.split('.');
  return parts.length > 1 ? parts.slice(0, -1).map((part) => unwrapped(part, separator)) : undefined;
}

function targetOf(descriptor: IModelDescriptor | undefined, relation: string): Joined | undefined {
  for (const candidate of descriptor?.Relations.values() ?? []) {
    const target = candidate.Name === relation ? extractModelDescriptor(candidate.TargetModel) : null;
    if (target) return { model: candidate.TargetModel, descriptor: target };
  }

  return undefined;
}

/** The model a populate alias path ends at, walked through the relation descriptors. */
function joinedModel(query: SelectQueryBuilder<unknown>, root: IModelDescriptor, path: readonly string[]): Joined | undefined {
  let current: Joined | undefined;
  let from: IModelDescriptor | undefined = root;
  let rest = path;

  // A many-to-many or recursive relation query carries the target model and prefixes its columns with the relation's own alias.
  const owner = query.Owner;
  if (owner && rest[0] === owner.Name && targetOf(root, rest[0]) === undefined) {
    const target = extractModelDescriptor(owner.Descriptor.TargetModel);
    current = target ? { model: owner.Descriptor.TargetModel, descriptor: target } : undefined;
    from = target ?? undefined;
    rest = rest.slice(1);
  }

  for (const name of rest) {
    current = targetOf(from, name);
    from = current?.descriptor;
  }

  return current;
}

type SourceAt = (prefix: string, descriptor: IModelDescriptor, models: readonly Constructor<ModelBase>[]) => ReadSource;

function joinedSource(query: SelectQueryBuilder<unknown>, root: IModelDescriptor, alias: string, at: SourceAt): ReadSource | undefined {
  const path = relationPath(alias, query.Driver.Options.AliasSeparator ?? '');
  const joined = path ? joinedModel(query, root, path) : undefined;
  return path && joined ? at(`${path.join('.')}.`, joined.descriptor, [joined.model]) : undefined;
}

function addColumn(source: ReadSource, statement: ColumnStatement, column: string): void {
  if (statement instanceof ColumnMethodStatement) {
    source.computed.add(lc(column));
  } else if (statement.IsWildcard) {
    source.all = true;
  } else {
    source.keys.set(lc(column), statement.Alias === '' ? column : statement.Alias);
  }
}

/**
 * The tables a select returns values of, each with the columns it returns. `*` and an empty list return every column of
 * the queried table; a column aliased `<relation path>.<column>` belongs to the model the path ends at; a raw or
 * condition column cannot be read and counts as every column of every table found.
 */
export function selectListOf(query: SelectQueryBuilder<unknown>, root: IModelDescriptor): ReadSource[] {
  // The junction select of a many-to-many populate carries the target model but reads the junction table.
  const ownTable = query.Table === root.TableName;
  const sources = new Map<string, ReadSource>();
  const at: SourceAt = (prefix, descriptor, models) => {
    const known = sources.get(prefix);
    if (known) return known;

    const created: ReadSource = { descriptor, models, own: prefix === '', keys: new Map<string, string>(), computed: new Set<string>(), all: false, opaque: false };
    sources.set(prefix, created);
    return created;
  };
  const own = (): ReadSource => at('', root, query.Model ? [query.Model] : []);

  const statements = query.getColumns();
  let opaque = false;
  for (const statement of statements) {
    const column = statement instanceof ColumnStatement ? statement.Column : undefined;
    if (!(statement instanceof ColumnStatement) || typeof column !== 'string') {
      opaque = true;
      continue;
    }
    // `count(*)` reads no column.
    if (statement instanceof ColumnMethodStatement && column.trim() === '*') continue;

    const joined = joinedSource(query, root, statement.Alias, at);
    const source = joined ?? (ownTable ? own() : undefined);
    if (source) addColumn(source, statement, column);
  }

  if (ownTable && statements.length === 0) own().all = true;
  if (opaque) {
    if (ownTable) own();
    for (const source of sources.values()) source.opaque = true;
  }

  return [...sources.values()];
}
