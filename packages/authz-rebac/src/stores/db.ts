import { createHash, randomUUID } from 'node:crypto';
import { AUTHZ_CONNECTION, AuthzConfigError, principalKey } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';
import { Connection, ConnectionMismatch, DateTime as DateTimeColumn, Model, ModelBase, NotAnOrmDriver, OrmConnectionMissing, OrmNotResolved, Primary, TransactionRequired, UniqueViolation, modelDriver, ormReady, requireModelTransaction } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
// A value import: @DateTime() reads the property's design type.
import { DateTime } from 'luxon';

import { TupleStore } from '../contracts.js';
import type { Tuple, TuplePage, TupleQuery, TupleSubject } from '../contracts.js';
import { isSubjectSet, readTuple, subjectKey, tupleKey } from '../keys.js';
import type { NamespaceSchema } from '../namespace/compile.js';

export const AUTHZ_REBAC_TUPLE_TABLE = 'authz_rebac_tuple';

/** Widths of the authz_rebac_tuple columns a tuple fills. */
export const TUPLE_COLUMN_WIDTHS = Object.freeze({ namespace: 64, object_id: 128, relation: 64, subject_key: 320, subject_type: 64, subject_id: 128, created_by: 100 });

// Keeps an IN list within the bind-parameter limits of every driver.
const IN_CHUNK = 500;

/** An `authz_rebac_tuple` row. */
@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_REBAC_TUPLE_TABLE)
export class TupleRecord extends ModelBase<TupleRecord> {
  @Primary({ generated: 'assigned' })
  public tuple_key!: string;

  public namespace!: string;

  public object_id!: string;

  public relation!: string;

  public subject_key!: string;

  public subject_type!: string;

  public subject_id!: string;

  public subject_relation!: string;

  public created_by!: string | null;

  @DateTimeColumn()
  public created_at!: DateTime;
}

type TupleRow = Pick<TupleRecord, 'tuple_key' | 'namespace' | 'object_id' | 'relation' | 'subject_key' | 'subject_type' | 'subject_id' | 'subject_relation' | 'created_by' | 'created_at'>;

const hashOf = (t: Tuple): string => createHash('sha256').update(tupleKey(t)).digest('hex');

function rowOf(t: Tuple, actor: PrincipalRef, now: Date): TupleRow {
  const s = t.subject;
  const set = isSubjectSet(s);
  return {
    tuple_key: hashOf(t),
    namespace: t.object.type,
    object_id: t.object.id!,
    relation: t.relation,
    subject_key: subjectKey(s),
    subject_type: set ? s.object.type : s.type,
    subject_id: set ? s.object.id! : s.id,
    subject_relation: set ? s.relation : '',
    created_by: principalKey(actor),
    created_at: DateTime.fromJSDate(now),
  };
}

function tupleOf(r: Pick<TupleRecord, 'namespace' | 'object_id' | 'relation' | 'subject_type' | 'subject_id' | 'subject_relation'>): Tuple {
  const object = { type: r.namespace, id: r.object_id };
  if (!r.subject_relation) return { object, relation: r.relation, subject: { type: r.subject_type, id: r.subject_id } };
  return { object, relation: r.relation, subject: { object: { type: r.subject_type, id: r.subject_id }, relation: r.subject_relation } };
}

/** A checked copy that fits the columns; the problem otherwise, as an AuthzConfigError naming the column. */
function checked(t: Tuple, where: string, actor: PrincipalRef): Tuple {
  const tuple = readTuple(t, where);
  const row = rowOf(tuple, actor, new Date(0));
  for (const [column, width] of Object.entries(TUPLE_COLUMN_WIDTHS) as [keyof typeof TUPLE_COLUMN_WIDTHS, number][]) {
    const value = row[column];
    if (typeof value === 'string' && value.length > width) throw new AuthzConfigError(`DbTupleStore: ${where}: ${column} is longer than ${width} characters`);
  }
  return tuple;
}

/** The driver of `tx`, an `AuthzAdmin` transaction on the connection of authz_rebac_tuple. */
export function requireTupleTransaction(tx: AuthzTx, where: string): OrmDriver {
  try {
    return requireModelTransaction(TupleRecord, tx?.driver);
  } catch (err) {
    if (err instanceof NotAnOrmDriver) throw new AuthzConfigError(`${where}: AuthzTx.driver must be the OrmDriver of an open transaction`, { cause: err });
    if (err instanceof TransactionRequired) throw new AuthzConfigError(`${where}: writes only inside a transaction, and none is in scope`, { cause: err });
    if (err instanceof ConnectionMismatch) throw new AuthzConfigError(`${where}: the AuthzTx runs on connection ${JSON.stringify(err.actual)}, but ${err.table} is on connection ${JSON.stringify(err.expected)} (db.Aliases.${AUTHZ_CONNECTION})`, { cause: err });
    if (err instanceof OrmNotResolved) throw new AuthzConfigError(`${TupleRecord.name}: the Orm is not resolved yet; resolve it (await DI.resolve(Orm)) before the authz tables are used`, { cause: err });
    if (err instanceof OrmConnectionMissing) throw new AuthzConfigError(`${TupleRecord.name}: no ORM connection answers to "${AUTHZ_CONNECTION}"; set db.Aliases.${AUTHZ_CONNECTION}`, { cause: err });
    throw err;
  }
}

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) out.push(list.slice(i, i + IN_CHUNK));
  return out;
}

/**
 * `TupleStore` over `authz_rebac_tuple` on the ORM connection alias `authz`. `write` runs in its own
 * transaction; `writeIn` joins the transaction of an `AuthzAdmin` command.
 */
export class DbTupleStore extends TupleStore {
  readonly name: string = 'db';
  private readonly schemas = new Set<() => NamespaceSchema>();

  /**
   * `write` then refuses a tuple these namespaces cannot hold, as `AuthzAdmin` does for `tuple.write`; RebacModel.init binds
   * its own. Returns the unbinding.
   */
  checkAgainst(schema: () => NamespaceSchema): () => void {
    const entry = () => schema();
    this.schemas.add(entry);
    return () => this.schemas.delete(entry);
  }

  async read(object: ResourceRef, relation: string): Promise<readonly Tuple[]> {
    if (object.id == null) return [];
    await ormReady();
    const rows = await TupleRecord.query().where({ namespace: object.type, object_id: object.id, relation });
    return rows.map(tupleOf);
  }

  async reverse(subject: TupleSubject, relation: string, objectType: ResourceType): Promise<readonly ResourceRef[]> {
    return this.reverseMany([subject], relation, objectType);
  }

  async reverseMany(subjects: readonly TupleSubject[], relation: string, objectType: ResourceType): Promise<readonly ResourceRef[]> {
    const keys = [...new Set(subjects.map(subjectKey))];
    if (keys.length === 0) return [];
    await ormReady();
    const out = new Map<string, ResourceRef>();
    for (const part of chunks(keys)) {
      const rows = await TupleRecord.query().where({ namespace: objectType, relation }).whereIn('subject_key', part);
      for (const r of rows) out.set(r.object_id, { type: objectType, id: r.object_id });
    }
    return [...out.values()];
  }

  async write(add: readonly Tuple[], remove: readonly Tuple[], actor: PrincipalRef): Promise<string> {
    const adds = add.map((t, i) => this.allowed(checked(t, `add[${i}]`, actor), `add[${i}]`));
    const removes = remove.map((t, i) => checked(t, `remove[${i}]`, actor));
    await ormReady();
    await modelDriver(TupleRecord).transaction((tx) => this.writeIn({ driver: tx }, adds, removes, actor));
    return randomUUID();
  }

  private allowed(tuple: Tuple, where: string): Tuple {
    for (const schema of this.schemas) {
      const problem = schema().problem(tuple);
      if (problem) throw new AuthzConfigError(`DbTupleStore: ${where}: ${problem.code}: ${problem.message}`);
    }
    return tuple;
  }

  async writeIn(tx: AuthzTx, add: readonly Tuple[], remove: readonly Tuple[], actor: PrincipalRef, now: Date = new Date()): Promise<{ readonly added: number; readonly removed: number }> {
    const adds = add.map((t, i) => checked(t, `add[${i}]`, actor));
    const removes = remove.map((t, i) => checked(t, `remove[${i}]`, actor));
    if (principalKey(actor).length > TUPLE_COLUMN_WIDTHS.created_by) throw new AuthzConfigError(`DbTupleStore: the actor key is longer than the created_by column (${TUPLE_COLUMN_WIDTHS.created_by})`);
    requireTupleTransaction(tx, 'DbTupleStore.writeIn');
    let removed = 0;
    for (const t of removes) {
      const key = hashOf(t);
      const [had] = await TupleRecord.query().where('tuple_key', key);
      if (!had) continue;
      await TupleRecord.destroy().where('tuple_key', key);
      removed++;
    }
    let added = 0;
    for (const t of adds) {
      const row = rowOf(t, actor, now);
      const [has] = await TupleRecord.query().where('tuple_key', row.tuple_key);
      if (has) continue;
      try {
        await TupleRecord.insert(row);
        added++;
      } catch (err) {
        // Another transaction stored the same tuple meanwhile: it is there, which is what was asked.
        if (!(err instanceof UniqueViolation)) throw err;
      }
    }
    return { added, removed };
  }

  async find(query: TupleQuery, page?: TuplePage): Promise<{ readonly items: readonly Tuple[]; readonly total: number }> {
    await ormReady();
    const filtered = () => {
      const q = TupleRecord.query();
      if (query.object) {
        q.where('namespace', query.object.type);
        if (query.object.id != null) q.where('object_id', query.object.id);
      }
      if (query.relation !== undefined) q.where('relation', query.relation);
      if (query.subject !== undefined) q.where('subject_key', subjectKey(query.subject));
      return q;
    };
    const ordered = () => filtered().orderBy('namespace').orderBy('object_id').orderBy('relation').orderBy('subject_key');
    if (!page) {
      const items = (await ordered()).map(tupleOf);
      return { items, total: items.length };
    }
    const total = await filtered().selectCount();
    if (page.limit === 0) return { items: [], total };
    const q = ordered();
    if (page.offset > 0) q.skip(page.offset);
    q.take(page.limit);
    return { items: (await q).map(tupleOf), total };
  }
}
