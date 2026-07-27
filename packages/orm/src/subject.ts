/* eslint-disable prettier/prettier */
import { IModelDescriptor, IRelationDescriptor, OrphanPolicy } from './interfaces.js';
import type { ModelBase } from './model.js';

/**
 * What `save()` will do with one model instance.
 *
 * There is no `delete` member: every row `save()` removes is removed because it was detached
 * from a relation, and that is carried by `IOrphanDelta` keyed by primary key rather than by
 * a subject over a model instance the caller no longer holds.
 */
export enum SubjectOperation {
  Insert = 'insert',
  Update = 'update',
  None = 'none',
}

/**
 * A foreign-key column whose value is another model's primary key — which may not exist yet
 * when the subject is built. Resolved by the executor immediately before the statement that
 * needs it.
 */
export interface IPendingForeignKey {
  /** Column on this subject's own row that receives the key. */
  Column: string;
  /** Model whose primary key is the value. */
  Target: ModelBase;
}

/**
 * The membership change of one hasMany relation on one owner, as of the snapshot diff.
 *
 * `Added` are members with no snapshot ( never in the database ). `Kept` are members that
 * were already there or were re-parented in from elsewhere. `RemovedKeys` are primary keys
 * that were in the snapshot and are not in the array any more.
 */
export interface IRelationDelta {
  Descriptor: IRelationDescriptor;
  Added: ModelBase[];
  Kept: ModelBase[];
  RemovedKeys: unknown[];
}

/**
 * Junction rows to create and destroy for one manyToMany relation on one owner.
 * `Added` holds target models because their keys may not exist yet; `RemovedKeys` holds
 * plain keys because those models are gone from the array.
 */
export interface IJunctionDelta {
  Descriptor: IRelationDescriptor;
  JunctionDescriptor: IModelDescriptor;
  Owner: ModelBase;
  Added: ModelBase[];
  RemovedKeys: unknown[];
}

/**
 * Rows detached from a relation and the policy that decides their fate.
 */
export interface IOrphanDelta {
  Descriptor: IRelationDescriptor;
  TargetDescriptor: IModelDescriptor;
  Policy: OrphanPolicy;
  PrimaryKeys: unknown[];
}

/**
 * Renders a primary key for a diagnostic message. A composite key arrives as a tuple; a key
 * with any part missing is not a key at all and reads as `<new>`, the same as an absent one.
 */
function describeKey(pk: unknown): string {
  if (pk === null || pk === undefined) {
    return '<new>';
  }

  if (Array.isArray(pk)) {
    return pk.some((p) => p === null || p === undefined) ? '<new>' : pk.map((p) => String(p)).join(',');
  }

  return String(pk);
}

/**
 * One model instance and everything `save()` needs to know about it.
 */
export class Subject {
  /** Columns that differ from the snapshot. Empty for an insert, which writes everything. */
  public ChangedColumns: string[] = [];

  /** Foreign keys resolved just before this subject's own statement runs. */
  public PendingForeignKeys: IPendingForeignKey[] = [];

  /**
   * Foreign keys that cannot be resolved before this subject's INSERT — a self-referencing
   * cycle — and are applied by a follow-up UPDATE in the update phase instead.
   */
  public DeferredForeignKeys: IPendingForeignKey[] = [];

  /** hasMany membership changes owned by this subject. Read by the orphan resolver. */
  public RelationDeltas: IRelationDelta[] = [];

  /** `Model#key`, or `Model#<new>` before the key exists. Diagnostics only — never a map key. */
  public get Identity(): string {
    return `${this.Descriptor.Name}#${describeKey(this.Model.PrimaryKeyValue)}`;
  }

  constructor(public readonly Model: ModelBase, public readonly Descriptor: IModelDescriptor, public Operation: SubjectOperation) {}
}

/**
 * Everything one `save()` will do, before ordering.
 */
export class SubjectSet {
  public readonly Subjects: Subject[] = [];
  public readonly Junctions: IJunctionDelta[] = [];
  public readonly Orphans: IOrphanDelta[] = [];

  private _byModel = new Map<ModelBase, Subject>();

  /**
   * Registers `subject`, or returns the one already registered for the same model instance.
   * Instance identity is the key — canonicalizing two instances of one row is the identity
   * map's job, and it runs first.
   */
  public add(subject: Subject): Subject {
    const existing = this._byModel.get(subject.Model);
    if (existing) {
      return existing;
    }

    this._byModel.set(subject.Model, subject);
    this.Subjects.push(subject);

    return subject;
  }

  public find(model: ModelBase): Subject | undefined {
    return this._byModel.get(model);
  }

  /** True when this set would emit no statements at all. */
  public get IsEmpty(): boolean {
    return this.Junctions.length === 0 && this.Orphans.length === 0 && this.Subjects.every((s) => s.Operation === SubjectOperation.None);
  }
}
