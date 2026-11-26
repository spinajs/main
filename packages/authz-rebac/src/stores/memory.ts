import type { PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';

import { TupleCaveatConflict, TupleStore } from '../contracts.js';
import type { Tuple, TupleCaveat, TuplePage, TupleQuery, TupleSubject } from '../contracts.js';
import { caveatKey, isSubjectSet, readTuple, sameCaveat, sameRef, sortKey, subjectKey, tupleKey } from '../keys.js';

/** What one write changed: the tuples it actually added and removed. */
export interface TupleWriteResult {
  readonly version: string;
  readonly added: readonly Tuple[];
  readonly removed: readonly Tuple[];
}

/** Tuples in process memory; every write bumps the version and notifies the `onWrite` listeners. */
export class MemoryTupleStore extends TupleStore {
  readonly name: string = 'memory';
  private readonly tuples = new Map<string, Tuple>();
  private readonly listeners = new Set<(version: string) => void>();
  private revision = 0;

  constructor(initial: readonly Tuple[] = []) {
    super();
    for (const [i, t] of initial.entries()) {
      const tuple = readTuple(t, `initial[${i}]`);
      this.tuples.set(tupleKey(tuple), tuple);
    }
  }

  async read(object: ResourceRef, relation: string): Promise<readonly Tuple[]> {
    return [...this.tuples.values()].filter((t) => t.relation === relation && sameRef(t.object, object)).map(copy);
  }

  async reverse(subject: TupleSubject, relation: string, objectType: ResourceType): Promise<readonly ResourceRef[]> {
    const key = subjectKey(subject);
    const out = new Map<string, ResourceRef>();
    for (const t of this.tuples.values()) if (t.relation === relation && t.object.type === objectType && subjectKey(t.subject) === key) out.set(t.object.id!, { type: t.object.type, id: t.object.id });
    return [...out.values()];
  }

  async write(add: readonly Tuple[], remove: readonly Tuple[], actor: PrincipalRef): Promise<string> {
    return this.writeNow(add, remove, actor).version;
  }

  /**
   * `write` without the promise, telling what it changed; `removed` holds the tuples as stored.
   * @throws TupleCaveatConflict for a stored tuple with another caveat, before anything changes
   */
  writeNow(add: readonly Tuple[], remove: readonly Tuple[], _actor: PrincipalRef): TupleWriteResult {
    const adds = add.map((t, i) => readTuple(t, `add[${i}]`));
    const removes = remove.map((t, i) => readTuple(t, `remove[${i}]`));
    const gone = new Set(removes.map(tupleKey));
    const pending = new Map<string, Tuple>();
    for (const t of adds) {
      const key = tupleKey(t);
      const held = pending.get(key) ?? (gone.has(key) ? undefined : this.tuples.get(key));
      if (held && !sameCaveat(held.caveat, t.caveat)) throw new TupleCaveatConflict(held, t);
      if (!held) pending.set(key, t);
    }
    const added: Tuple[] = [];
    const removed: Tuple[] = [];
    for (const t of removes) {
      const key = tupleKey(t);
      const had = this.tuples.get(key);
      if (had && this.tuples.delete(key)) removed.push(had);
    }
    for (const t of adds) {
      const key = tupleKey(t);
      if (this.tuples.has(key)) continue;
      this.tuples.set(key, t);
      added.push(t);
    }
    const version = String(++this.revision);
    for (const fn of [...this.listeners]) fn(version);
    return { version, added, removed };
  }

  get caveats(): boolean {
    return true;
  }

  async reverseTuples(subjects: readonly TupleSubject[], relation: string, objectType: ResourceType): Promise<readonly Tuple[]> {
    const keys = new Set(subjects.map(subjectKey));
    return [...this.tuples.values()].filter((t) => t.relation === relation && t.object.type === objectType && keys.has(subjectKey(t.subject))).map(copy);
  }

  async caveatsOn(objectType: ResourceType, relation: string, subjects: readonly TupleSubject[]): Promise<readonly TupleCaveat[]> {
    const out = new Map<string, TupleCaveat>();
    for (const t of await this.reverseTuples(subjects, relation, objectType)) if (t.caveat) out.set(caveatKey(t.caveat), t.caveat);
    return [...out.values()];
  }

  has(t: Tuple): boolean {
    return this.tuples.has(tupleKey(readTuple(t)));
  }

  async find(query: TupleQuery, page?: TuplePage): Promise<{ readonly items: readonly Tuple[]; readonly total: number }> {
    const subject = query.subject ? subjectKey(query.subject) : undefined;
    const object = query.object;
    const all = inFindOrder(
      [...this.tuples.values()]
        .filter((t) => !object || (t.object.type === object.type && (object.id == null || t.object.id === object.id)))
        .filter((t) => query.relation === undefined || t.relation === query.relation)
        .filter((t) => subject === undefined || subjectKey(t.subject) === subject),
    );
    const items = page ? all.slice(page.offset, page.offset + page.limit) : all;
    return { items: items.map(copy), total: all.length };
  }

  /** The tuples whose subject is `ref` itself or a subject set of it, in `find` order. */
  async withSubjectObject(ref: ResourceRef): Promise<readonly Tuple[]> {
    if (ref.id == null) return [];
    const about = (t: Tuple): boolean => {
      const s = isSubjectSet(t.subject) ? t.subject.object : t.subject;
      return s.type === ref.type && s.id === ref.id;
    };
    return inFindOrder([...this.tuples.values()].filter(about)).map(copy);
  }

  version(): string {
    return String(this.revision);
  }

  onWrite(fn: (version: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const copy = (t: Tuple): Tuple => structuredClone(t);

const inFindOrder = (tuples: readonly Tuple[]): Tuple[] =>
  tuples
    .map((t) => [sortKey(t), t] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, t]) => t);
