/* eslint-disable prettier/prettier */
import { OrmException } from './exceptions.js';
import type { ModelBase } from './model.js';
import { IJunctionDelta, IOrphanDelta, IPendingForeignKey, Subject, SubjectOperation, SubjectSet } from './subject.js';

/**
 * Raised when the insert order cannot be satisfied because two or more rows reference each
 * other through non-deferrable foreign keys.
 */
export class OrmCycleException extends OrmException {}

/**
 * A `SubjectSet` in execution order.
 */
export interface ISortedPlan {
  /** Insert subjects, every parent before every child that references it. */
  Inserts: Subject[];
  /** Update subjects, followed by insert subjects carrying deferred foreign keys. */
  Updates: Subject[];
  Junctions: IJunctionDelta[];
  /** Orphan actions, children before parents. */
  Orphans: IOrphanDelta[];
}

export class SubjectSorter {
  /**
   * Orders a subject set for execution.
   *
   * @param set - output of `SubjectBuilder.build()`
   * @throws OrmCycleException when a non-self-referencing foreign-key cycle makes the order
   *         unsatisfiable
   */
  public sort(set: SubjectSet): ISortedPlan {
    const inserts = set.Subjects.filter((s) => s.Operation === SubjectOperation.Insert);
    const ordered = this.order(inserts);

    const deferred = ordered.filter((s) => s.DeferredForeignKeys.length > 0);

    // `None` subjects that carry a pending foreign key are candidates for promotion: a clean
    // child re-parented to another owner in this graph classifies as `None` ( its columns match
    // its snapshot ) and only becomes an UPDATE once the executor writes the new owner key onto
    // it and re-reads the diff. Excluding them here would lose the move entirely.
    //
    // Including them is safe and cheap: `SubjectExecutor.updatePayload` returns null — and the
    // executor emits nothing — for any subject whose diff is still empty afterwards.
    const updates = set.Subjects.filter((s) => s.Operation === SubjectOperation.Update || (s.Operation === SubjectOperation.None && s.PendingForeignKeys.length > 0)).concat(deferred);

    return {
      Inserts: ordered,
      Updates: updates,
      Junctions: set.Junctions,
      Orphans: this.orderOrphans(set.Orphans, ordered),
    };
  }

  /**
   * Kahn's algorithm over the insert subjects. Stable: the ready queue is seeded and refilled
   * in the subjects' own order, so a dependency-free graph comes out exactly as it went in.
   */
  protected order(inserts: Subject[]): Subject[] {
    const byModel = new Map<ModelBase, Subject>();
    for (const s of inserts) {
      byModel.set(s.Model, s);
    }

    const remaining = new Set<Subject>(inserts);
    const output: Subject[] = [];

    for (;;) {
      const dependencies = this.dependencies(remaining, byModel);
      const ready = inserts.filter((s) => remaining.has(s) && dependencies.get(s)!.size === 0);

      if (ready.length === 0) {
        if (remaining.size === 0) {
          return output;
        }

        if (!this.deferSelfReferences(remaining, byModel)) {
          const names = [...remaining].map((s) => s.Descriptor.Name);
          throw new OrmCycleException(`cannot order INSERTs: foreign-key cycle between models ${[...new Set(names)].join(' -> ')}. Break the cycle by saving one side first, or make one of the foreign keys deferrable by pointing it at the same model.`);
        }

        continue;
      }

      for (const s of ready) {
        output.push(s);
        remaining.delete(s);
      }

      if (remaining.size === 0) {
        return output;
      }
    }
  }

  /** For each remaining subject, the remaining subjects it must follow. */
  protected dependencies(remaining: Set<Subject>, byModel: Map<ModelBase, Subject>): Map<Subject, Set<Subject>> {
    const map = new Map<Subject, Set<Subject>>();

    for (const s of remaining) {
      const deps = new Set<Subject>();

      for (const fk of s.PendingForeignKeys) {
        const target = byModel.get(fk.Target);
        if (target && target !== s && remaining.has(target)) {
          deps.add(target);
        }
      }

      map.set(s, deps);
    }

    return map;
  }

  /**
   * Breaks a cycle by deferring the foreign keys that point at the *same model* — a
   * self-referencing hierarchy, which is a cycle between models but not between rows.
   * The row is inserted without the column and a follow-up UPDATE sets it.
   *
   * @returns true when at least one foreign key was deferred, i.e. progress is possible
   */
  protected deferSelfReferences(remaining: Set<Subject>, byModel: Map<ModelBase, Subject>): boolean {
    let progress = false;

    for (const s of remaining) {
      const keep: IPendingForeignKey[] = [];

      for (const fk of s.PendingForeignKeys) {
        const target = byModel.get(fk.Target);
        const cyclic = target !== undefined && remaining.has(target);
        const selfReferencing = target !== undefined && target.Descriptor.TableName === s.Descriptor.TableName;

        if (cyclic && selfReferencing) {
          s.DeferredForeignKeys.push(fk);
          progress = true;
          continue;
        }

        keep.push(fk);
      }

      s.PendingForeignKeys = keep;
    }

    return progress;
  }

  /**
   * Children before parents, so a DELETE never strands a foreign key. A model that does not
   * appear in the insert order at all keeps its relative position at the front.
   */
  protected orderOrphans(orphans: IOrphanDelta[], inserts: Subject[]): IOrphanDelta[] {
    const rank = new Map<string, number>();
    inserts.forEach((s, i) => {
      if (!rank.has(s.Descriptor.TableName)) {
        rank.set(s.Descriptor.TableName, i);
      }
    });

    return [...orphans].sort((a, b) => (rank.get(b.TargetDescriptor.TableName) ?? -1) - (rank.get(a.TargetDescriptor.TableName) ?? -1));
  }
}
