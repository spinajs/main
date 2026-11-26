import 'mocha';
import { expect } from 'chai';

import { MemoryChangeReader } from '../src/testing.js';
import type { ChangeRead, MemoryChange } from '../src/testing.js';

const T = new Date('2026-11-17T12:00:00.000Z');
const ms = (offset: number): Date => new Date(T.getTime() + offset);
const add = (entity: string, key: string, at: Date): MemoryChange => ({ entity, op: 'add', key, image: { key }, at });

describe('MemoryChangeReader', () => {
  it('numbers each entity from 1 and passes images through JSON', async () => {
    const reader = new MemoryChangeReader().append([
      { entity: 'a', op: 'add', key: 'k', image: { due: new Date('2026-01-01T00:00:00.000Z'), gone: undefined }, at: T },
      { entity: 'b', op: 'put', key: 'k', image: { v: 2 }, before: { v: 1 }, at: T, traceId: 'trace-1' },
    ]);
    expect(await reader.afterInstant('a', ms(-1), { limit: 10 })).to.deep.equal([{ entity: 'a', key: 'k', op: 'add', image: { due: '2026-01-01T00:00:00.000Z' }, before: null, at: T, seq: 1, traceId: null }]);
    expect(await reader.afterInstant('b', ms(-1), { limit: 10 })).to.deep.equal([{ entity: 'b', key: 'k', op: 'put', image: { v: 2 }, before: { v: 1 }, at: T, seq: 1, traceId: 'trace-1' }]);
  });

  it('hands out fresh images, so a caller that changes one does not change the store', async () => {
    const reader = new MemoryChangeReader().append([{ entity: 'a', op: 'put', key: 'k', image: { v: 2 }, before: { v: 1 }, at: T }]);
    const [read] = await reader.afterInstant('a', ms(-1), { limit: 10 });
    const [head] = (await reader.latest('a', ['k'])).values();
    for (const image of [read.image, read.before, head.image, head.before]) Object.assign(image ?? {}, { v: 0 });
    expect((await reader.afterInstant('a', ms(-1), { limit: 10 })).map((c) => [c.image, c.before])).to.deep.equal([[{ v: 2 }, { v: 1 }]]);
  });

  it('reads after an instant strictly, above a cursor, and never more than its page size', async () => {
    const reader = new MemoryChangeReader(2).append([0, 1, 2, 3].map((i) => add('a', `k${i}`, ms(i))));
    expect((await reader.afterInstant('a', T, { limit: 10 })).map((c) => c.seq)).to.deep.equal([2, 3]);
    expect((await reader.afterInstant('a', T, { limit: 10, after: 3 })).map((c) => c.seq)).to.deep.equal([4]);
    expect((await reader.afterInstant('a', T, { limit: 1 })).map((c) => c.seq)).to.deep.equal([2]);
    expect(await reader.afterInstant('a', T, { limit: 10, after: 4 })).to.deep.equal([]);
    expect(await reader.afterInstant('b', ms(-1), { limit: 10 })).to.deep.equal([]);
  });

  it('refuses a page size that would answer every read with an empty page', () => {
    for (const size of [0, -1, 1.5, Number.NaN]) expect(() => new MemoryChangeReader(size)).to.throw(RangeError, /page size/);
  });

  it('shows a pending change only after commit', async () => {
    const reader = new MemoryChangeReader();
    const pending = reader.appendPending([add('a', 'k', ms(1))]);
    expect(pending).to.deep.equal([{ entity: 'a', seq: 1 }]);
    expect(await reader.afterInstant('a', T, { limit: 10 })).to.deep.equal([]);
    expect((await reader.latest('a', ['k'])).size).to.equal(0);
    reader.commit(pending);
    expect((await reader.afterInstant('a', T, { limit: 10 })).map((c) => c.key)).to.deep.equal(['k']);
  });

  it('answers the last change of each key, at or before an instant when one is given', async () => {
    const reader = new MemoryChangeReader().append([add('a', 'k', ms(-10)), { entity: 'a', op: 'remove', key: 'k', image: { key: 'k' }, at: ms(10) }, add('a', 'other', ms(-5)), add('b', 'k', ms(-1))]);
    expect([...(await reader.latest('a', ['k', 'other', 'none']))].map(([key, c]) => `${key}#${c.seq}`)).to.deep.equal(['k#2', 'other#3']);
    expect([...(await reader.latest('a', ['k'], T))].map(([key, c]) => `${key}#${c.seq}`)).to.deep.equal(['k#1']);
    expect([...(await reader.latest('a', ['k'], ms(-11)))]).to.deep.equal([]);
  });

  it('prunes at or before the cutoff and moves coverage up to it, never back', async () => {
    const reader = new MemoryChangeReader().cover('a', ms(-60_000)).cover('b', ms(60_000));
    reader.append([add('a', 'x', T), add('a', 'y', ms(1))]);
    reader.prune(T);
    expect((await reader.afterInstant('a', ms(-1), { limit: 10 })).map((c) => c.key)).to.deep.equal(['y']);
    expect(await reader.coveredSince('a')).to.deep.equal(T);
    expect(await reader.coveredSince('b')).to.deep.equal(ms(60_000));
    expect(await reader.coveredSince('never')).to.equal(undefined);
  });

  it('runs beforeRead before every read, with the name of the read', async () => {
    const reader = new MemoryChangeReader();
    const reads: ChangeRead[] = [];
    reader.beforeRead = (read) => void reads.push(read);
    await reader.afterInstant('a', T, { limit: 1 });
    await reader.latest('a', []);
    await reader.coveredSince('a');
    expect(reads).to.deep.equal(['afterInstant', 'latest', 'coveredSince']);
  });
});
