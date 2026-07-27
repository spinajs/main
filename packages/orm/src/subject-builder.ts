/* eslint-disable prettier/prettier */
import { extractModelDescriptor } from './descriptor.js';
import { identityKey } from './identity-map.js';
import { IIdentityMap, RelationType } from './interfaces.js';
import type { ModelBase } from './model.js';
import { SingleRelation } from './relation-objects.js';
import { IRelationDelta, Subject, SubjectOperation, SubjectSet } from './subject.js';

/**
 * Turns a mutated object graph into a `SubjectSet` — the complete, unordered description of
 * what one `save()` must do.
 *
 * Traversal rules:
 *
 * - a `belongsTo` is followed whenever its `Value` is set, populated or not, because
 *   attaching a model to it is an explicit act;
 * - a `hasMany` or `manyToMany` is followed **only when `Populated` is true**, so a relation
 *   the caller never loaded is invisible and `Items: OrderItem[] = []` on a freshly
 *   constructed model deletes nothing;
 * - `Query` and `Virtual` relations are read-only projections and are never followed.
 */
export class SubjectBuilder {
  private _visited = new Set<ModelBase>();

  constructor(protected identityMap: IIdentityMap) {}

  public build(root: ModelBase): SubjectSet {
    return this.buildFrom(this.collect(root));
  }

  /**
   * Walks the graph breadth-first from `root`, canonicalizing every model through the
   * identity map so a row reached by two paths yields one instance.
   *
   * @param root - the model `save()` was called on
   */
  public collect(root: ModelBase): ModelBase[] {
    this._visited = new Set<ModelBase>();

    const ordered: ModelBase[] = [];
    const queue: ModelBase[] = [this.identityMap.add(root) as ModelBase];

    while (queue.length > 0) {
      const model = queue.shift()!;

      if (this._visited.has(model)) {
        continue;
      }

      this._visited.add(model);
      ordered.push(model);

      for (const related of this.relatedOf(model)) {
        const canonical = this.identityMap.add(related) as ModelBase;
        if (!this._visited.has(canonical)) {
          queue.push(canonical);
        }
      }
    }

    return ordered;
  }

  /**
   * Models directly reachable from `model` under the traversal rules.
   */
  protected relatedOf(model: ModelBase): ModelBase[] {
    const descriptor = extractModelDescriptor(model.constructor);
    if (!descriptor) {
      return [];
    }

    const out: ModelBase[] = [];

    for (const [name, relation] of descriptor.Relations) {
      // eslint-disable-next-line security/detect-object-injection
      const value = (model as any)[name];
      if (value === null || value === undefined) {
        continue;
      }

      switch (relation.Type) {
        case RelationType.One:
          if (value instanceof SingleRelation && value.Value) {
            out.push(value.Value as ModelBase);
          }
          break;

        case RelationType.Many:
        case RelationType.ManyToMany:
          if (value.Populated === true) {
            out.push(...[...(value as Iterable<ModelBase>)]);
          }
          break;

        case RelationType.Query:
        case RelationType.Virtual:
        default:
          break;
      }
    }

    return out;
  }

  /**
   * Diffs each collected model against its snapshot and records its `belongsTo` foreign keys.
   * hasMany, manyToMany and orphan handling are layered on by later passes.
   *
   * @param models - output of `collect()`
   */
  public buildFrom(models: ModelBase[]): SubjectSet {
    const set = new SubjectSet();

    for (const model of models) {
      const descriptor = extractModelDescriptor(model.constructor);
      if (!descriptor) {
        continue;
      }

      const subject = new Subject(model, descriptor, classify(model));

      // Only an UPDATE needs a column list: an INSERT writes every column, and a no-op
      // writes none. Reading the diff again here is cheap and keeps `classify` pure.
      if (subject.Operation === SubjectOperation.Update) {
        subject.ChangedColumns = model.changedColumns();
      }

      set.add(subject);
    }

    for (const subject of set.Subjects) {
      this.buildBelongsTo(subject);
      this.buildHasMany(subject, set);
    }

    return set;
  }

  /**
   * Records, for every `belongsTo` with a `Value`, that this subject's foreign-key column
   * takes the target's primary key. The value is *not* read here — the target may not have
   * been inserted yet; the executor resolves it immediately before the statement.
   */
  protected buildBelongsTo(subject: Subject): void {
    for (const [name, relation] of subject.Descriptor.Relations) {
      if (relation.Type !== RelationType.One) {
        continue;
      }

      // eslint-disable-next-line security/detect-object-injection
      const rel = (subject.Model as any)[name];
      if (!(rel instanceof SingleRelation) || !rel.Value) {
        continue;
      }

      subject.PendingForeignKeys.push({ Column: relation.ForeignKey, Target: rel.Value as ModelBase });
    }
  }

  /**
   * Diffs each populated `hasMany` on `subject` against the owner's relation snapshot and
   * records the owner's foreign key as pending on every member that stays.
   *
   * A relation with `Populated === false` is skipped entirely — that is the anti-footgun
   * guarantee, and it is why a freshly constructed model with `Items: OrderItem[] = []`
   * deletes nothing.
   *
   * Both new *and* kept members get the pending foreign key. That is what makes re-parenting
   * work: a clean child moved to another owner has its key rewritten and is promoted from a
   * no-op to an UPDATE, instead of keeping its old owner id in the database ( B20 ).
   */
  protected buildHasMany(subject: Subject, set: SubjectSet): void {
    for (const [name, relation] of subject.Descriptor.Relations) {
      if (relation.Type !== RelationType.Many) {
        continue;
      }

      // eslint-disable-next-line security/detect-object-injection
      const rel = (subject.Model as any)[name];
      if (!rel || rel.Populated !== true) {
        continue;
      }

      const members = [...(rel as Iterable<ModelBase>)];
      const snapshotKeys = subject.Model.Snapshot?.Relations.get(name) ?? [];
      const presentKeys = new Set(members.map((m) => identityKey(m.PrimaryKeyValue)).filter((k) => k !== null));

      const delta: IRelationDelta = {
        Descriptor: relation,
        Added: members.filter((m) => m.Snapshot === null),
        Kept: members.filter((m) => m.Snapshot !== null),
        RemovedKeys: snapshotKeys.filter((k) => !presentKeys.has(identityKey(k)!)),
      };

      subject.RelationDeltas.push(delta);

      for (const member of members) {
        const memberSubject = set.find(member);
        if (memberSubject) {
          memberSubject.PendingForeignKeys.push({ Column: relation.ForeignKey, Target: subject.Model });
        }
      }
    }
  }
}

/**
 * `Insert` when the model has never been hydrated from the database, `Update` when its
 * snapshot diff is non-empty, `None` otherwise.
 *
 * Deliberately not keyed on the primary key: `setDefaults()` pre-fills @Uuid keys on
 * construction, so a brand-new UUID-keyed model already has one.
 */
function classify(model: ModelBase): SubjectOperation {
  if (model.Snapshot === null) {
    return SubjectOperation.Insert;
  }

  return model.changedColumns().length > 0 ? SubjectOperation.Update : SubjectOperation.None;
}
