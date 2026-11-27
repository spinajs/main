import fc from 'fast-check';

import type { KeyInput, ReplayChange, ReplayChangeOp } from '../src/index.js';

const BASE = Date.parse('2026-11-17T12:00:00.000Z');
const KEYS = ['k0', 'k1', 'k2'] as const;
type Row = { v: number };
type Image = Row | undefined;

export interface ChangeSequence {
  initial: Record<string, Image>;
  changes: ReplayChange<Row>[];
  current: Record<string, Image>;
}

/** Changes that are valid for their key's state (add when absent, put or remove when present), 10 ms apart. */
export function changeSequence(): fc.Arbitrary<ChangeSequence> {
  const initial = fc.tuple(...KEYS.map(() => fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined })));
  const steps = fc.array(fc.record({ key: fc.integer({ min: 0, max: KEYS.length - 1 }), remove: fc.boolean(), v: fc.integer({ min: 0, max: 3 }) }), { maxLength: 12 });
  return fc.tuple(initial, steps).map(([init, plan]) => {
    const state: Record<string, Image> = Object.fromEntries(KEYS.map((k, i) => [k, init[i] === undefined ? undefined : { v: init[i] }]));
    const start = { ...state };
    const changes = plan.map((s, i): ReplayChange<Row> => {
      const key = KEYS[s.key];
      const was = state[key];
      const op: ReplayChangeOp = was === undefined ? 'add' : s.remove ? 'remove' : 'put';
      const now = op === 'remove' ? undefined : { v: s.v };
      state[key] = now;
      return { entity: 'tuple', key, op, image: (op === 'remove' ? was : now) ?? null, before: op === 'put' ? (was ?? null) : null, at: new Date(BASE + 10 * (i + 1)), seq: i + 1, traceId: null };
    });
    return { initial: start, changes, current: state };
  });
}

/** An instant between two changes, never on one. */
export const instantAt = (tIndex: number): Date => new Date(BASE + 10 * tIndex + 5);

export const keysOf = (): readonly string[] => KEYS;

export function foldForward(initial: Image, changes: readonly ReplayChange<Row>[]): Image {
  let state = initial;
  for (const c of changes) state = c.op === 'remove' ? undefined : (c.image ?? undefined);
  return state;
}

export function keyInput(s: ChangeSequence, key: string, t: Date, o: { beforeImages: boolean; retainBefore: boolean }): KeyInput<Row> {
  const own = s.changes.filter((c) => c.key === key).map((c) => (o.beforeImages ? c : { ...c, before: null }));
  const before = own.filter((c) => c.at <= t).at(-1);
  return { entity: 'tuple', current: s.current[key], after: own.filter((c) => c.at > t), ...(o.retainBefore && before ? { before } : {}), since: new Date(BASE - 1000), window: { beforeMs: 2, afterMs: 2 } };
}

export interface EscapedHistory {
  input: KeyInput<Row>;
  t: Date;
  truth: Image;
}

/**
 * One key whose writes may escape the stream. An escape is either noticed (a `lost` marker moves coverage to it) or
 * comes after a retained recorded change of the key, which the links between changes expose. Escapes that restore the
 * state the stream last recorded (A, B, A) are invisible to any link, so only those are always noticed. Coverage starts
 * at the latest of a drawn instant, the markers and a retention cutoff, which also drops the changes at or before it.
 * T and the window are drawn so that changes land on and around both window edges.
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
      const rows: ReplayChange<Row>[] = [];
      h.events.forEach((e, i) => {
        const was = state;
        const op: ReplayChangeOp = was === undefined ? 'add' : e.remove ? 'remove' : 'put';
        state = op === 'remove' ? undefined : { v: e.v };
        const kept = h.cutoff === undefined || at(i) > h.cutoff;
        if (e.logged) {
          rows.push({ entity: 'tuple', key: 'k', op, image: (op === 'remove' ? was : state) ?? null, before: op === 'put' ? (was ?? null) : null, at: new Date(BASE + at(i)), seq: i + 1, traceId: null });
          retainedLog ||= kept;
          logged = state;
        } else if (e.lost || !retainedLog || JSON.stringify(state) === JSON.stringify(logged)) since = Math.max(since, at(i));
        if (at(i) <= tMs) truth = state;
      });
      if (h.cutoff !== undefined) since = Math.max(since, h.cutoff);
      const t = new Date(BASE + tMs);
      const kept = rows.filter((r) => h.cutoff === undefined || r.at.getTime() - BASE > h.cutoff);
      const before = kept.filter((r) => r.at <= t).at(-1);
      const input: KeyInput<Row> = { entity: 'tuple', current: state, after: kept.filter((r) => r.at > t), ...(before ? { before } : {}), since: new Date(BASE + since), window: { beforeMs: h.beforeMs, afterMs: h.afterMs } };
      return { input, t, truth };
    });
}
