import { parseResourceKey, resourceKey } from '@spinajs/authz';
import type { ChangeRecord, ResourceType } from '@spinajs/authz';
import { HistoryContributors } from '@spinajs/authz-ir';
import type { CurrentItem, HistoryEdge, ObjectRef, RelationDef, RelationName, TupleSubjectRef, TypeName } from '@spinajs/authz-ir';
import { Injectable, Singleton } from '@spinajs/di';

import { HorizonRecord, columnFingerprint } from '../changelog/horizon.js';
import { driverOf, idLookup, idText, tableOf } from '../ids.js';
import { selectFrom } from '../records.js';
import { changelogColumns, classesOf, entryOf, nameOf, registeredClasses } from '../registry.js';
import type { ModelClass, RelationColumn, ResourceEntry } from '../registry.js';

type Source = RelationDef['source'];
type Row = Readonly<Record<string, unknown>>;

/** A relation column as the column capture logs it, without `old`: what the row holds. */
interface ColumnImage {
  model: string;
  column: string;
  new: { type: string; id: string } | null;
}

interface Column {
  model: ModelClass;
  entry: ResourceEntry;
  column: RelationColumn;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `@AccessResource` column behind a `column` source, when it is one the changelog records (never `@Self`). */
function columnOf(model: string, column: string): Column | undefined {
  const cls = registeredClasses().find((c) => nameOf(c) === model);
  const entry = entryOf(cls);
  const found = entry === undefined ? undefined : changelogColumns(entry).find((c) => c.column === column);
  return cls === undefined || entry === undefined || found === undefined ? undefined : { model: cls, entry, column: found };
}

/** The relation `ormToIR` names the column: `parent_<column>` when the model has several `@Parent` columns. */
const irRelation = (c: Column): RelationName => (c.column.relation === 'parent' && c.entry.parents.length > 1 ? `parent_${c.column.column}` : c.column.relation);

/** As the column capture reads a row: a type column that holds no string gives type `''`. */
function targetOf(c: RelationColumn, row: Row): ColumnImage['new'] {
  const id = idText(row[c.column]);
  if (id === undefined) return null;
  const type = c.typeColumn === undefined ? c.type : row[c.typeColumn];
  return { type: typeof type === 'string' ? type : '', id };
}

/**
 * Rebuilds the relation columns of `@AccessResource` rows (`@Parent`, `@Owner`, `@Relation`; kind `column`) at a
 * decision's instant. Current values are read by raw select on the model's connection, so soft-deleted and archived
 * rows count and no access middleware scopes the read. Several `@Parent` columns share one changelog key, so a read
 * takes only its own column's changes; `parent` over several of them (`ancestor via 'orm'`) is read as their union.
 */
@Singleton()
@Injectable(HistoryContributors)
export class ColumnHistoryContributor extends HistoryContributors {
  readonly kind = 'column' as const;

  serves(source: Source): boolean {
    return (source.kind === 'column' && columnOf(source.model, source.column) !== undefined) || (source.kind === 'ancestor' && source.via === 'orm');
  }

  coverageType(object: ObjectRef): ResourceType {
    return object.type;
  }

  parts(type: TypeName, _relation: RelationName, source: Source): RelationName[] | undefined {
    if (source.kind !== 'ancestor') return undefined;
    const parts = classesOf(type).flatMap((m) => {
      const parents = entryOf(m)?.parents ?? [];
      return parents.length > 1 ? parents.map((p) => `parent_${p.column}`) : [];
    });
    // Without a model that declares them, the read stays whole and its coverage check decides.
    return parts.length === 0 ? undefined : [...new Set(parts)];
  }

  async coverageGap(type: ResourceType | undefined): Promise<string | undefined> {
    if (type === undefined) return undefined;
    if (classesOf(type).some((m) => entryOf(m)?.changelog === false)) return `a model of ${type} keeps its relation columns out of the changelog (changelog: false)`;
    const row = (await selectFrom(HorizonRecord).onPrimary().where('kind', 'column').where('resource_type', type).first()) as HorizonRecord | undefined;
    if (row === undefined) return undefined;
    // A node of another deploy may have written columns this process does not declare, or the reverse, without logging them.
    return row.fingerprint === columnFingerprint(type) ? undefined : `the column coverage of ${type} was recorded for other relation columns than this process declares`;
  }

  async current(object: ObjectRef, _relation: RelationName, source: Source): Promise<CurrentItem<TupleSubjectRef>[]> {
    const c = source.kind === 'column' ? columnOf(source.model, source.column) : undefined;
    const id = c === undefined ? undefined : idLookup(c.model, c.entry.idColumn, object.id);
    if (c === undefined || id === undefined) return [];
    return this.items(c, await this.rows(c, c.entry.idColumn, id), (target) => target);
  }

  async currentReverse(subject: TupleSubjectRef, _relation: RelationName, objectType: TypeName, source: Source): Promise<CurrentItem<ObjectRef>[]> {
    const c = source.kind === 'column' ? columnOf(source.model, source.column) : undefined;
    const value = c === undefined ? undefined : idLookup(c.model, c.column.column, subject.id);
    if (c === undefined || value === undefined || c.entry.type !== objectType) return [];
    const rows = (await this.rows(c, c.column.column, value)).filter((r) => {
      const target = targetOf(c.column, r);
      return target !== null && target.type === subject.type && target.id === subject.id;
    });
    return this.items(c, rows, (_target, object) => object);
  }

  edges(change: ChangeRecord): HistoryEdge[] {
    const p = change.payload;
    if (!isRecord(p) || typeof p.model !== 'string' || typeof p.column !== 'string') return [];
    const c = columnOf(p.model, p.column);
    const suffix = `#${c?.column.relation ?? ''}`;
    if (c === undefined || !change.key.endsWith(suffix)) return [];
    const ref = parseResourceKey(change.key.slice(0, -suffix.length));
    if (ref.id === undefined || ref.id === null) return [];
    const object = { type: ref.type, id: ref.id };
    return [p.old, p.new].filter(isRecord).flatMap((t) => (typeof t.type === 'string' && typeof t.id === 'string' ? [{ key: change.key, object, relation: irRelation(c), subject: { type: t.type, id: t.id } }] : []));
  }

  /** The change as one column's image: a put from `null` adds a target, a put to `null` removes it. */
  project(change: ChangeRecord, source: Source): ChangeRecord | undefined {
    const p = change.payload;
    if (source.kind !== 'column' || !isRecord(p) || p.model !== source.model || p.column !== source.column) return undefined;
    const image = (target: unknown): ColumnImage => ({ model: source.model, column: source.column, new: isRecord(target) ? { type: String(target.type), id: String(target.id) } : null });
    if (!isRecord(p.old)) return { ...change, op: 'add', payload: image(p.new), before: null };
    if (!isRecord(p.new)) return { ...change, op: 'remove', payload: image(p.old), before: image(p.old) };
    return { ...change, op: 'put', payload: image(p.new), before: image(p.old) };
  }

  subjectAt(image: unknown): TupleSubjectRef | undefined {
    const target = isRecord(image) && isRecord(image.new) ? image.new : undefined;
    return typeof target?.type === 'string' && typeof target.id === 'string' ? { type: target.type, id: target.id } : undefined;
  }

  private async rows(c: Column, by: string, value: string | number): Promise<Row[]> {
    const names = [...new Set([c.entry.idColumn, c.column.column, ...(c.column.typeColumn === undefined ? [] : [c.column.typeColumn])])];
    return (await driverOf(c.model).select().from(tableOf(c.model)).columns(names).where(by, value)) as Row[];
  }

  private items<S>(c: Column, rows: readonly Row[], subject: (target: { type: string; id: string }, object: ObjectRef) => S): CurrentItem<S>[] {
    return rows.flatMap((row) => {
      const id = idText(row[c.entry.idColumn]);
      const target = targetOf(c.column, row);
      if (id === undefined || target === null) return [];
      const object = { type: c.entry.type, id };
      const image: ColumnImage = { model: nameOf(c.entry.registered), column: c.column.column, new: target };
      return [{ key: `${resourceKey(object)}#${c.column.relation}`, image, subject: subject(target, object) }];
    });
  }
}
