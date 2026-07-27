/* eslint-disable prettier/prettier */
import { DateTime } from 'luxon';
import _ from 'lodash';
import { createQuery, InsertQueryBuilder, UpdateQueryBuilder } from './builders.js';
import { OrmException } from './exceptions.js';
import { IInsertResult, ISaveOptions, ISaveResult, ServerResponseMapper } from './interfaces.js';
import { assertAssignedKeys, generateClientSideKeys, pkColumns, pkGeneration, pkValueOf, setPkValue, wherePk } from './primary-keys.js';
import { ISortedPlan } from './subject-sorter.js';
import { Subject } from './subject.js';

/** Rows per batched statement when the caller does not say. */
export const DEFAULT_SAVE_CHUNK = 100;

/**
 * Runs a sorted plan.
 *
 * Every statement is built through `createQuery`, so table naming, schema qualification and
 * identifier escaping are the same as on the ActiveRecord paths. No connection is threaded by
 * hand: `OrmDriver.transaction()` carries it in `AsyncLocalStorage` and the builders resolved
 * from that driver pick it up automatically.
 *
 * The executor does **not** open the transaction — `UnitOfWork` does — so that a caller can
 * drive it directly in a test and so that nested saves inside one transaction fold into
 * savepoints rather than each opening their own.
 */
export class SubjectExecutor {
  constructor(protected options: ISaveOptions) {}

  public async execute(plan: ISortedPlan): Promise<ISaveResult> {
    const result: ISaveResult = {
      Inserted: 0,
      Updated: 0,
      Deleted: 0,
      SoftDeleted: 0,
      JunctionInserted: 0,
      JunctionDeleted: 0,
    };

    await this.runInserts(plan, result);
    await this.runUpdates(plan, result);

    return result;
  }

  /**
   * Inserts every insert subject in the order the sorter produced, reading each generated key
   * back before moving on so the next subject's foreign keys can be resolved.
   */
  protected async runInserts(plan: ISortedPlan, result: ISaveResult): Promise<void> {
    for (const subject of plan.Inserts) {
      await this.insertOne(subject);
      result.Inserted += 1;
    }
  }

  /**
   * One INSERT, with the key read back.
   *
   * Mirrors `ModelBase.insert()`'s key handling rather than inventing a second one: client-side
   * keys are generated first, `assigned` keys are asserted before anything touches the database,
   * and RETURNING is requested when an `auto` key needs to come back and the dialect supports it.
   */
  protected async insertOne(subject: Subject): Promise<void> {
    const descriptor = subject.Descriptor;
    const model: any = subject.Model;

    // Both run BEFORE the query is built, so an `assigned` key that was never supplied fails
    // without touching the database.
    generateClientSideKeys(model, descriptor);
    assertAssignedKeys(model, descriptor);

    const { query, container } = createQuery(model.constructor, InsertQueryBuilder);
    const mapper = container.resolve(ServerResponseMapper);

    const needsKeyBack = pkColumns(descriptor).some((c) => pkGeneration(descriptor, c) === 'auto');
    if (needsKeyBack && query.Driver.supportedFeatures().insertReturning) {
      query.returning(pkColumns(descriptor));
    }

    const response = mapper.read((await query.values(this.insertPayload(subject))) as IInsertResult, pkColumns(descriptor));

    this.backfillKey(subject, response.Returning, response.LastInsertId, needsKeyBack);

    model.IsDirty = false;
    subject.Model.takeSnapshot();
  }

  /**
   * Runs every update, including the follow-up updates that carry deferred self-referencing
   * foreign keys.
   *
   * A subject whose payload comes out empty emits nothing. This is the single place that
   * decides whether a row actually changed: pending foreign keys are written onto the model
   * first and `changedColumns()` is read afterwards, so a re-parented child that was clean
   * when the subjects were built is caught here and nowhere else.
   */
  protected async runUpdates(plan: ISortedPlan, result: ISaveResult): Promise<void> {
    for (const subject of plan.Updates) {
      const payload = this.updatePayload(subject);
      if (payload === null) {
        continue;
      }

      const { query } = createQuery(subject.Model.constructor, UpdateQueryBuilder);
      const update = (query as UpdateQueryBuilder<unknown>).update(payload);
      wherePk(update, subject.Descriptor, subject.Model.PrimaryKeyValue);
      await update;

      subject.Model.IsDirty = false;
      subject.Model.takeSnapshot();

      result.Updated += 1;
    }
  }

  /**
   * The column payload for one UPDATE, or `null` when there is nothing to write.
   *
   * The primary key columns are excluded: writing them is a no-op at best and, for a model
   * whose key column differs from its snapshot for any other reason, a silent identity change.
   *
   * @param subject - an update subject, or an insert subject with deferred foreign keys
   */
  protected updatePayload(subject: Subject): Record<string, unknown> | null {
    // Resolve every foreign key onto the model first, so the diff below sees them.
    for (const fk of subject.PendingForeignKeys.concat(subject.DeferredForeignKeys)) {
      (subject.Model as any)[fk.Column] = fk.Target.PrimaryKeyValue;
    }

    const keyColumns = pkColumns(subject.Descriptor);
    const changed = subject.Model.changedColumns().filter((c) => !keyColumns.includes(c));
    if (changed.length === 0) {
      return null;
    }

    const updatedAt = subject.Descriptor.Timestamps?.UpdatedAt;
    if (updatedAt) {
      (subject.Model as any)[updatedAt] = DateTime.now();
      if (!changed.includes(updatedAt)) {
        changed.push(updatedAt);
      }
    }

    subject.ChangedColumns = changed;

    return _.pick(subject.Model.toSql() as Record<string, unknown>, changed);
  }

  /**
   * The column payload for one INSERT.
   *
   * Starts from the model's own serialization, drops every column whose foreign key is
   * deferred to a follow-up UPDATE, then writes every pending foreign key from its target's
   * now-known primary key. The overwrite matters: `StandardModelToSqlConverter` already wrote
   * that column from the relation object, and for a target inserted moments ago that value was
   * `undefined` when the model was serialized.
   */
  protected insertPayload(subject: Subject): Record<string, unknown> {
    const payload = subject.Model.toSql() as Record<string, unknown>;

    for (const fk of subject.DeferredForeignKeys) {
      // eslint-disable-next-line security/detect-object-injection
      delete payload[fk.Column];
    }

    for (const fk of subject.PendingForeignKeys) {
      const value = fk.Target.PrimaryKeyValue;
      // eslint-disable-next-line security/detect-object-injection
      payload[fk.Column] = value;
      (subject.Model as any)[fk.Column] = value;
    }

    return payload;
  }

  /**
   * Writes a generated key onto the model.
   *
   * Uses `setPkValue` — the primary-keys helper that assigns the key columns and nothing else —
   * rather than the `PrimaryKeyValue` setter, whose `RelationType.One` branch also writes the
   * new key onto the owner's `SingleRelation` wrapper, which persists nothing. The executor
   * resolves foreign keys itself and does not want that side effect.
   *
   * A key the caller already supplied ( uuid / assigned strategies ) is never overwritten.
   */
  protected backfillKey(subject: Subject, returning: any[], lastInsertId: number, needsKeyBack: boolean): void {
    const descriptor = subject.Descriptor;

    if (pkColumns(descriptor).length === 0) {
      return;
    }

    if ((returning ?? []).length !== 0) {
      setPkValue(subject.Model, descriptor, pkValueOf(returning[0], descriptor));
      return;
    }

    if (!needsKeyBack) {
      return;
    }

    // A composite key is a tuple, and a tuple is ALWAYS truthy — check every part.
    const current = subject.Model.PrimaryKeyValue;
    const missing = Array.isArray(current) ? current.some((v) => v === null || v === undefined) : current === null || current === undefined;

    if (!missing) {
      return;
    }

    if (lastInsertId === null || lastInsertId === undefined) {
      throw new OrmException(`insert of ${subject.Identity} returned no generated key and the model set none itself`);
    }

    setPkValue(subject.Model, descriptor, lastInsertId);
  }

  /** Rows per batched statement. */
  protected get chunkSize(): number {
    const chunk = this.options.chunk ?? DEFAULT_SAVE_CHUNK;
    return chunk > 0 ? chunk : DEFAULT_SAVE_CHUNK;
  }

  /** Splits `items` into runs of at most `chunkSize`. */
  protected chunked<T>(items: T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += this.chunkSize) {
      out.push(items.slice(i, i + this.chunkSize));
    }
    return out;
  }
}
