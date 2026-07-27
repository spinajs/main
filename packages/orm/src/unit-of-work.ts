/* eslint-disable prettier/prettier */
import { Constructor, DI } from '@spinajs/di';
import { createQuery, SelectQueryBuilder } from './builders.js';
import { extractModelDescriptor } from './descriptor.js';
import { OrmDriver } from './driver.js';
import { OrmException } from './exceptions.js';
import { IdentityMap } from './identity-map.js';
import { IIdentityMap, IModelDescriptor, ISaveOptions, ISaveResult, RelationType } from './interfaces.js';
import type { ModelBase } from './model.js';
import { pkKeyString, whereAnyPk } from './primary-keys.js';
import { snapshotEquals, snapshotFromRow } from './snapshot.js';
import { SubjectBuilder } from './subject-builder.js';
import { SubjectExecutor } from './subject-executor.js';
import { SubjectSorter } from './subject-sorter.js';

/**
 * The `save()` entry point: one transaction, one identity map, one ordered plan.
 */
export class UnitOfWork {
  /**
   * Persists everything reachable from `root` atomically.
   *
   * @param root - the model `save()` was called on
   * @param options - `reload` to diff against current database state; `chunk` to bound the row
   *        count of the statements that ARE batched — junction inserts and the key lists of
   *        orphan statements. It does not apply to model inserts: those run one statement per
   *        row so each generated key can be read back exactly. See {@link ISaveOptions}.
   */
  public static async save(root: ModelBase, options?: ISaveOptions): Promise<ISaveResult> {
    const descriptor = extractModelDescriptor(root.constructor);

    if (!descriptor) {
      throw new OrmException(`model ${root.constructor.name} has no descriptor, use the @Model decorator`);
    }

    const driver = DI.resolve<OrmDriver>('OrmConnection', [descriptor.Connection]);

    if (!driver) {
      throw new OrmException(`model ${descriptor.Name} has invalid connection ${descriptor.Connection}`);
    }

    return await driver.transaction(async () => {
      const identityMap = UnitOfWork.identityMapFor(driver);
      const builder = new SubjectBuilder(identityMap);

      const models = builder.collect(root);
      UnitOfWork.assertSingleConnection(models, descriptor);

      if (options?.reload) {
        await UnitOfWork.reloadSnapshots(models);
      }

      const set = builder.buildFrom(models);
      const plan = new SubjectSorter().sort(set);
      const result = await new SubjectExecutor(options ?? {}).execute(plan);

      UnitOfWork.resnapshotRelations(models);

      return result;
    });
  }

  /**
   * The identity map for this save. Reused across saves inside one transaction so a row
   * touched by two of them is still one object; created fresh otherwise. Nothing survives
   * the transaction ( decision D7 ).
   */
  protected static identityMapFor(driver: OrmDriver): IIdentityMap {
    const ctx = driver.CurrentTransaction;

    if (!ctx) {
      return new IdentityMap();
    }

    if (!ctx.IdentityMap) {
      ctx.IdentityMap = new IdentityMap();
    }

    return ctx.IdentityMap;
  }

  /**
   * A graph spanning two connections cannot be persisted atomically — the transaction only
   * covers one of them. Fail loudly rather than commit half of it.
   */
  protected static assertSingleConnection(models: ModelBase[], root: IModelDescriptor): void {
    for (const model of models) {
      const descriptor = extractModelDescriptor(model.constructor);

      if (descriptor && descriptor.Connection !== root.Connection) {
        throw new OrmException(`save() cannot span connections: ${root.Name} is on connection ${root.Connection} but ${descriptor.Name} is on ${descriptor.Connection}. Save each connection's graph separately.`);
      }
    }
  }

  /**
   * Re-reads every already-persisted model's row and rebases it on the database's current
   * values, batched one SELECT per model class.
   *
   * This is a three-way merge between the hydration baseline, the model, and the row as it
   * stands now. A column the caller edited keeps the caller's value and is rebased so it is
   * written; a column the caller did not touch is reset to the current database value on the
   * model *and* in the baseline, so it drops out of the diff and is not written at all.
   *
   * Moving only the baseline would do the exact opposite of the intent: the model would still
   * hold the stale hydration value, the diff would report `current -> stale`, and the UPDATE
   * would clobber whatever another process wrote. The model has to move too.
   *
   * This is a last-write-wins rebase, not conflict detection: two callers editing the same
   * column still race, and neither is told.
   */
  protected static async reloadSnapshots(models: ModelBase[]): Promise<void> {
    const byConstructor = new Map<Constructor<ModelBase>, ModelBase[]>();

    for (const model of models) {
      // A composite key is a tuple, and a tuple is ALWAYS truthy — check every part.
      const pk = model.PrimaryKeyValue;
      const missing = Array.isArray(pk) ? pk.some((v) => v === null || v === undefined) : pk === null || pk === undefined;

      if (model.Snapshot === null || missing) {
        continue;
      }

      const ctor = model.constructor as Constructor<ModelBase>;
      const list = byConstructor.get(ctor) ?? [];
      list.push(model);
      byConstructor.set(ctor, list);
    }

    for (const [ctor, group] of byConstructor) {
      const descriptor = extractModelDescriptor(ctor)!;
      const { query } = createQuery(ctor, SelectQueryBuilder);

      const select = (query as SelectQueryBuilder<unknown>).select('*');
      whereAnyPk(select, descriptor, group.map((m) => m.PrimaryKeyValue));

      const fresh = (await select.asRaw<Record<string, unknown>[]>()) as Record<string, unknown>[];

      // Index by the flattened key so a composite key matches without a nested scan.
      const byKey = new Map<string, Record<string, unknown>>();
      for (const row of fresh) {
        byKey.set(pkKeyString(row, descriptor), row);
      }

      for (const model of group) {
        const row = byKey.get(pkKeyString(model, descriptor));

        if (!row) {
          // The row is gone. Clearing the snapshot reclassifies the model as an INSERT,
          // which re-creates it rather than emitting an UPDATE that matches nothing.
          model.clearSnapshot();
          continue;
        }

        const baseline = model.Snapshot!.Columns;
        const current = snapshotFromRow(descriptor, row);
        const converterOf = new Map((descriptor.Columns ?? []).map((c) => [c.Name, c.Converter]));

        for (const [name, value] of current) {
          // eslint-disable-next-line security/detect-object-injection
          const callerEdited = !snapshotEquals(baseline.get(name), (model as any)[name], converterOf.get(name));

          if (!callerEdited) {
            // Untouched by this caller: adopt the database's value so it is neither written
            // back stale nor reported as a change.
            // eslint-disable-next-line security/detect-object-injection
            (model as any)[name] = value;
          }

          baseline.set(name, value);
        }
      }
    }
  }

  /**
   * Re-records every populated relation's member keys after a successful save, so a second
   * `save()` on the same graph sees no membership change and emits nothing.
   */
  protected static resnapshotRelations(models: ModelBase[]): void {
    for (const model of models) {
      const descriptor = extractModelDescriptor(model.constructor);
      if (!descriptor) {
        continue;
      }

      for (const [name, relation] of descriptor.Relations) {
        if (relation.Type === RelationType.Query || relation.Type === RelationType.Virtual) {
          continue;
        }

        // eslint-disable-next-line security/detect-object-injection
        const rel = (model as any)[name];

        if (rel?.Populated === true || (relation.Type === RelationType.One && rel?.Value)) {
          model.snapshotRelation(name);
        }
      }
    }
  }
}
