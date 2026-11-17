import fc from 'fast-check';
import type { ChangeOp, ChangeRecord } from '@spinajs/authz';

import { MemoryTupleSource } from '../../src/index.js';
import type { KeyInput, ObjectRef, PolicyIR, PrincipalFacts, Rewrite, TupleSubjectRef } from '../../src/index.js';
import { GappedSource } from '../fixtures/gapped.js';

// ---- P1: one key's history ----

const BASE = Date.parse('2026-11-17T12:00:00.000Z');
const KEYS = ['k0', 'k1', 'k2'] as const;
type Image = { v: number } | undefined;

export interface ChangeSequence {
  initial: Record<string, Image>;
  changes: ChangeRecord[];
  current: Record<string, Image>;
}

/** Changes that are valid for their key's state (add when absent, put or remove when present), 10 ms apart. */
export function changeSequence(): fc.Arbitrary<ChangeSequence> {
  const initial = fc.tuple(...KEYS.map(() => fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined })));
  const steps = fc.array(fc.record({ key: fc.integer({ min: 0, max: KEYS.length - 1 }), remove: fc.boolean(), v: fc.integer({ min: 0, max: 3 }) }), { maxLength: 12 });
  return fc.tuple(initial, steps).map(([init, plan]) => {
    const state: Record<string, Image> = Object.fromEntries(KEYS.map((k, i) => [k, init[i] === undefined ? undefined : { v: init[i] }]));
    const start = { ...state };
    const changes = plan.map((s, i): ChangeRecord => {
      const key = KEYS[s.key];
      const was = state[key];
      const op: ChangeOp = was === undefined ? 'add' : s.remove ? 'remove' : 'put';
      const now = op === 'remove' ? undefined : { v: s.v };
      state[key] = now;
      return { seq: i + 1, at: new Date(BASE + 10 * (i + 1)), kind: 'tuple', op, key, payload: op === 'remove' ? was : now, before: op === 'put' ? was : null, actor: null, traceId: null };
    });
    return { initial: start, changes, current: state };
  });
}

/** An instant between two changes, never on one. */
export const instantAt = (tIndex: number): Date => new Date(BASE + 10 * tIndex + 5);

export const keysOf = (): readonly string[] => KEYS;

export function foldForward(initial: Image, changes: readonly ChangeRecord[]): Image {
  let state = initial;
  for (const c of changes) state = c.op === 'remove' ? undefined : (c.payload as Image);
  return state;
}

export function keyInput(s: ChangeSequence, key: string, t: Date, o: { beforeImages: boolean; retainBefore: boolean }): KeyInput {
  const own = s.changes.filter((c) => c.key === key).map((c) => (o.beforeImages ? c : { ...c, before: null }));
  const before = own.filter((c) => c.at <= t).at(-1);
  return { kind: 'tuple', current: s.current[key], after: own.filter((c) => c.at > t), ...(o.retainBefore && before ? { before } : {}), since: new Date(BASE - 1000), window: { beforeMs: 2, afterMs: 2 } };
}

// ---- P2: an IR walk over partial reads ----

const user = (id: string): ObjectRef => ({ type: 'user', id });
const members = (id: string): TupleSubjectRef => ({ type: 'group', id, relation: 'member' });
const D1: ObjectRef = { type: 'doc', id: 'd1' };

export interface Tuple {
  object: ObjectRef;
  relation: string;
  subject: TupleSubjectRef;
}

export const CANDIDATES: readonly Tuple[] = [
  ...['u1', 'u2'].map((u) => ({ object: D1, relation: 'editor', subject: user(u) })),
  { object: D1, relation: 'editor', subject: members('g1') },
  ...['u1', 'u2'].map((u) => ({ object: D1, relation: 'banned', subject: user(u) })),
  ...['f1', 'f2'].map((f) => ({ object: D1, relation: 'parent', subject: { type: 'folder', id: f } })),
  ...['f1', 'f2'].flatMap((f) => [...['u1', 'u2'].map((u) => ({ object: { type: 'folder', id: f }, relation: 'viewer', subject: user(u) })), { object: { type: 'folder', id: f }, relation: 'viewer', subject: members('g1') }]),
  ...['u1', 'u2'].map((u) => ({ object: { type: 'group', id: 'g1' }, relation: 'member', subject: user(u) })),
  { object: { type: 'group', id: 'g1' }, relation: 'member', subject: members('g2') },
  { object: { type: 'group', id: 'g2' }, relation: 'member', subject: user('u1') },
];
const READS = [...new Set(CANDIDATES.map((t) => GappedSource.key(t.object, t.relation)))];
const readOf = (t: Tuple): string => GappedSource.key(t.object, t.relation);

const leaf: fc.Arbitrary<Rewrite> = fc.constantFrom<Rewrite>({ computed: 'editor' }, { computed: 'banned' }, { tupleToUserset: { tupleset: 'parent', computed: 'viewer' } });
const rewrite: fc.Arbitrary<Rewrite> = fc.letrec<{ r: Rewrite }>((tie) => ({
  r: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.array(tie('r'), { minLength: 1, maxLength: 3 }).map((u): Rewrite => ({ union: u })),
    fc.array(tie('r'), { minLength: 1, maxLength: 3 }).map((i): Rewrite => ({ intersection: i })),
    fc.tuple(tie('r'), tie('r')).map(([base, subtract]): Rewrite => ({ exclusion: { base, subtract } })),
  ),
})).r;

function irOf(view: Rewrite): PolicyIR {
  const tuples = { kind: 'tuples', store: 't' } as const;
  return {
    version: 1,
    types: {
      user: { relations: {}, permissions: {} },
      group: { relations: { member: { allowed: ['user', 'group#member'], source: tuples } }, permissions: {} },
      folder: { relations: { viewer: { allowed: ['user', 'group#member'], source: tuples } }, permissions: {} },
      doc: {
        relations: { editor: { allowed: ['user', 'group#member'], source: tuples }, banned: { allowed: ['user'], source: tuples }, parent: { allowed: ['folder'], source: tuples } },
        permissions: { view },
      },
    },
    permissions: { 'doc:view': { type: 'doc', relation: 'view', list: false, source: { origin: 'test' } } },
    caveats: {},
    combine: { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: true, delegation: false, ancestry: 'parent', roles: {} },
    opaque: [],
  };
}

export interface World {
  ir: PolicyIR;
  tuples: Tuple[];
  principal: PrincipalFacts;
}

export function irAndTuples(): fc.Arbitrary<World> {
  const principal = fc.record({ id: fc.constantFrom('u1', 'u2'), ceiling: fc.constantFrom(undefined, { resources: [{ type: 'folder', id: 'f1' }] }, { resources: [{ type: 'doc', id: 'd1' }] }) });
  return fc.record({ view: rewrite, tuples: fc.subarray([...CANDIDATES]), principal }).map((w) => ({
    ir: irOf(w.view),
    tuples: w.tuples,
    principal: { type: 'user', id: w.principal.id, ...(w.principal.ceiling ? { ceiling: w.principal.ceiling } : {}) },
  }));
}

/** The partial reads, and which of their stored tuples the history could not establish. */
export function gapSelection(): fc.Arbitrary<{ reads: Set<string>; hidden: Set<number> }> {
  return fc.record({ reads: fc.subarray(READS), hidden: fc.subarray(CANDIDATES.map((_, i) => i)) }).map((g) => ({ reads: new Set(g.reads), hidden: new Set(g.hidden) }));
}

/** Tuples a partial read may have missed: any candidates of the gapped reads. */
export function completion(): fc.Arbitrary<Set<number>> {
  return fc.subarray(CANDIDATES.map((_, i) => i)).map((s) => new Set(s));
}

const sameTuple = (a: Tuple, b: Tuple): boolean => readOf(a) === readOf(b) && a.subject.type === b.subject.type && a.subject.id === b.subject.id && a.subject.relation === b.subject.relation;
const hiddenTuple = (g: { reads: Set<string>; hidden: Set<number> }, t: Tuple): boolean => g.reads.has(readOf(t)) && CANDIDATES.some((c, i) => g.hidden.has(i) && sameTuple(c, t));

function memory(ir: PolicyIR, tuples: readonly Tuple[]): MemoryTupleSource {
  const m = new MemoryTupleSource(ir);
  for (const t of tuples) m.add(t.object, t.relation, t.subject);
  return m;
}

export function gappedSource(w: World, g: { reads: Set<string>; hidden: Set<number> }): GappedSource {
  return new GappedSource(memory(w.ir, w.tuples), g.reads, (object, relation, subject) => hiddenTuple(g, { object, relation, subject }));
}

/** A world the partial view admits: exact outside the gapped reads, the known tuples plus any candidates inside them. */
export function completedSource(w: World, g: { reads: Set<string>; hidden: Set<number> }, fill: Set<number>): MemoryTupleSource {
  const known = w.tuples.filter((t) => !hiddenTuple(g, t));
  const extra = CANDIDATES.filter((t, i) => fill.has(i) && g.reads.has(readOf(t)));
  return memory(w.ir, [...known, ...extra]);
}
// ---- P1, R1 rule: histories with writes that escaped the log ----

export interface EscapedHistory {
  input: KeyInput;
  t: Date;
  truth: Image;
}

/**
 * One key whose writes may escape the log. An escape is either noticed (a `lost` marker moves coverage to it) or comes
 * after a retained logged change of the key, which the links between changes expose. Escapes that restore the state
 * the log last recorded (A→B→A) are invisible to any link (R1), so only those are always noticed. Coverage starts at the
 * latest of a drawn instant, the markers and a retention cutoff, which also drops the changes at or before it. T and
 * the window are drawn so that changes land on and around both window edges.
 */
export function escapedHistory(): fc.Arbitrary<EscapedHistory> {
  const event = fc.record({ logged: fc.boolean(), lost: fc.boolean(), remove: fc.boolean(), v: fc.integer({ min: 0, max: 2 }) });
  return fc
    .record({
      initial: fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
      events: fc.array(event, { maxLength: 8 }),
      since: fc.integer({ min: -30, max: 40 }),
      cutoff: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined, freq: 1 }),
      anchor: fc.integer({ min: 0, max: 5 }),
      shift: fc.integer({ min: -14, max: 14 }),
      beforeMs: fc.integer({ min: 0, max: 12 }),
      afterMs: fc.integer({ min: 0, max: 12 }),
    })
    .map((h) => {
      let state: Image = h.initial === undefined ? undefined : { v: h.initial };
      let since = h.since;
      let retainedLog = false;
      let logged: Image;
      const at = (i: number): number => 10 * (i + 1);
      const tMs = at(h.anchor) + h.shift;
      let truth = state;
      const rows: ChangeRecord[] = [];
      h.events.forEach((e, i) => {
        const was = state;
        const op: ChangeOp = was === undefined ? 'add' : e.remove ? 'remove' : 'put';
        state = op === 'remove' ? undefined : { v: e.v };
        const kept = h.cutoff === undefined || at(i) > h.cutoff;
        if (e.logged) {
          rows.push({ seq: i + 1, at: new Date(BASE + at(i)), kind: 'tuple', op, key: 'k', payload: op === 'remove' ? was : state, before: op === 'put' ? was : null, actor: null, traceId: null });
          retainedLog ||= kept;
          logged = state;
        } else if (e.lost || !retainedLog || JSON.stringify(state) === JSON.stringify(logged)) since = Math.max(since, at(i));
        if (at(i) <= tMs) truth = state;
      });
      if (h.cutoff !== undefined) since = Math.max(since, h.cutoff);
      const t = new Date(BASE + tMs);
      const kept = rows.filter((r) => h.cutoff === undefined || r.at.getTime() - BASE > h.cutoff);
      const before = kept.filter((r) => r.at <= t).at(-1);
      const input: KeyInput = { kind: 'tuple', current: state, after: kept.filter((r) => r.at > t), ...(before ? { before } : {}), since: new Date(BASE + since), window: { beforeMs: h.beforeMs, afterMs: h.afterMs } };
      return { input, t, truth };
    });
}
