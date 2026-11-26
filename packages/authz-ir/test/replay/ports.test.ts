import 'mocha';
import { expect } from 'chai';

import { MemoryChangeLog, ReplayBudgetExceeded, changeLogKeyState, changeLogReplay, coverageGap, replayBudgetStop, sameImage, stateAt } from '../../src/index.js';
import type { ReplayHistoryView } from '../../src/index.js';

const T = new Date('2026-11-17T12:00:00.000Z');
const ms = (offset: number): Date => new Date(T.getTime() + offset);
const MIN = 60_000;
const limits = { maxChanges: 1000, maxKeys: 1000, window: { beforeMs: 6_000, afterMs: 1_000 }, now: () => T.getTime() + 60 * MIN };

describe('replay ports: the changelog implementation', () => {
  it('loads a history view over the log', async () => {
    const log = new MemoryChangeLog().cover('tuple', ms(-60 * MIN));
    await log.append([
      { kind: 'tuple', op: 'add', key: 'k1', payload: { v: 1 }, at: ms(-30 * MIN) },
      { kind: 'tuple', op: 'remove', key: 'k1', payload: { v: 1 }, at: ms(10 * MIN) },
    ]);
    const view: ReplayHistoryView = await changeLogReplay(log).history(T, ['tuple'], limits);
    expect(view.at).to.equal(T);
    expect(view.kinds).to.deep.equal(['tuple']);
    expect(view.window).to.deep.equal(limits.window);
    expect(view.precisionMs).to.equal(1);
    expect(view.changes).to.equal(1);
    expect(view.afterFor('tuple', 'k1').map((c) => c.seq)).to.deep.equal([2]);
    expect([...view.changesOf('tuple')].map((c) => c.op)).to.deep.equal(['remove']);
    expect((await view.beforeOf('tuple', ['k1'])).get('k1')).to.include({ seq: 1, op: 'add' });
    expect((await view.headOf('tuple', ['k1'])).get('k1')).to.include({ seq: 2 });
    expect(view.keys).to.equal(1);
    expect(await view.since('tuple')).to.deep.equal(ms(-60 * MIN));
  });

  it('hands out the key-state rules of the changelog', () => {
    expect(changeLogKeyState.stateAt).to.equal(stateAt);
    expect(changeLogKeyState.coverageGap).to.equal(coverageGap);
    expect(changeLogKeyState.sameImage).to.equal(sameImage);
    expect(changeLogReplay(new MemoryChangeLog()).keyState).to.equal(changeLogKeyState);
  });

  it('reads a budget stop by its shape, whatever class threw it', () => {
    expect(replayBudgetStop(new ReplayBudgetExceeded('maxKeys', 3))).to.deep.equal({ limit: 'maxKeys', count: 3 });
    expect(replayBudgetStop(Object.assign(new Error('scan stopped'), { limit: 'maxChanges', count: 7 }))).to.deep.equal({ limit: 'maxChanges', count: 7 });
    expect(replayBudgetStop(Object.assign(new Error('other'), { limit: 'maxDepth', count: 7 }))).to.equal(undefined);
    expect(replayBudgetStop(Object.assign(new Error('other'), { limit: 'maxKeys', count: '7' }))).to.equal(undefined);
    expect(replayBudgetStop(new Error('plain'))).to.equal(undefined);
    expect(replayBudgetStop({ limit: 'maxKeys', count: 3 })).to.equal(undefined);
  });
});
