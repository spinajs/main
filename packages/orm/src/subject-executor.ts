/* eslint-disable prettier/prettier */
import { DateTime } from 'luxon';
import _ from 'lodash';
import { createQuery, DeleteQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder } from './builders.js';
import { OrmException } from './exceptions.js';
import { IInsertResult, ISaveOptions, ISaveResult, OrphanPolicy, ServerResponseMapper } from './interfaces.js';
import { assertAssignedKeys, generateClientSideKeys, pkColumns, pkGeneration, pkValueOf, setPkValue, whereAnyPk, wherePk } from './primary-keys.js';
import { ISortedPlan } from './subject-sorter.js';
import { IJunctionDelta, IOrphanDelta, Subject } from './subject.js';

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
    await this.runJunctions(plan, result);
    await this.runOrphans(plan, result);

    return result;
  }

  /**
   * Inserts every insert subject in the order the sorter produced, reading each generated key
   * back before moving on so the next subject's foreign keys can be resolved.
   *
   * One statement per row, deliberately, and NOT subject to `options.chunk`: a batched
   * multi-row INSERT can only return keys where the dialect supports RETURNING or where
   * `insertIdIsFirstOfBatch` holds, and a subject's key is needed by the very next subject in
   * the order. Batching here is a real feature — it has to carry the per-dialect key-backfill
   * rules with it — not something to fold into the chunking used for junction and orphan rows.
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

  /**
   * Creates and destroys junction rows.
   *
   * Rows are written column-first rather than through the junction model, so a junction model
   * is not required to declare `@BelongsTo` on both sides — `ManyToManyRelationList.update()`
   * does require that, and none of the existing junction fixtures satisfy it.
   *
   * Inserts run before deletes so that re-linking the same pair inside one save cannot
   * momentarily violate a unique constraint on the junction table in the other order.
   */
  protected async runJunctions(plan: ISortedPlan, result: ISaveResult): Promise<void> {
    for (const delta of plan.Junctions) {
      await this.insertJunctionRows(delta, result);
      await this.deleteJunctionRows(delta, result);
    }
  }

  protected async insertJunctionRows(delta: IJunctionDelta, result: ISaveResult): Promise<void> {
    if (delta.Added.length === 0) {
      return;
    }

    const sourceColumn = delta.Descriptor.JunctionModelSourceModelFKey_Name;
    const targetColumn = delta.Descriptor.JunctionModelTargetModelFKey_Name;

    if (!sourceColumn || !targetColumn) {
      throw new OrmException(`manyToMany relation ${delta.Descriptor.Name} has no junction foreign-key column names`);
    }

    const ownerKey = delta.Owner.PrimaryKeyValue;

    for (const batch of this.chunked(delta.Added)) {
      const values = batch.map((target) => ({
        [sourceColumn]: ownerKey,
        [targetColumn]: target.PrimaryKeyValue,
      }));

      const { query } = createQuery(delta.Descriptor.JunctionModel!, InsertQueryBuilder);
      await query.values(values);

      result.JunctionInserted += values.length;
    }
  }

  protected async deleteJunctionRows(delta: IJunctionDelta, result: ISaveResult): Promise<void> {
    if (delta.RemovedKeys.length === 0) {
      return;
    }

    const sourceColumn = delta.Descriptor.JunctionModelSourceModelFKey_Name!;
    const targetColumn = delta.Descriptor.JunctionModelTargetModelFKey_Name!;
    const ownerKey = delta.Owner.PrimaryKeyValue;

    for (const batch of this.chunked(delta.RemovedKeys)) {
      const { query } = createQuery(delta.Descriptor.JunctionModel!, DeleteQueryBuilder);
      await (query as DeleteQueryBuilder<unknown>).where(sourceColumn, ownerKey).whereIn(targetColumn, batch);

      result.JunctionDeleted += batch.length;
    }
  }

  /**
   * Applies the orphan policy to every detached row.
   *
   * `nullify` and `soft-delete` run first as UPDATEs, then `delete` runs as DELETEs, and the
   * deltas arrive from the sorter already ordered children-before-parents so a delete cannot
   * strand a foreign key.
   *
   * `createQuery` only adds the default `DeletedAt IS NULL` filter to a SelectQueryBuilder, so
   * these builders are unfiltered — which is what stamping an already-soft-deleted row needs.
   */
  protected async runOrphans(plan: ISortedPlan, result: ISaveResult): Promise<void> {
    const updates = plan.Orphans.filter((o) => this.effectivePolicy(o) !== OrphanPolicy.Delete);
    const deletes = plan.Orphans.filter((o) => this.effectivePolicy(o) === OrphanPolicy.Delete);

    for (const delta of updates) {
      await this.updateOrphans(delta, result);
    }

    for (const delta of deletes) {
      await this.deleteOrphans(delta, result);
    }
  }

  /**
   * The policy actually applied to `delta`.
   *
   * `delete` on a model that declares `@SoftDelete` degrades to `soft-delete`, so orphaning a
   * row and calling `destroy()` on it mean the same thing. `ModelBase.destroy()` has always
   * stamped `DeletedAt` rather than issuing a DELETE for such a model; an orphan taking the
   * other branch made "delete this row" depend on which code path reached it, and hard-erased
   * rows the model had declared should never be hard-erased.
   */
  protected effectivePolicy(delta: IOrphanDelta): OrphanPolicy {
    if (delta.Policy === OrphanPolicy.Delete && delta.TargetDescriptor.SoftDelete?.DeletedAt) {
      return OrphanPolicy.SoftDelete;
    }

    return delta.Policy;
  }

  protected async updateOrphans(delta: IOrphanDelta, result: ISaveResult): Promise<void> {
    const policy = this.effectivePolicy(delta);
    const payload = policy === OrphanPolicy.Nullify ? { [delta.Descriptor.ForeignKey]: null } : { [delta.TargetDescriptor.SoftDelete!.DeletedAt]: DateTime.now() };

    for (const batch of this.chunked(delta.PrimaryKeys)) {
      const { query } = createQuery(delta.Descriptor.TargetModel, UpdateQueryBuilder);
      const update = (query as UpdateQueryBuilder<unknown>).update(payload);
      whereAnyPk(update, delta.TargetDescriptor, batch);
      await update;

      if (policy === OrphanPolicy.Nullify) {
        result.Updated += batch.length;
      } else {
        result.SoftDeleted += batch.length;
      }
    }
  }

  protected async deleteOrphans(delta: IOrphanDelta, result: ISaveResult): Promise<void> {
    for (const batch of this.chunked(delta.PrimaryKeys)) {
      const { query } = createQuery(delta.Descriptor.TargetModel, DeleteQueryBuilder);
      whereAnyPk(query as DeleteQueryBuilder<unknown>, delta.TargetDescriptor, batch);
      await query;

      result.Deleted += batch.length;
    }
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
