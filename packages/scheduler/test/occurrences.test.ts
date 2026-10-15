import { expect } from 'chai';
import { fireTime, jitterFor, parseSpec, scanMissed } from '../src/index.js';

const ms = (iso: string) => Date.parse(iso);

describe('jitter', () => {
  it('stays within 0..jitter, whole seconds, and is deterministic', () => {
    const base = ms('2026-01-05T10:00:00Z');
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const t = base + i * 60_000;
      const j = jitterFor('reconciler', t, 10_000);
      expect(j).to.be.within(0, 10_000);
      expect(j % 1000).to.eq(0);
      expect(jitterFor('reconciler', t, 10_000)).to.eq(j);
      seen.add(j);
    }
    expect(seen.size).to.be.greaterThan(5);
  });

  it('is zero without jitter and shifts the fire time', () => {
    expect(jitterFor('a', 0, 0)).to.eq(0);
    const t = ms('2026-01-05T10:00:00Z');
    expect(fireTime({ name: 'a', jitterMs: 0 }, t)).to.eq(t);
    expect(fireTime({ name: 'a', jitterMs: 5000 }, t)).to.eq(t + jitterFor('a', t, 5000));
  });
});

describe('scanMissed', () => {
  it('counts every occurrence in the window and keeps the last N', () => {
    const spec = parseSpec({ every: '1h' }, 'a');
    const r = scanMissed(spec, ms('2026-01-05T00:00:00Z'), ms('2026-01-05T05:30:00Z'), 2);
    expect(r.total).to.eq(6);
    expect(r.items.map((t) => new Date(t).toISOString())).to.deep.eq(['2026-01-05T04:00:00.000Z', '2026-01-05T05:00:00.000Z']);
    expect(r.last).to.eq(ms('2026-01-05T05:00:00Z'));
  });

  it('stops at the cap', () => {
    const spec = parseSpec({ every: '1s' }, 'a');
    expect(scanMissed(spec, 0, 10_000_000, 1, 100).total).to.eq(100);
  });
});
