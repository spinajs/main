import { createHash, randomUUID } from 'node:crypto';
import { AUTHZ_CONNECTION, AuthzConfigError, changeLog, principalKey } from '@spinajs/authz';
import type { AuthzTx, ChangeEntry, PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
// Registers DbChangeLog and its migration: the tuple writes below append to it.
import '@spinajs/authz-orm/changelog';
import { stableStringify } from '@spinajs/authz-ir';
import { ConcurrencyConflict } from '@spinajs/exceptions';
import { Connection, ConnectionMismatch, DateTime as DateTimeColumn, Model, ModelBase, NotAnOrmDriver, OrmConnectionMissing, OrmNotResolved, Primary, TransactionRequired, UniqueViolation, modelDriver, requireModelTransaction, supportsRowLocks } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
// A value import: @DateTime() reads the property's design type.
import { DateTime } from 'luxon';

import { TupleCaveatConflict, TupleStore } from '../contracts.js';
import type { Tuple, TupleCaveat, TuplePage, TupleQuery, TupleSubject } from '../contracts.js';
import { CAVEAT_CONTEXT_MAX, caveatKey, isSubjectSet, readTuple, sameCaveat, subjectKey, tupleKey } from '../keys.js';
import type { NamespaceSchema } from '../namespace/compile.js';

export const AUTHZ_REBAC_TUPLE_TABLE = 'authz_rebac_tuple';

/** Widths of the authz_rebac_tuple columns a tuple fills. */
export const TUPLE_COLUMN_WIDTHS = Object.freeze({ namespace: 64, object_id: 128, relation: 64, subject_key: 320, subject_type: 64, subject_id: 128, created_by: 100, caveat: 64, caveat_context: CAVEAT_CONTEXT_MAX });

// Keeps an IN list within the bind-parameter limits of every driver.
const IN_CHUNK = 500;

// 13 bind parameters a row: 100 rows stay under the 2100 parameters of MSSQL.
const INSERT_CHUNK = 100;

/**
 * `size`, or `db.WriteCapture.MaxRows` when that is lower: the capture refuses a statement of more rows once the table
 * has history, and one statement per tuple never did. Read as the capture reads it.
 */
function capped(size: number): number {
  const limit = DI.get(Configuration)?.get<unknown>('db.WriteCapture.MaxRows', 0);
  return typeof limit === 'number' && limit > 0 ? Math.min(size, limit) : size;
}

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

  public caveat!: string | null;

  public caveat_key!: string | null;

  public caveat_context!: string | null;
}

type TupleRow = Pick<TupleRecord, 'tuple_key' | 'namespace' | 'object_id' | 'relation' | 'subject_key' | 'subject_type' | 'subject_id' | 'subject_relation' | 'created_by' | 'created_at' | 'caveat' | 'caveat_key' | 'caveat_context'>;

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
    caveat: t.caveat?.name ?? null,
    caveat_key: t.caveat ? caveatKey(t.caveat) : null,
    caveat_context: t.caveat?.context ? stableStringify(t.caveat.context) : null,
  };
}

/** The tuple an `authz_rebac_tuple` row holds. */
export function tupleOf(r: Pick<TupleRecord, 'namespace' | 'object_id' | 'relation' | 'subject_type' | 'subject_id' | 'subject_relation' | 'caveat' | 'caveat_context'>): Tuple {
  const object = { type: r.namespace, id: r.object_id };
  const subject: TupleSubject = r.subject_relation ? { object: { type: r.subject_type, id: r.subject_id }, relation: r.subject_relation } : { type: r.subject_type, id: r.subject_id };
  const bare: Tuple = { object, relation: r.relation, subject };
  if (r.caveat === null || r.caveat === undefined) return bare;
  // Through readTuple: the stored JSON is checked like a written one.
  return readTuple({ ...bare, caveat: { name: r.caveat, ...(r.caveat_context ? { context: JSON.parse(r.caveat_context) as unknown } : {}) } }, AUTHZ_REBAC_TUPLE_TABLE);
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

function chunks<T>(list: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The rows among `keys` that authz_rebac_tuple holds, by tuple_key; with `shared`, read under a shared row lock. */
async function storedRows(keys: readonly string[], shared = false): Promise<Map<string, TupleRecord>> {
  const stored = new Map<string, TupleRecord>();
  // spinajs-orm-ignore ORM102: deliberate batching, one query per IN_CHUNK tuple keys
  for (const part of chunks([...new Set(keys)])) {
    const query = TupleRecord.query().whereIn('tuple_key', part);
    const rows = await (shared ? query.forShare() : query);
    for (const r of rows) stored.set(r.tuple_key, r);
  }
  return stored;
}

/** Deletes the stored tuples among `removes`; returns them as stored, caveat included. */
async function removeRows(removes: readonly Tuple[], removed: (t: Tuple, key: string) => void): Promise<Tuple[]> {
  const stored = await storedRows(removes.map(hashOf));
  const out: Tuple[] = [];
  const keys: string[] = [];
  for (const t of removes) {
    const key = hashOf(t);
    const had = stored.get(key);
    if (had === undefined) continue;
    stored.delete(key);
    keys.push(key);
    const tuple = tupleOf(had);
    out.push(tuple);
    removed(tuple, key);
  }
  // spinajs-orm-ignore ORM102: deliberate batching, one statement per IN_CHUNK tuple keys
  for (const part of chunks(keys, capped(IN_CHUNK))) await TupleRecord.destroy().whereIn('tuple_key', part);
  return out;
}

interface Fresh {
  readonly tuple: Tuple;
  readonly row: TupleRow;
}

/** Inserts the tuples among `adds` not stored yet. @throws TupleCaveatConflict for a tuple stored with another caveat */
async function insertRows(driver: OrmDriver, adds: readonly Tuple[], actor: PrincipalRef, now: Date, added: (t: Tuple, key: string) => void): Promise<Tuple[]> {
  const held = new Map<string, Tuple>();
  for (const [key, r] of await storedRows(adds.map(hashOf))) held.set(key, tupleOf(r));
  const fresh: Fresh[] = [];
  for (const t of adds) {
    const row = rowOf(t, actor, now);
    const has = held.get(row.tuple_key);
    if (has !== undefined) {
      if (!sameCaveat(has.caveat, t.caveat)) throw new TupleCaveatConflict(has, t);
      continue;
    }
    held.set(row.tuple_key, t);
    fresh.push({ tuple: t, row });
  }
  const out: Tuple[] = [];
  const raced: Tuple[] = [];
  // In sequence: savepoints of one transaction must not interleave.
  for (const part of chunks(fresh, capped(INSERT_CHUNK))) {
    const done = await insertPart(driver, part);
    for (const f of done.inserted) {
      out.push(f.tuple);
      added(f.tuple, f.row.tuple_key);
    }
    raced.push(...done.raced);
  }
  await refuseRacedConflicts(driver, raced);
  return out;
}

/** `part` in one INSERT; when another transaction stored one of its rows meanwhile, row by row, so the others still go in. */
async function insertPart(driver: OrmDriver, part: readonly Fresh[]): Promise<{ readonly inserted: readonly Fresh[]; readonly raced: readonly Tuple[] }> {
  if (await insertOnce(driver, part.map((f) => f.row))) return { inserted: part, raced: [] };
  const inserted: Fresh[] = [];
  const raced: Tuple[] = [];
  for (const f of part) {
    if (await insertOnce(driver, [f.row])) inserted.push(f);
    else raced.push(f.tuple);
  }
  return { inserted, raced };
}

/** False when another transaction stored one of the rows meanwhile. */
async function insertOnce(driver: OrmDriver, rows: readonly TupleRow[]): Promise<boolean> {
  try {
    // A savepoint: on Postgres the unique violation would otherwise abort the whole transaction.
    await driver.transaction(async () => {
      await TupleRecord.insert([...rows]);
    });
    return true;
  } catch (err) {
    if (err instanceof UniqueViolation) return false;
    throw err;
  }
}

/** Tuples another transaction stored meanwhile: with the same caveat that is what was asked, with another a conflict. */
async function refuseRacedConflicts(driver: OrmDriver, raced: readonly Tuple[]): Promise<void> {
  if (raced.length === 0) return;
  // A plain read on MySQL keeps the transaction's snapshot, which does not hold a row committed after it.
  const stored = await storedRows(raced.map(hashOf), supportsRowLocks(driver));
  for (const t of raced) {
    const r = stored.get(hashOf(t));
    if (r === undefined) throw new ConcurrencyConflict(`DbTupleStore: ${tupleKey(t)} was stored by another transaction meanwhile and this transaction cannot read it to compare its caveat; retry the write`);
    const held = tupleOf(r);
    if (!sameCaveat(held.caveat, t.caveat)) throw new TupleCaveatConflict(held, t);
  }
}

/**
 * `TupleStore` over `authz_rebac_tuple` on the ORM connection alias `authz`. `write` runs in its own
 * transaction; `writeIn` joins the transaction of an `AuthzAdmin` command. Built with `new`, not by DI, so it cannot inject
 * the Orm: RebacModel resolves it when its store is a DbTupleStore; any other user resolves it before the first read.
 */
export class DbTupleStore extends TupleStore {
  readonly name: string = 'db';
  private readonly schemas = new Set<() => NamespaceSchema>();

  constructor() {
    super();
    changeLog().track('tuple');
  }

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
    const rows = await TupleRecord.query().where({ namespace: object.type, object_id: object.id, relation });
    return rows.map(tupleOf);
  }

  async reverse(subject: TupleSubject, relation: string, objectType: ResourceType): Promise<readonly ResourceRef[]> {
    return this.reverseMany([subject], relation, objectType);
  }

  async reverseMany(subjects: readonly TupleSubject[], relation: string, objectType: ResourceType): Promise<readonly ResourceRef[]> {
    const keys = [...new Set(subjects.map(subjectKey))];
    if (keys.length === 0) return [];
    const out = new Map<string, ResourceRef>();
    // spinajs-orm-ignore ORM102: deliberate batching, one query per IN_CHUNK subject keys
    for (const part of chunks(keys)) {
      const rows = await TupleRecord.query().where({ namespace: objectType, relation }).whereIn('subject_key', part);
      for (const r of rows) out.set(r.object_id, { type: objectType, id: r.object_id });
    }
    return [...out.values()];
  }

  async write(add: readonly Tuple[], remove: readonly Tuple[], actor: PrincipalRef): Promise<string> {
    const adds = add.map((t, i) => this.allowed(checked(t, `add[${i}]`, actor), `add[${i}]`));
    const removes = remove.map((t, i) => checked(t, `remove[${i}]`, actor));
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

  /**
   * `write` inside the caller's transaction. Returns the tuples it changed: on `removed` as they were stored, caveat
   * included, whatever caveat the request carried. @throws TupleCaveatConflict for a stored tuple with another caveat;
   * ConcurrencyConflict for a tuple another transaction stored that this one's snapshot cannot read (retry the write)
   */
  async writeIn(tx: AuthzTx, add: readonly Tuple[], remove: readonly Tuple[], actor: PrincipalRef, now: Date = new Date()): Promise<{ readonly added: readonly Tuple[]; readonly removed: readonly Tuple[] }> {
    const adds = add.map((t, i) => checked(t, `add[${i}]`, actor));
    const removes = remove.map((t, i) => checked(t, `remove[${i}]`, actor));
    if (principalKey(actor).length > TUPLE_COLUMN_WIDTHS.created_by) throw new AuthzConfigError(`DbTupleStore: the actor key is longer than the created_by column (${TUPLE_COLUMN_WIDTHS.created_by})`);
    const driver = requireTupleTransaction(tx, 'DbTupleStore.writeIn');
    const changes: ChangeEntry[] = [];
    const change = (op: 'add' | 'remove') => (tuple: Tuple, key: string) => changes.push({ kind: 'tuple', op, key, payload: tuple, actor: principalKey(actor), at: now });
    const removed = await removeRows(removes, change('remove'));
    // Read after the removals, so a tuple removed and re-added in one call is inserted again.
    const added = await insertRows(driver, adds, actor, now, change('add'));
    await changeLog().append(changes);
    return { added, removed };
  }

  get caveats(): boolean {
    return true;
  }

  async reverseTuples(subjects: readonly TupleSubject[], relation: string, objectType: ResourceType): Promise<readonly Tuple[]> {
    const out: Tuple[] = [];
    // spinajs-orm-ignore ORM102: deliberate batching, one query per IN_CHUNK subject keys
    for (const part of chunks([...new Set(subjects.map(subjectKey))])) {
      const rows = await TupleRecord.query().where({ namespace: objectType, relation }).whereIn('subject_key', part);
      out.push(...rows.map(tupleOf));
    }
    return out;
  }

  async caveatsOn(objectType: ResourceType, relation: string, subjects: readonly TupleSubject[]): Promise<readonly TupleCaveat[]> {
    const out = new Map<string, TupleCaveat>();
    // spinajs-orm-ignore ORM102: deliberate batching, one query per IN_CHUNK subject keys
    for (const part of chunks([...new Set(subjects.map(subjectKey))])) {
      const rows = await TupleRecord.query().where({ namespace: objectType, relation }).whereNotNull('caveat_key').whereIn('subject_key', part);
      for (const r of rows) {
        const { caveat } = tupleOf(r);
        if (caveat && r.caveat_key) out.set(r.caveat_key, caveat);
      }
    }
    return [...out.values()];
  }

  async find(query: TupleQuery, page?: TuplePage): Promise<{ readonly items: readonly Tuple[]; readonly total: number }> {
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
