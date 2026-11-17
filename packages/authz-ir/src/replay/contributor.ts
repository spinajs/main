import type { ChangeKind, ChangeRecord, Permission, ResourceType } from '@spinajs/authz';

import type { CaveatDef, ObjectRef, OpaqueRef, PolicyIR, RelationDef, RelationName, Rewrite, TupleSubjectRef, TypeName } from '../ir.js';
import type { KeyState } from './history.js';

/** A row a store holds now: its changelog key, its image in the payload shape the store logs, and what it relates. */
export interface CurrentItem<S> {
  key: string;
  image: unknown;
  subject: S;
}

export interface HistoryEdge {
  key: string;
  object: ObjectRef;
  relation: RelationName;
  subject: TupleSubjectRef;
}

/**
 * Rebuilds the relations one store serves at an instant, from its current rows and its changelog kind. Images are
 * plain JSON: a Map, a Set, a bigint or a non-finite number never compares equal, so it makes its key a gap.
 */
export interface HistoryContributor {
  readonly kind: ChangeKind;
  serves(source: RelationDef['source']): boolean;
  /** The coverage type for `column` (the object's type), else undefined. */
  coverageType(object: ObjectRef): ResourceType | undefined;
  /** Rows of `object#relation` now, expired and soft-deleted ones included (liveness at T is `subjectAt`'s). */
  current(object: ObjectRef, relation: RelationName, source: RelationDef['source']): Promise<CurrentItem<TupleSubjectRef>[]>;
  currentReverse(subject: TupleSubjectRef, relation: RelationName, objectType: TypeName, source: RelationDef['source']): Promise<CurrentItem<ObjectRef>[]>;
  /** Decodes a change of this kind into the edges it touches: a column `put` touches the old target and the new one. */
  edges(change: ChangeRecord): readonly HistoryEdge[];
  /** Projects an image to the subject at T, or undefined when not live at T (expiry). */
  subjectAt(image: unknown, at: Date): TupleSubjectRef | undefined;
  /**
   * The change as `stateAt` reads it: payload and before-image in the shape `current` returns (the column kind logs
   * `{ old, new }`), or undefined when it does not touch the item. Default: the change as logged. The op must follow
   * the projected states, as `stateAt` links changes by op: a column `put` from `null` becomes an `add`, one to `null`
   * a `remove` of the old target.
   */
  project?(change: ChangeRecord): ChangeRecord | undefined;
}

export interface StoredPlaceholder {
  model: string;
  store: string;
  permission: Permission;
  side: 'permit' | 'deny';
}

/** A stored item a change touches: the store that holds it, and its changelog key. */
export interface StoredEdge {
  store: string;
  key: string;
}

/** Replaces a `stored:<model>:<store>` placeholder of the config IR with the stored items live at T. */
export interface StoredPolicySplicer {
  readonly kind: 'rule' | 'policy';
  /** The placeholder at `type#relation`, from `parseStoredPolicyName(opaqueName)` and the IR's bindings; undefined when not this splicer's. */
  locate(opaqueName: string, type: TypeName, relation: RelationName, ir: PolicyIR): StoredPlaceholder | undefined;
  current(store: string): Promise<Array<{ key: string; image: unknown }>>;
  /**
   * The item a change touches; a kind's changes come from every store of it, and a store's items are only its own. Every
   * change a splicer's stores log must name its store: one that answers undefined makes every store of the kind a gap.
   */
  edge(change: ChangeRecord): StoredEdge | undefined;
  splice(at: StoredPlaceholder, items: ReadonlyArray<{ key: string; state: KeyState }>, ir: PolicyIR): { term: Rewrite; caveats?: Record<string, CaveatDef>; opaque?: OpaqueRef[] };
}

/** DI token of the history contributors; the packages that register them carry the `@Injectable` decorators. */
export abstract class HistoryContributors implements HistoryContributor {
  abstract readonly kind: ChangeKind;
  abstract serves(source: RelationDef['source']): boolean;
  abstract coverageType(object: ObjectRef): ResourceType | undefined;
  abstract current(object: ObjectRef, relation: RelationName, source: RelationDef['source']): Promise<CurrentItem<TupleSubjectRef>[]>;
  abstract currentReverse(subject: TupleSubjectRef, relation: RelationName, objectType: TypeName, source: RelationDef['source']): Promise<CurrentItem<ObjectRef>[]>;
  abstract edges(change: ChangeRecord): readonly HistoryEdge[];
  abstract subjectAt(image: unknown, at: Date): TupleSubjectRef | undefined;
}

/** DI token of the stored-policy splicers. */
export abstract class StoredPolicySplicers implements StoredPolicySplicer {
  abstract readonly kind: 'rule' | 'policy';
  abstract locate(opaqueName: string, type: TypeName, relation: RelationName, ir: PolicyIR): StoredPlaceholder | undefined;
  abstract current(store: string): Promise<Array<{ key: string; image: unknown }>>;
  abstract edge(change: ChangeRecord): StoredEdge | undefined;
  abstract splice(at: StoredPlaceholder, items: ReadonlyArray<{ key: string; state: KeyState }>, ir: PolicyIR): { term: Rewrite; caveats?: Record<string, CaveatDef>; opaque?: OpaqueRef[] };
}
