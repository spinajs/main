import { AuthzConfigError } from '@spinajs/authz';
import type { ChangeRecord, ReplayRead, ResourceType } from '@spinajs/authz';

import { objectLabel, subjectLabel } from '../eval/check.js';
import type { TupleSource } from '../eval/evaluator.js';
import type { ObjectRef, PolicyIR, RelationDef, RelationName, TupleSubjectRef, TypeDef, TypeName } from '../ir.js';
import type { CurrentItem, HistoryContributor, HistoryEdge } from './contributor.js';
import { TupleSourceGap } from './gap.js';
import { coverageGap, stateAt } from './history.js';
import type { KeyState } from './history.js';
import type { ReplayHistory } from './history-scan.js';

interface Candidate<T> {
  image: unknown;
  carrier: T;
}

interface Resolved<T> {
  present: Array<{ value: unknown; carrier: T }>;
  gaps: ReplayRead[];
}

const sameSubject = (a: TupleSubjectRef, b: TupleSubjectRef): boolean => a.type === b.type && a.id === b.id && a.relation === b.relation;

/**
 * The relationships as they were at `at`, rebuilt per key from current rows and the changelog (section 3.3 of the L3
 * plan). A read whose history is incomplete for any candidate key throws `TupleSourceGap` with the subjects it could
 * establish; `reads` records every key resolved and where its state came from.
 */
export class HistoricalTupleSource implements TupleSource {
  readonly reads: ReplayRead[] = [];

  constructor(
    private readonly ir: PolicyIR,
    private readonly at: Date,
    private readonly contributors: readonly HistoryContributor[],
    private readonly history: ReplayHistory,
  ) {
    const unscanned = contributors.find((c) => !history.kinds.includes(c.kind));
    if (unscanned !== undefined) throw new AuthzConfigError(`HistoricalTupleSource: the history was loaded without the ${unscanned.kind} changes a contributor reads`);
  }

  async *read(object: ObjectRef, relation: RelationName): AsyncIterable<TupleSubjectRef> {
    for (const s of await this.subjects(object, relation, this.relationDef(object.type, relation))) yield s;
  }

  async *reverse(subject: TupleSubjectRef, relation: RelationName, objectType: TypeName): AsyncIterable<ObjectRef> {
    const label = `${objectType}#${relation}@${subjectLabel(subject)}`;
    const { c, source } = this.served(this.relationDef(objectType, relation), label);
    const parts = c.parts?.(objectType, relation, source);
    if (parts !== undefined) {
      const u = await this.union(
        parts.map((p) => async () => {
          const out: ObjectRef[] = [];
          for await (const o of this.reverse(subject, p, objectType)) out.push(o);
          return out;
        }),
        () => [],
      );
      if (u.gaps.length > 0) throw new TupleSourceGap([], u.gaps);
      for (const o of u.found) yield o;
      return;
    }
    const r = await this.resolve(
      c,
      label,
      source,
      () => c.currentReverse(subject, relation, objectType, source),
      (e) => (e.relation === relation && e.object.type === objectType && sameSubject(e.subject, subject) ? e.object : undefined),
      c.coverageType({ type: objectType, id: '*' }),
      // A key that points at another subject now (a moved column) is not absent: read its row where it points.
      async (missing) => {
        const byObject = new Map<string, { object: ObjectRef; keys: Set<string> }>();
        for (const [key, object] of missing) {
          const group = byObject.get(objectLabel(object)) ?? { object, keys: new Set<string>() };
          group.keys.add(key);
          byObject.set(objectLabel(object), group);
        }
        const images = new Map<string, unknown>();
        // One read per object: a contributor reads current rows per object.
        for (const { object, keys } of byObject.values()) for (const i of await c.current(object, relation, source)) if (keys.has(i.key)) images.set(i.key, i.image);
        return images;
      },
    );
    const objects = r.present.filter((p) => this.liveSubject(c, p.value, subject)).map((p) => p.carrier);
    if (r.gaps.length > 0) throw new TupleSourceGap([], r.gaps);
    for (const o of objects) yield o;
  }

  async column(model: string, column: string, object: ObjectRef): Promise<ObjectRef | undefined> {
    const found = Object.entries(this.typeDef(object.type)?.relations ?? {}).find(([, d]) => d.source.kind === 'column' && d.source.model === model && d.source.column === column);
    const subjects = await this.subjects(object, found?.[0] ?? `${model}.${column}`, found?.[1]);
    return subjects.length === 0 ? undefined : { type: subjects[0].type, id: subjects[0].id };
  }

  private async subjects(object: ObjectRef, relation: RelationName, def: RelationDef | undefined): Promise<TupleSubjectRef[]> {
    const label = `${objectLabel(object)}#${relation}`;
    const { c, source } = this.served(def, label);
    const parts = c.parts?.(object.type, relation, source);
    if (parts !== undefined) {
      const u = await this.union(
        parts.map((p) => () => this.subjects(object, p, this.relationDef(object.type, p))),
        (e) => e.known,
      );
      if (u.gaps.length > 0) throw new TupleSourceGap(u.found, u.gaps);
      return u.found;
    }
    const r = await this.resolve(
      c,
      label,
      source,
      () => c.current(object, relation, source),
      (e) => (e.relation === relation && e.object.type === object.type && e.object.id === object.id ? e.subject : undefined),
      c.coverageType(object),
    );
    const known = r.present.map((p) => c.subjectAt(p.value, this.at)).filter((s): s is TupleSubjectRef => s !== undefined);
    if (r.gaps.length > 0) throw new TupleSourceGap(known, r.gaps);
    return known;
  }

  /** Every part read in turn; a part's gap keeps what that part established, and makes the union partial. */
  private async union<T>(parts: ReadonlyArray<() => Promise<T[]>>, partial: (e: TupleSourceGap) => readonly T[]): Promise<{ found: T[]; gaps: ReplayRead[] }> {
    const out = { found: [] as T[], gaps: [] as ReplayRead[] };
    for (const read of parts) {
      try {
        out.found.push(...(await read()));
      } catch (e) {
        if (!(e instanceof TupleSourceGap)) throw e;
        out.found.push(...partial(e));
        out.gaps.push(...e.gaps);
      }
    }
    return out;
  }

  private typeDef(type: TypeName): TypeDef | undefined {
    return Object.entries(this.ir.types).find(([t]) => t === type)?.[1];
  }

  private relationDef(type: TypeName, relation: RelationName): RelationDef | undefined {
    return Object.entries(this.typeDef(type)?.relations ?? {}).find(([r]) => r === relation)?.[1];
  }

  private served(def: RelationDef | undefined, label: string): { c: HistoryContributor; source: RelationDef['source'] } {
    const c = def === undefined ? undefined : this.contributors.find((x) => x.serves(def.source));
    if (c !== undefined && def !== undefined) return { c, source: def.source };
    const reason = `no history contributor serves ${label}`;
    this.reads.push({ key: label, origin: 'gap', reason });
    throw new TupleSourceGap([], [{ key: label, origin: 'gap', reason }]);
  }

  private liveSubject(c: HistoryContributor, image: unknown, subject: TupleSubjectRef): boolean {
    const s = c.subjectAt(image, this.at);
    return s !== undefined && sameSubject(s, subject);
  }

  /** Current rows, then the tail of the scan, then each key's head, its change before T and the coverage, in that order (3.2). */
  private async resolve<T>(c: HistoryContributor, label: string, source: RelationDef['source'], current: () => Promise<CurrentItem<T>[]>, match: (e: HistoryEdge) => T | undefined, type: ResourceType | undefined, elsewhere?: (missing: ReadonlyMap<string, T>) => Promise<ReadonlyMap<string, unknown>>): Promise<Resolved<T>> {
    for (let attempt = 0; ; attempt++) {
      const now = await current();
      await this.history.catchUp();
      const candidates = new Map<string, Candidate<T>>();
      for (const e of this.history.edges(c.kind, (ch) => c.edges(ch))) {
        const carrier = match(e);
        if (carrier !== undefined && !candidates.has(e.key)) candidates.set(e.key, { image: undefined, carrier });
      }
      for (const item of now) candidates.set(item.key, { image: item.image, carrier: item.subject });
      if (elsewhere !== undefined) await this.fillElsewhere(c, candidates, new Set(now.map((i) => i.key)), elsewhere);
      const keys = [...candidates.keys()];
      const heads = await this.history.headOf(c.kind, keys);
      const befores = await this.history.beforeOf(c.kind, keys);
      // Before `since`: a boot that restarts the type writes its new fingerprint and its new `since` in one statement.
      const distrusted = await c.coverageGap?.(type);
      const since = await this.history.since(c.kind, type);
      const uncovered = distrusted ?? coverageGap(this.at, c.kind, since, this.history.window);
      if (uncovered !== undefined) {
        const read: ReplayRead = { kind: c.kind, key: type === undefined ? label : `${c.kind}:${type}`, origin: 'gap', reason: uncovered };
        this.reads.push(read);
        return { present: [], gaps: [read] };
      }
      const moved = keys.filter((k) => {
        const head = heads.get(k);
        const after = this.history.afterFor(c.kind, k);
        return head !== undefined && head.seq > Math.max(after.at(-1)?.seq ?? -Infinity, befores.get(k)?.seq ?? -Infinity);
      });
      if (moved.length > 0 && attempt === 0) continue;
      return this.settle(c, source, candidates, befores, since, new Set(moved));
    }
  }

  private async fillElsewhere<T>(c: HistoryContributor, candidates: ReadonlyMap<string, Candidate<T>>, current: ReadonlySet<string>, elsewhere: (missing: ReadonlyMap<string, T>) => Promise<ReadonlyMap<string, unknown>>): Promise<void> {
    const missing = new Map([...candidates].filter(([k]) => !current.has(k)).map(([k, cand]): [string, T] => [k, cand.carrier]));
    if (missing.size === 0) return;
    this.history.reserve(c.kind, [...missing.keys()]);
    const images = await elsewhere(missing);
    for (const [k, cand] of candidates) if (images.has(k)) cand.image = images.get(k);
  }

  private settle<T>(c: HistoryContributor, source: RelationDef['source'], candidates: ReadonlyMap<string, Candidate<T>>, befores: ReadonlyMap<string, ChangeRecord>, since: Date | undefined, moved: ReadonlySet<string>): Resolved<T> {
    const out: Resolved<T> = { present: [], gaps: [] };
    // By key, so a replay walks subjects in the same order whatever the order of the writes that led to them.
    for (const [key, cand] of [...candidates].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const state = moved.has(key) ? ({ known: false, reason: `${c.kind} ${key} changed during the replay` } as const) : this.stateOf(c, source, key, cand.image, befores.get(key), since);
      if (!state.known) {
        const read: ReplayRead = { kind: c.kind, key, origin: 'gap', reason: state.reason };
        this.reads.push(read);
        out.gaps.push(read);
        continue;
      }
      this.reads.push({ kind: c.kind, key, origin: state.origin, ...(state.seq === undefined ? {} : { seq: state.seq }) });
      if (state.value !== undefined) out.present.push({ value: state.value, carrier: cand.carrier });
    }
    return out;
  }

  /**
   * The window is checked on the key's last change before T as logged: a projection that drops it (another column of a
   * shared key) would also hide the window from the changes of this item it covers.
   */
  private stateOf(c: HistoryContributor, source: RelationDef['source'], key: string, current: unknown, before: ChangeRecord | undefined, since: Date | undefined): KeyState {
    const w = this.history.window;
    if (before !== undefined && before.at.getTime() >= this.at.getTime() - w.beforeMs && before.at.getTime() <= this.at.getTime() + w.afterMs) {
      return { known: false, reason: `change seq ${before.seq} at ${before.at.toISOString()} is within the ambiguity window of the decision` };
    }
    const project = (ch: ChangeRecord | undefined): ChangeRecord | undefined => (ch === undefined || c.project === undefined ? ch : c.project(ch, source));
    const after = this.history
      .afterFor(c.kind, key)
      .map(project)
      .filter((ch): ch is ChangeRecord => ch !== undefined);
    return stateAt(this.at, { kind: c.kind, current, after, before: project(before), since, window: w, precisionMs: this.history.precisionMs });
  }
}
