import { expect } from 'chai';
import { fireTime, jitterFor } from '../src/index.js';

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
