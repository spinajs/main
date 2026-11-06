import { expect } from 'chai';
import { buildReplayMap, type JournalRecord } from '../src/index.js';

const r = (attempt: number, seq: number, key: string, status: JournalRecord['status'], result: unknown = null): JournalRecord => ({ attempt, seq, key, status, result });

describe('buildReplayMap', () => {
  it('keeps succeeded and skipped records by key', () => {
    const map = buildReplayMap([r(1, 1, 'load#1', 'succeeded', [1]), r(1, 2, 'page#1', 'succeeded', 'p1'), r(1, 3, 'page#2', 'skipped', 'p2'), r(1, 4, 'save#1', 'failed')]);
    expect([...map.entries()]).to.deep.eq([
      ['load#1', [1]],
      ['page#1', 'p1'],
      ['page#2', 'p2'],
    ]);
  });

  it('drops everything from fromKey on', () => {
    const map = buildReplayMap([r(1, 1, 'load#1', 'succeeded', 1), r(1, 2, 'transform#1', 'succeeded', 2), r(1, 3, 'save#1', 'failed')], 'transform#1');
    expect([...map.keys()]).to.deep.eq(['load#1']);
  });

  it('cuts at fromKey only within the latest attempt that reached it', () => {
    const map = buildReplayMap(
      [r(1, 1, 'load#1', 'succeeded', 1), r(1, 2, 'transform#1', 'succeeded', 'old'), r(1, 3, 'save#1', 'succeeded', 3), r(2, 1, 'load#1', 'skipped', 1), r(2, 2, 'transform#1', 'failed')],
      'transform#1',
    );
    expect([...map.entries()]).to.deep.eq([
      ['load#1', 1],
      ['save#1', 3],
    ]);
  });

  it('carries skipped results across attempts', () => {
    const map = buildReplayMap([r(1, 1, 'load#1', 'succeeded', 1), r(1, 2, 'save#1', 'failed'), r(2, 1, 'load#1', 'skipped', 1), r(2, 2, 'save#1', 'failed')]);
    expect([...map.entries()]).to.deep.eq([['load#1', 1]]);
  });

  it('leaves out completed records whose result was not stored', () => {
    const map = buildReplayMap([{ ...r(1, 1, 'secret#1', 'succeeded'), resultStored: false }, { ...r(1, 2, 'prepare#1', 'succeeded'), resultStored: true }, r(1, 3, 'save#1', 'failed')]);
    expect([...map.entries()]).to.deep.eq([['prepare#1', null]]);
  });

  it('ignores running and aborted records and orders by attempt then seq', () => {
    const map = buildReplayMap([r(2, 1, 'a#1', 'succeeded', 'new'), r(1, 2, 'b#1', 'running'), r(1, 1, 'a#1', 'succeeded', 'old'), r(1, 3, 'c#1', 'aborted')]);
    expect([...map.entries()]).to.deep.eq([['a#1', 'new']]);
  });
});
