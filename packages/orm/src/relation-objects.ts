/* eslint-disable prettier/prettier */
import { IRelationDescriptor, IModelDescriptor, InsertBehaviour, ForwardRefFunction, IRelation, ISelectQueryBuilder, QueryScope } from './interfaces.js';
import { DI, Constructor, NewInstance } from '@spinajs/di';
import { DateTime } from 'luxon';
import { createQuery, SelectQueryBuilder, UpdateQueryBuilder } from './builders.js';
import type { ModelBase } from './model.js';
import { Orm } from './orm.js';
import _ from 'lodash';
import { OrmDriver } from './driver.js';
import { extractModelDescriptor } from './descriptor.js';
import { isCompositePk, pkColumns, pkKeyStringFor, pkValueOf, whereNotAnyPk } from './primary-keys.js';
import { OrmException } from './exceptions.js';

/**
 * Builds the equality used by every keyed set operation.
 *
 * Same reference is always equal. Two DIFFERENT rows are equal only when every key column is
 * set on both and the flattened key strings match — a fresh, unsaved model ( undefined key )
 * never equals another row, so two new models are two members, not one. The previous
 * `differenceBy` iteratee stringified undefined keys and collapsed all unsaved rows into one.
 */
function pkComparator(pKey: string[]): (a: any, b: any) => boolean {
  return (a: any, b: any) => {
    if (a === b) {
      return true;
    }

    if (pKey.length === 0) {
      return false;
    }

    const isSet = (x: any) => pKey.every((k) => x?.[k] !== null && x?.[k] !== undefined);
    if (!isSet(a) || !isSet(b)) {
      return false;
    }

    return pkKeyStringFor(a, pKey) === pkKeyStringFor(b, pKey);
  };
}

/**
 * A set operation with no comparator falls back to primary key equality, which needs key
 * columns to exist. Comparing keyless rows silently matches nothing ( or everything ), so
 * fail loudly instead.
 */
function assertSetOpKeys(pKey: string[], callback?: (a: any, b: any) => boolean): void {
  if (!callback && pKey.length === 0) {
    throw new OrmException('set operation compares by primary key, but the model declares no primary key columns; pass an explicit comparator callback');
  }
}

/**
 * Pure, in-memory set algebra over model collections. Nothing here touches the database —
 * apply a result with `relation.set(...)` and persist it with `sync()` / `update()` / `save()`.
 */
export class Dataset {
  /**
   * Calculates the symmetric difference between the relation data and the provided dataset —
   * members of either set that are not in the other. In-memory only; persist with `sync()`.
   *
   * @param dataset - data to compare
   * @param callback - function to compare objects, if none provided - primary key value is used
   */
  public static diff<R>(dataset: R[], callback?: (a: R, b: R) => boolean) {
    return (datasetB: R[], pKey: string[]) => {
      assertSetOpKeys(pKey, callback);
      const eq = callback ?? pkComparator(pKey);

      // members of dataset that are not in the relation data
      const result = _.differenceWith(dataset, [...datasetB], eq);

      // members of the relation data that are not in dataset
      const result2 = _.differenceWith([...datasetB], dataset, eq);

      return [...result, ...result2];
    };
  }

  /**
   * Calculates the intersection between the relation data and the provided dataset.
   * In-memory only; persist with `sync()`.
   *
   * @param dataset - dataset to compare
   * @param callback - function to compare models, if not set it is compared by primary key value
   */
  public static intersection<R>(dataset: R[], callback?: (a: R, b: R) => boolean) {
    return (datasetB: R[], pKey: string[]) => {
      assertSetOpKeys(pKey, callback);
      const eq = callback ?? pkComparator(pKey);
      return _.intersectionWith(dataset, [...datasetB], eq);
    };
  }

  /**
   * Calculates the union of the relation data and the provided dataset. Members already
   * present ( by primary key or comparator ) are kept once, the relation's own instance
   * winning over the incoming duplicate. Unsaved models compare by reference, so they are
   * always appended. In-memory only; persist with `sync()`.
   *
   * @param dataset - data to add
   * @param callback - function to compare models, if not set it is compared by primary key value
   */
  public static union<R>(dataset: R[], callback?: (a: R, b: R) => boolean) {
    return (datasetB: R[], pKey: string[]) => {
      assertSetOpKeys(pKey, callback);
      const eq = callback ?? pkComparator(pKey);

      const result = [...datasetB];
      for (const item of dataset) {
        if (!result.some((existing) => eq(existing, item))) {
          result.push(item);
        }
      }

      return result;
    };
  }
}

/**
 * Iterable list of populated relation entities
 *
 * It allows to add / remove objects to relation
 */
@NewInstance()
export abstract class Relation<R extends ModelBase<R>, O extends ModelBase<O>, Q extends typeof ModelBase<R> = typeof ModelBase<R>> extends Array<R> implements IRelation<R, O> {
  public TargetModelDescriptor: IModelDescriptor | null;

  public Populated: boolean = false;

  protected Driver: OrmDriver;

  protected Model: Constructor<R> | ForwardRefFunction;

  /**
   * Array methods that derive a new collection ( `splice`, `filter`, `slice`, `concat`,
   * `map`, … ) construct `new this.constructor[Symbol.species](len)` by default. That would
   * call this class's constructor with no relation descriptor, and the very next line
   * dereferences `this.Relation.TargetModel` — so `order.Items.splice(0, 1)` threw
   * `Cannot read properties of undefined (reading 'TargetModel')`.
   *
   * Deriving plain arrays is also the right semantics: a slice of a relation is a list of
   * models, not a relation with an owner.
   */
  static get [Symbol.species]() {
    return Array;
  }

  constructor(protected Owner: O, protected Relation: IRelationDescriptor, objects?: R[]) {
    super();

    if (objects) {
      this.push(...objects);
    }

    this.Model = this.Relation.TargetModel as any; // TODO: fix typings
    this.TargetModelDescriptor = extractModelDescriptor(this.Model);

    if (this.TargetModelDescriptor) {
      this.Driver = DI.resolve<OrmDriver>('OrmConnection', [this.TargetModelDescriptor.Connection]);
    }
  }

  /**
   * The owner-side value this relation joins on.
   *
   * A relation names exactly ONE source column (`IRelationDescriptor.PrimaryKey`), so a
   * composite-key owner must contribute only that column's value. `Owner.PrimaryKeyValue`
   * would be a tuple, which binds an array into a single `?` and fails with
   * `SQLITE_RANGE: column index out of range`.
   *
   * For a single-column key `Relation.PrimaryKey` IS the model's key column, so this returns
   * exactly what `Owner.PrimaryKeyValue` did.
   */
  protected get OwnerJoinValue(): any {
    const key = this.Relation?.PrimaryKey;
    return key ? (this.Owner as any)[key] : this.Owner.PrimaryKeyValue;
  }

  /**
   * Removes all members matching the predicate. In-memory only — the database changes on the
   * next `sync()` ( orphan delete ) or `save()` ( orphan policy ).
   *
   * @param compare - predicate selecting members to remove
   */
  public remove(compare: (a: R) => boolean): R[];

  /**
   * Removes the given model or models, matched by primary key ( an unsaved model, having no
   * key, is matched by reference ). In-memory only — persist with `sync()` / `save()`.
   *
   * @param obj - data to remove
   */
  public remove(obj: R | R[]): R[];
  public remove(obj: R | R[] | ((a: R) => boolean)): R[] {
    let toRemove: R[];

    if (_.isFunction(obj)) {
      toRemove = [...this].filter(obj);
    } else {
      const candidates = Array.isArray(obj) ? obj : [obj];
      const eq = pkComparator(pkColumns(this.TargetModelDescriptor!));
      toRemove = [...this].filter((member) => candidates.some((c) => eq(member, c)));
    }

    this.set((data) => data.filter((d) => !toRemove.includes(d)));

    return toRemove;
  }

  /**
   * Delete all objects from relation ( alias for empty )
   */
  public async clear(): Promise<void> {
    this.empty();
  }

  /**
   * Clears relation data
   */
  public empty() {
    this.length = 0;
  }

  /**
   * Synchronize relation data with db
   * NOTE: it removes data from db that are not in relation
   *
   * @param obj - object to add
   * @param mode - insert mode
   */
  public abstract sync(): Promise<void>;

  /**
   * Updates or ads data to relation
   * It will not delete data from db that are not in relation. It will only update or insert new data.
   * Only dirty models are updated.
   */
  public abstract update(): Promise<void>;

  /**
   * Calculates the intersection between this relation and the provided dataset. Pure
   * computation — apply it with `set()` and persist with `sync()` / `save()`.
   *
   * @param dataset - dataset to compare
   * @param callback - function to compare models, if not set it is compared by primary key value
   * @returns members present in both sets
   */
  public intersection(dataset: R[], callback?: (a: R, b: R) => boolean): R[] {
    return Dataset.intersection(dataset, callback)([...this], pkColumns(this.TargetModelDescriptor!));
  }

  /**
   * Adds the dataset's members to this relation, skipping members already present ( compared
   * by primary key, or by the callback ). In-memory only — nothing is written until `sync()`,
   * `update()` or `save()`.
   *
   * @param dataset - data to add
   * @param callback - function to compare models, if not set it is compared by primary key value
   */
  public union(dataset: R[], callback?: (a: R, b: R) => boolean): void {
    this.set(Dataset.union(dataset, callback)([...this], pkColumns(this.TargetModelDescriptor!)));
  }

  /**
   * Calculates the symmetric difference between this relation and the dataset — members of
   * this relation that are not in the dataset, plus members of the dataset that are not in
   * this relation. Pure computation — apply it with `set()` and persist with `sync()`.
   *
   * @param dataset - data to compare
   * @param callback - function to compare objects, if none provided - primary key value is used
   */
  public diff(dataset: R[], callback?: (a: R, b: R) => boolean): R[] {
    return Dataset.diff(dataset, callback)([...this], pkColumns(this.TargetModelDescriptor!));
  }

  /**
   * Clears the relation and replaces its members with the new dataset ( or with the result of
   * a `Dataset.diff` / `Dataset.intersection` / `Dataset.union` closure ). In-memory only —
   * persist with `sync()` / `update()` / `save()`.
   *
   * @param obj - replacement data, or a closure receiving the current members and the primary key columns
   */
  public set(obj: R[] | ((data: R[], pKey: string[]) => R[])): void {
    const toPush = _.isFunction(obj) ? obj([...this], pkColumns(this.TargetModelDescriptor!)) : obj;
    this.empty();
    this.push(...toPush);
  }

  /**
   * Populates this relation ( loads all data related to owner of this relation)
   */
  public abstract populate(callback?: (this: ISelectQueryBuilder<R[]> & Q['_queryScopes']) => void): Promise<void>;
}

@NewInstance()
export class SingleRelation<R extends ModelBase, O extends ModelBase = ModelBase> {
  public TargetModelDescriptor: IModelDescriptor | null;

  protected Orm: Orm;

  public Value: R | null | undefined;

  public Populated: boolean = false;

  constructor(protected _owner: O, protected model: Constructor<R> | ForwardRefFunction | null, protected Relation: IRelationDescriptor | null, object?: R) {
    this.TargetModelDescriptor = model ? extractModelDescriptor(model) : null;
    this.Orm = DI.get(Orm)!;

    this.Value = object;
  }

  /**
   * Attaches `obj` and persists the owner. One transaction, so the attach and the owner
   * update cannot half-apply. Nested inside a caller's transaction this takes a savepoint.
   */
  public async set(obj: R) {
    await this._owner.driver().transaction(async () => {
      this.attach(obj);
      await this._owner.update();
    });
  }

  /**
   * Points this relation at `obj` and writes the owner's foreign-key column to match: the
   * target's key, or NULL when detaching. No database access.
   *
   * The column is what the snapshot records and what the diff compares, so it has to follow
   * the relation - otherwise a detach would leave column and relation disagreeing and the model
   * dirty forever. An unsaved target has no key yet, so the column holds whatever that empty key
   * reads as ( `undefined`, or `null` once `setDefaults()` has filled it from the column default )
   * until the unit of work inserts the parent and backfills it; `toSql()` reads the key off
   * `Value` at write time either way.
   *
   * @param obj - the related model, or null to clear the relation
   */
  public attach(obj: R | null) {
    this.Value = obj;

    const foreignKey = this.Relation?.ForeignKey;
    if (foreignKey) {
      (this._owner as any)[foreignKey] = obj === null ? null : obj.PrimaryKeyValue;
    }
  }

  public detach() {
    this.attach(null);
  }

  /**
   * Deletes the related row and clears the owner's foreign key. One transaction: these used
   * to be two independent statements, so a throw between them left the owner pointing at a
   * row that no longer exists.
   */
  public async remove() {
    await this._owner.driver().transaction(async () => {
      const val = this.Value;
      this.detach();
      await val?.destroy();
      await this._owner.update();
    });
  }

  /**
   * Loads the model this relation points at.
   *
   * Queries the target table directly, filtered on the column the relation declares as its
   * join key ( `Relation.PrimaryKey` ) — the same column `BelongsToRelation.compile()` joins
   * on for the eager path. It is *not* the target model's own primary key: `@BelongsTo`
   * accepts an explicit third argument for exactly this case, and the two only coincide
   * because the decorator defaults one from the other, which is why filtering on the target
   * PK went unnoticed.
   *
   * @param callback - optional callback applied to the target query
   */
  public async populate(callback?: (this: SelectQueryBuilder<this>) => void): Promise<void> {
    const query = createQuery(this.Relation!.TargetModel, SelectQueryBuilder<ModelBase>).query;
    const targetDescriptor = extractModelDescriptor(this.Relation!.TargetModel);
    const joinColumn = this.Relation!.PrimaryKey || targetDescriptor!.PrimaryKey[0];

    query.where({ [joinColumn]: (this._owner as any)[this.Relation!.ForeignKey] });

    if (callback) {
      callback.apply(query);
    }

    const relColumn = this._owner.ModelDescriptor?.Columns.find((c) => c.Name === this.Relation!.ForeignKey);
    if (relColumn?.Nullable) {
      this.Value = await query.first();
    } else {
      this.Value = await query.firstOrFail();
    }
    this.Populated = true;
    this._owner.snapshotRelation(this.Relation!.Name);
  }
}

export class ManyQueryRelationList<R extends ModelBase, O extends ModelBase> extends Relation<R, O, typeof ModelBase<R>> {
  public remove(_compare: (a: R) => boolean): R[];
  public remove(_obj: R | R[]): R[];
  public remove(_obj: unknown): R[] {
    throw new OrmException('Query relations cannot be removed. This relation is used only for query purposes and it is always populated.');
  }
  public sync(): Promise<void> {
    throw new OrmException('Query relations cannot be synced. This relation is used only for query purposes and it is always populated.');
  }
  public update(): Promise<void> {
    throw new OrmException('Query relations cannot be updated. This relation is used only for query purposes and it is always populated.');
  }
  public intersection(_dataset: R[], _callback?: (a: R, b: R) => boolean): R[] {
    throw new OrmException('Query relations cannot be intersected. This relation is used only for query purposes and it is always populated.');
  }
  public union(_dataset: R[], _callback?: (a: R, b: R) => boolean): void {
    throw new OrmException('Query relations cannot be unioned. This relation is used only for query purposes and it is always populated.');
  }
  public diff(_dataset: R[], _callback?: (a: R, b: R) => boolean): R[] {
    throw new OrmException('Query relations cannot be diffed. This relation is used only for query purposes and it is always populated.');
  }
  public set(_obj: R[] | ((data: R[], pKey: string[]) => R[])): void {
    throw new OrmException('Query relations cannot be set. This relation is used only for query purposes and it is always populated.');
  }
  public populate(_callback?: (this: ISelectQueryBuilder<R[]> & QueryScope) => void): Promise<void> {
    throw new OrmException('Query relations cannot be populated. This relation is used only for query purposes and it is always populated.');
  }
  constructor(owner: O, relation: IRelationDescriptor, objects?: R[]) {
    super(owner, relation, objects);
    this.Populated = true;
  }
}

export class SingleQueryRelation<R extends ModelBase, O extends ModelBase = ModelBase> extends SingleRelation<R, O> {
  constructor(owner: O, object: R) {
    super(owner, null, null, object as R);
    this.Populated = true;
  }
}

@NewInstance()
export class ManyToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T, O, typeof ModelBase<T>> {

  protected junctionModelDescriptor: IModelDescriptor | null;

  constructor(owner: O, relation: IRelationDescriptor, objects?: T[]) {
    super(owner, relation, objects);

    if (relation.JunctionModel) {
      this.junctionModelDescriptor = extractModelDescriptor(this.Relation.JunctionModel);
    }
  }


  /**
  * Deletes from db data that are not in relation
  *
  * @param data relation data
  * @returns
  */
  protected async _dbDiff(data: T[]) {
    // A junction table carries exactly ONE foreign key column per side, so it cannot address
    // a composite target key. Fail loudly rather than delete the wrong rows.
    if (isCompositePk(this.TargetModelDescriptor!)) {
      throw new OrmException(`many-to-many relation ${this.Relation.Name} targets ${this.TargetModelDescriptor!.Name}, which has a composite primary key; a junction table carries one foreign key column per side and cannot address it`);
    }

    const query = this.Driver.del().from(this.junctionModelDescriptor!.TableName).where(this.Relation.JunctionModelSourceModelFKey_Name!, this.OwnerJoinValue);

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    // if we have data in relation, we need to exclude them from delete query.
    // Explicit null/undefined checks — a primary key of 0 or '' is a real key, and dropping
    // it from the keep-list would delete that member's junction row.
    const toDelete = [...data].map((x) => x.PrimaryKeyValue).filter((v) => v !== null && v !== undefined);
    if (toDelete.length !== 0) {
      query.whereNotIn(this.Relation.JunctionModelTargetModelFKey_Name!, toDelete);
    }

    await query;
  }

  /**
    *  Synchronizes relation data to db
    *  Deletes from db entries that are not in relation and adds entries that are not in db
    *  Sets foreign key to relational data
    *
    *  One transaction: the junction upserts and the orphan delete used to be independent
    *  statements. Nested inside a caller's transaction this takes a savepoint.
    */
  public async sync() {
    await this.Driver.transaction(async () => {
      await this._update();
      await this._dbDiff(this);
    });
  }

  /**
   * Adds missing rows to the database without deleting anything: unsaved members are
   * inserted, members without a junction row get one. Existing junction rows are left
   * untouched.
   */
  public async update() {
    await this.Driver.transaction(async () => {
      await this._update();
    });
  }

  /**
   * Finds the junction model's relation pointing at `model`, by constructor identity — the
   * junction's PROPERTY name is the author's choice ( `Order`, `Tag`, … ) and has nothing to
   * do with the target class name.
   */
  protected junctionRelationFor(model: Constructor<ModelBase> | ForwardRefFunction): IRelationDescriptor {
    const relations = Array.from(this.junctionModelDescriptor?.Relations.values() ?? []);
    const found = relations.find((r) => r.TargetModel === model);

    if (!found) {
      throw new OrmException(`junction model ${this.junctionModelDescriptor?.Name} of relation ${this.Relation.Name} declares no relation targeting ${(model as any)?.name}; add a @BelongsTo for it`);
    }

    return found;
  }

  /**
   * The write itself, without a transaction of its own, so `sync()` can share one.
   *
   * Unsaved members are inserted first — a junction row written for a model with no primary
   * key would carry a NULL foreign key. Members that already have a junction row are skipped:
   * the junction's own primary key is auto-generated, so re-inserting the pair would DUPLICATE
   * the link rather than upsert it ( which is exactly what repeated `sync()` calls used to do ).
   */
  protected async _update() {
    const sourceModelRelation = this.junctionRelationFor(this.Owner.constructor as Constructor<ModelBase>);

    const existingQuery = this.Driver.select().from(this.junctionModelDescriptor!.TableName).where(this.Relation.JunctionModelSourceModelFKey_Name!, this.OwnerJoinValue);
    if (this.Driver.Options.Database) {
      existingQuery.database(this.Driver.Options.Database);
    }
    const existingRows = (await existingQuery.asRaw<any[]>()) ?? [];
    const linked = new Set(existingRows.map((r) => r[this.Relation.JunctionModelTargetModelFKey_Name!]).filter((v) => v !== null && v !== undefined));

    for (const f of this) {
      if (f.PrimaryKeyValue === null || f.PrimaryKeyValue === undefined) {
        await f.insert(InsertBehaviour.InsertOrUpdate);
      }

      if (linked.has(f.PrimaryKeyValue)) {
        continue;
      }

      const targetModelRelation = this.junctionRelationFor(f.constructor as Constructor<ModelBase>);

      const junctionEntry = new this.Relation.JunctionModel!();
      (junctionEntry as any)[sourceModelRelation.Name].Value = this.Owner;
      (junctionEntry as any)[targetModelRelation.Name].Value = f;
      await junctionEntry.insert(InsertBehaviour.InsertOrUpdate);
    }
  }

  public async populate<Q extends typeof ModelBase>(callback?: (this: ISelectQueryBuilder<T[]> & Q['_queryScopes']) => void) {
    // Resolved by constructor, not by `TargetModel.name` — the junction's property name is
    // unrelated to the target class name, and class names do not survive minification.
    const targetModelRelation = this.junctionRelationFor(this.Relation.TargetModel);

    const query = (this.Relation.JunctionModel as any).where((this as any).Relation.JunctionModelSourceModelFKey_Name, this.OwnerJoinValue).populate(
      this.Relation.TargetModel, callback
    )

    const result = await query;

    if (result) {
      this.length = 0;

      // A junction row whose target row no longer exists resolves to a null Value — skip it
      // rather than push null into the member list.
      this.push(...result.map((r: any) => r[targetModelRelation.Name].Value).filter((v: any) => v !== null && v !== undefined));
    }

    this.Populated = true;
    this.Owner.snapshotRelation(this.Relation.Name);
  }
}

@NewInstance()
export class OneToManyRelationList<T extends ModelBase, O extends ModelBase> extends Relation<T, O, typeof ModelBase<T>> {
  /**
   * Deletes from db data that are not in relation
   *
   * @param data relation data
   * @returns
   */
  protected async _dbDiff(data: T[]) {
    // A composite key is a tuple and always truthy, so filter on the key COLUMNS being set
    // rather than on the tuple itself.
    const keys = pkColumns(this.TargetModelDescriptor!);
    const toKeep = data
      .map((x) => pkValueOf(x, this.TargetModelDescriptor!))
      .filter((v) => (Array.isArray(v) ? v.every((p) => p !== null && p !== undefined) : v !== null && v !== undefined));

    // A `@SoftDelete` target is never hard-deleted — the same degradation
    // `SubjectExecutor.effectivePolicy` applies to orphans on the save() path. The stamp goes
    // through a model-aware builder so the DateTime passes the column's converter.
    const softDeleteColumn = this.TargetModelDescriptor!.SoftDelete?.DeletedAt;
    if (softDeleteColumn) {
      const { query } = createQuery(this.Relation.TargetModel, UpdateQueryBuilder);
      const update = (query as UpdateQueryBuilder<unknown>).update({ [softDeleteColumn]: DateTime.now() });
      update.where(this.Relation.ForeignKey, this.OwnerJoinValue);
      // Rows stamped by an earlier sync keep their original deletion time.
      update.whereNull(softDeleteColumn);

      if (toKeep.length !== 0 && keys.length !== 0) {
        whereNotAnyPk(update, this.TargetModelDescriptor!, toKeep);
      }

      await update;
      return;
    }

    const query = this.Driver.del().from(this.TargetModelDescriptor!.TableName).where(this.Relation.ForeignKey, this.OwnerJoinValue);

    if (this.Driver.Options.Database) {
      query.database(this.Driver.Options.Database);
    }

    // if we have data in relation, we need to exclude them from the delete query
    if (toKeep.length !== 0 && keys.length !== 0) {
      whereNotAnyPk(query, this.TargetModelDescriptor!, toKeep);
    }

    await query;
  }

  /**
   * Populates this relation ( loads all data related to owner of this relation)
   *
   * Pushes the rows into THIS list rather than routing through `Owner.attach()`: attach flags
   * the owner dirty ( a read must not create unsaved changes ), feeds every sibling relation
   * with the same target model, and drops discriminated subclass rows because their
   * constructor is not the declared target. Only attach's back-reference wiring is kept.
   */
  public async populate<Q extends typeof ModelBase>(callback?: (this: ISelectQueryBuilder<T[]> & Q['_queryScopes']) => void): Promise<void> {
    const query = (this.Relation.TargetModel as any).where(this.Relation.ForeignKey, this.OwnerJoinValue);
    if (callback) {
      callback.apply(query);
    }
    const result = await query;

    if (result) {
      this.length = 0;

      result.forEach((r: ModelBase) => {
        // Set the child's back-reference to this owner, when the child declares one.
        const backRef = [...(r.ModelDescriptor?.Relations.entries() ?? [])].find((e) => e[1].ForeignKey === this.Relation.ForeignKey);
        if (backRef) {
          ((r as any)[backRef[0]] as SingleRelation<ModelBase>).Value = this.Owner;
        }

        this.push(r as T);
      });
    }

    this.Populated = true;
    this.Owner.snapshotRelation(this.Relation.Name);
  }

  /**
   *  Synchronizes relation data to db
   *  Deletes from db entries that are not in relation and adds entries that are not in db
   *  Sets foreign key to relational data
   *
   *  Inserts or updates models that are dirty only.
   *
   *  The whole synchronization is one transaction: the orphan delete used to run as an
   *  independent statement, so a throw between it and the writes left the database
   *  inconsistent with the in-memory graph. Nested inside a caller's transaction this takes
   *  a savepoint rather than opening a second one.
   */
  public async sync() {
    await this.Driver.transaction(async () => {
      await this._update();
      await this._dbDiff(this);
    });
  }

  /**
   * Updates or ads data to relation
   * It will not delete data from db that are not in relation. It will only update or insert new data.
   * Only dirty models are updated.
   */
  public async update() {
    await this.Driver.transaction(async () => {
      await this._update();
    });
  }

  /** The write itself, without a transaction of its own, so `sync()` can share one. */
  protected async _update() {
    // Assign foreign keys BEFORE computing the dirty set. A child re-parented to
    // this owner needs its FK rewritten and persisted; if we snapshot `dirty`
    // first, a previously-clean child keeps its old FK in the DB and a following
    // sync() can delete it as "not belonging" to the new owner.
    this.forEach((d) => {
      (d as any)[this.Relation.ForeignKey] = this.OwnerJoinValue;
    });

    // A fresh model ( never in the database ) is dirty by definition; a loaded one is dirty when
    // the key assignment above - or any other write - moved it away from its snapshot.
    const dirty = this.filter((x) => x.IsDirty);

    for (const f of dirty) {
      await f.insert(InsertBehaviour.InsertOrUpdate);
    }
  }

}
