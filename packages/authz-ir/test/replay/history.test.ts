import 'mocha';
import { expect } from 'chai';
import type { ChangeOp, ChangeRecord } from '@spinajs/authz';

import { sameImage, stateAt } from '../../src/index.js';
import type { KeyInput } from '../../src/index.js';

const T = new Date('2026-11-17T12:00:00.000Z');
const ms = (offset: number): Date => new Date(T.getTime() + offset);
const window = { beforeMs: 6_000, afterMs: 1_000 };
let seq = 0;

function change(op: ChangeOp, offset: number, payload: unknown, before: unknown = null): ChangeRecord {
  return { seq: ++seq, at: ms(offset), kind: 'assignment', op, key: 'k', payload, before, actor: null, traceId: null };
}

function input(k: Partial<KeyInput>): KeyInput {
  return { kind: 'assignment', current: undefined, after: [], since: ms(-3_600_000), window, ...k };
}

const reason = (k: Partial<KeyInput>): string => {
  const s = stateAt(T, input(k));
  if (s.known) throw new Error(`expected a gap, got ${JSON.stringify(s)}`);
  return s.reason;
};

describe('stateAt', () => {
  const a = { role: 'a' };
  const b = { role: 'b' };

  it('undoes the first change after T', () => {
    expect(stateAt(T, input({ current: a, after: [change('add', 60_000, a)] }))).to.deep.include({ known: true, value: undefined, origin: 'history' });
    const removed = change('remove', 60_000, a);
    expect(stateAt(T, input({ current: undefined, after: [removed] }))).to.deep.equal({ known: true, value: a, origin: 'history', seq: removed.seq });
    expect(stateAt(T, input({ current: b, after: [change('put', 60_000, b, a)] }))).to.deep.include({ known: true, value: a });
  });

  it('takes a put without a before-image from the last change before T, and is a gap without one', () => {
    const earlier = change('add', -60_000, a);
    expect(stateAt(T, input({ current: b, before: earlier, after: [change('put', 60_000, b)] }))).to.deep.include({ known: true, value: a });
    expect(reason({ current: b, after: [change('put', 60_000, b)] })).to.match(/put without a before-image/);
  });

  it('answers the current state when nothing changed after T, and a gap when it differs from the last change', () => {
    expect(stateAt(T, input({ current: a }))).to.deep.equal({ known: true, value: a, origin: 'current' });
    expect(stateAt(T, input({ current: a, before: change('add', -60_000, a) }))).to.deep.include({ known: true, value: a, origin: 'current' });
    expect(reason({ current: b, before: change('add', -60_000, a) })).to.match(/differs from its last logged change/);
    expect(reason({ current: a, before: change('remove', -60_000, a) })).to.match(/write outside the changelog/);
  });

  it('is a gap when the changes do not link or the current state is not the last one', () => {
    expect(reason({ current: b, before: change('add', -60_000, a), after: [change('put', 60_000, b, { role: 'x' })] })).to.match(/between seq \d+ and seq \d+/);
    expect(reason({ current: b, after: [change('put', 60_000, b, a), change('put', 120_000, b, { role: 'x' })] })).to.match(/between seq/);
    expect(reason({ current: { role: 'y' }, after: [change('put', 60_000, b, a)] })).to.match(/differs from its last logged change/);
  });

  it('links every change to the state before it by its op, so a write outside the log between two changes is a gap', () => {
    expect(reason({ current: a, before: change('add', -60_000, a), after: [change('add', 60_000, a)] })).to.match(/between seq/);
    expect(reason({ current: undefined, before: change('add', -60_000, a), after: [change('remove', 60_000, b)] })).to.match(/between seq/);
    expect(reason({ current: b, before: change('remove', -60_000, a), after: [change('put', 60_000, b)] })).to.match(/between seq/);
    expect(reason({ current: undefined, before: change('remove', -60_000, a), after: [change('remove', 60_000, a)] })).to.match(/between seq/);
  });

  it('finds no gap in a healthy history that adds, rewrites, removes and adds again', () => {
    const after = [change('put', 60_000, b, a), change('remove', 120_000, b), change('add', 180_000, a), change('remove', 240_000, a, a)];
    expect(stateAt(T, input({ current: undefined, before: change('add', -60_000, a), after }))).to.deep.include({ known: true, value: a });
  });

  it('treats a change inside the asymmetric window as a gap and one just outside as history', () => {
    expect(reason({ current: a, before: change('add', -window.beforeMs, a) })).to.match(/ambiguity window/);
    expect(reason({ current: a, after: [change('add', window.afterMs, a)] })).to.match(/ambiguity window/);
    expect(reason({ current: a, after: [change('add', 1, a)] })).to.match(/ambiguity window/);
    expect(stateAt(T, input({ current: a, before: change('add', -window.beforeMs - 1, a) }))).to.deep.include({ known: true, value: a });
    expect(stateAt(T, input({ current: a, after: [change('add', window.afterMs + 1, a)] }))).to.deep.include({ known: true, value: undefined });
  });

  it('is a gap when coverage starts after T minus the backward side, or nowhere', () => {
    expect(reason({ current: a, since: ms(-window.beforeMs + 1) })).to.match(/history starts at/);
    expect(reason({ current: a, since: T })).to.match(/history starts at/);
    expect(stateAt(T, input({ current: a, since: ms(-window.beforeMs) }))).to.deep.include({ known: true });
    expect(reason({ current: a, since: undefined })).to.match(/nowhere \(not covered\)/);
  });

  it('compares instants inside images at the stored precision', () => {
    const logged = { role: 'a', expiresAt: '2026-12-01T10:00:00.640Z' };
    const stored = { role: 'a', expiresAt: new Date('2026-12-01T10:00:01.000Z') };
    expect(stateAt(T, input({ current: stored, before: change('add', -60_000, logged), precisionMs: 1000 }))).to.deep.include({ known: true, origin: 'current' });
    expect(reason({ current: stored, before: change('add', -60_000, logged) })).to.match(/differs from its last logged change/);
    expect(reason({ current: { role: 'a', expiresAt: '2026-12-01T10:00:02.000Z' }, before: change('add', -60_000, logged), precisionMs: 1000 })).to.match(/differs/);
  });
});

describe('sameImage', () => {
  it('compares JSON structurally, key order aside', () => {
    expect(sameImage({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).to.equal(true);
    expect(sameImage({ a: 1 }, { a: 1, b: 2 })).to.equal(false);
    expect(sameImage({ a: undefined, b: 1 }, { b: 1 })).to.equal(true);
    expect(sameImage([1, 2], [2, 1])).to.equal(false);
    expect(sameImage([1], { 0: 1 })).to.equal(false);
    expect(sameImage(undefined, null)).to.equal(false);
    expect(sameImage(undefined, undefined)).to.equal(true);
  });

  it('never takes values JSON cannot hold for the same', () => {
    expect(sameImage({ m: new Map([[1, 2]]) }, { m: new Map([[1, 3]]) })).to.equal(false);
    expect(sameImage(new Set([1]), new Set([1]))).to.equal(false);
    expect(sameImage({ n: 1n }, { n: 1n })).to.equal(false);
    expect(sameImage({ n: Number.NaN }, { n: null })).to.equal(false);
    expect(sameImage([Number.POSITIVE_INFINITY], [null])).to.equal(false);
    expect(sameImage(new Date(Number.NaN), null)).to.equal(false);
  });

  it('matches instants within the precision only, and other strings exactly', () => {
    expect(sameImage('2026-01-01T00:00:00.001Z', new Date('2026-01-01T00:00:00.001Z'))).to.equal(true);
    expect(sameImage('2026-01-01T00:00:00.001Z', '2026-01-01T00:00:00.002Z')).to.equal(false);
    expect(sameImage('2026-01-01T00:00:00.999Z', '2026-01-01T00:00:00Z', 1000)).to.equal(true);
    expect(sameImage('2026-01-01T00:00:01.000Z', '2026-01-01T00:00:00Z', 1000)).to.equal(false);
    expect(sameImage('2026-01-01', '2026-01-01T00:00:00Z', 1000)).to.equal(false);
  });
});
