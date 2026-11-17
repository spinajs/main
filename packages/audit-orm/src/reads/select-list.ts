import { ColumnMethodStatement, ColumnRawStatement, ColumnStatement, extractModelDescriptor } from '@spinajs/orm';
import type { IModelDescriptor, SelectQueryBuilder } from '@spinajs/orm';

/** One table whose columns a select returns: the queried one, or one a populate joined in. */
export interface ReadSource {
  readonly descriptor: IModelDescriptor;
  /** The queried table itself. */
  readonly own: boolean;
  /** Row key of each returned column, by column name. */
  readonly keys: Map<string, string>;
  /** `*`: every column of the table, under its own name. */
  all: boolean;
}

export interface SelectList {
  readonly sources: readonly ReadSource[];
  /** A raw select expression: what it returns cannot be read from the builder. */
  readonly opaque: boolean;
}

interface NamedColumn {
  readonly statement: ColumnStatement;
  readonly column: string;
}

/** The column a select-list entry returns, 'opaque' for an expression, undefined for an aggregate or a condition. */
function columnOf(statement: unknown): NamedColumn | 'opaque' | undefined {
  if (statement instanceof ColumnRawStatement) return 'opaque';
  // ColumnMethodStatement extends ColumnStatement.
  if (!(statement instanceof ColumnStatement) || statement instanceof ColumnMethodStatement) return undefined;

  const column = statement.Column;
  return typeof column === 'string' ? { statement, column } : 'opaque';
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

function targetOf(descriptor: IModelDescriptor, relation: string): IModelDescriptor | undefined {
  for (const candidate of descriptor.Relations.values()) {
    if (candidate.Name === relation) return extractModelDescriptor(candidate.TargetModel) ?? undefined;
  }

  return undefined;
}

/** The model a populate alias path ends at, walked through the relation descriptors. */
function joinedDescriptor(query: SelectQueryBuilder<unknown>, root: IModelDescriptor, path: readonly string[]): IModelDescriptor | undefined {
  let current: IModelDescriptor | undefined = root;
  let rest = path;

  // A many-to-many or recursive relation query carries the target model and prefixes its columns with the relation's own alias.
  const owner = query.Owner;
  if (owner && rest[0] === owner.Name && targetOf(root, rest[0]) === undefined) {
    current = extractModelDescriptor(owner.Descriptor.TargetModel) ?? undefined;
    rest = rest.slice(1);
  }

  for (const name of rest) {
    current = current ? targetOf(current, name) : undefined;
  }

  return current;
}

type SourceAt = (prefix: string, descriptor: IModelDescriptor) => ReadSource;

function addColumn(named: NamedColumn, query: SelectQueryBuilder<unknown>, root: IModelDescriptor, ownTable: boolean, at: SourceAt): void {
  const alias = named.statement.Alias;
  const path = relationPath(alias, query.Driver.Options.AliasSeparator ?? '');
  const joined = path ? joinedDescriptor(query, root, path) : undefined;
  if (path && joined) {
    at(`${path.join('.')}.`, joined).keys.set(named.column, alias);
  } else if (ownTable && named.statement.IsWildcard) {
    at('', root).all = true;
  } else if (ownTable) {
    at('', root).keys.set(named.column, alias === '' ? named.column : alias);
  }
}

export function selectListOf(query: SelectQueryBuilder<unknown>, root: IModelDescriptor): SelectList {
  // The junction select of a many-to-many populate carries the target model but reads the junction table.
  const ownTable = query.Table === root.TableName;
  const sources = new Map<string, ReadSource>();
  const at: SourceAt = (prefix, descriptor) => {
    const known = sources.get(prefix);
    if (known) return known;

    const created: ReadSource = { descriptor, own: prefix === '', keys: new Map<string, string>(), all: false };
    sources.set(prefix, created);
    return created;
  };

  const statements = query.getColumns();
  let opaque = false;

  for (const statement of statements) {
    const named = columnOf(statement);
    if (named === 'opaque') {
      opaque = true;
    } else if (named !== undefined) {
      addColumn(named, query, root, ownTable, at);
    }
  }

  if (ownTable && statements.length === 0) at('', root).all = true;
  if (ownTable && opaque) at('', root);

  return { sources: [...sources.values()], opaque };
}
