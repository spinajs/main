import { expect } from 'chai';
import { fireTime, nextOccurrence, planOccurrence, ScheduledTask, ScheduleSpec } from '../src/index.js';
import { makeDef } from './support/fixtures.js';

class MisfirePlanTask extends ScheduledTask {}
const at = (iso: string) => Date.parse(iso);
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

describe('planOccurrence', () => {
  it('runs an on-time occurrence (within the threshold)', () => {
    const p = planOccurrence(makeDef('a', { every: '1m' }, MisfirePlanTask), at('2026-01-05T10:01:00Z'), at('2026-01-05T10:01:04Z'));
    expect(p).to.deep.include({ kind: 'run', trigger: 'schedule', skipped: 0 });
    expect(iso(p.next)).to.eq('2026-01-05T10:02:00.000Z');
  });

  it('skip: records one misfire and jumps past now', () => {
    const p = planOccurrence(
      makeDef('a', { every: '1m', misfire: 'skip' }, MisfirePlanTask),
      at('2026-01-05T10:01:00Z'),
      at('2026-01-05T10:10:30Z'),
    );
    expect(p.kind).to.eq('misfire');
    expect(p.skipped).to.eq(10);
    expect(iso(p.next)).to.eq('2026-01-05T10:11:00.000Z');
  });

  it('run-once: runs the latest missed occurrence as catch-up', () => {
    const p = planOccurrence(
      makeDef('a', { every: '1m', misfire: 'run-once' }, MisfirePlanTask),
      at('2026-01-05T10:01:00Z'),
      at('2026-01-05T10:10:30Z'),
    );
    expect(p).to.deep.include({ kind: 'run', trigger: 'catch-up', scheduledAt: at('2026-01-05T10:10:00Z'), skipped: 9 });
    expect(iso(p.next)).to.eq('2026-01-05T10:11:00.000Z');
  });

  it('catch-up(3): runs the last three one after another', () => {
    const def = makeDef('a', { every: '1m', misfire: 'catch-up(3)' }, MisfirePlanTask);
    const p = planOccurrence(def, at('2026-01-05T10:01:00Z'), at('2026-01-05T10:10:30Z'));
    expect(p).to.deep.include({ kind: 'run', trigger: 'catch-up', scheduledAt: at('2026-01-05T10:08:00Z'), skipped: 7 });
    expect(iso(p.next)).to.eq('2026-01-05T10:09:00.000Z');
    const p2 = planOccurrence(def, at('2026-01-05T10:09:00Z'), at('2026-01-05T10:10:40Z'));
    expect(p2).to.deep.include({ scheduledAt: at('2026-01-05T10:09:00Z'), skipped: 0 });
  });

  it('measures lateness from the jittered fire time', () => {
    const def = makeDef('a', { every: '1h', jitter: '10m', misfire: 'skip', misfireThreshold: '5s' }, MisfirePlanTask);
    const nominal = at('2026-01-05T10:00:00Z');
    const fire = fireTime(def, nominal);
    expect(planOccurrence(def, nominal, fire + 5000).kind).to.eq('run');
    expect(planOccurrence(def, nominal, fire + 5001).kind).to.eq('misfire');
  });

  it('plans a missed one-off occurrence', () => {
    const def = makeDef('a', { at: '2026-01-05T10:00:00Z', misfire: 'run-once' }, MisfirePlanTask);
    const p = planOccurrence(def, at('2026-01-05T10:00:00Z'), at('2026-01-06T00:00:00Z'));
    expect(p).to.deep.include({ kind: 'run', trigger: 'catch-up', scheduledAt: at('2026-01-05T10:00:00Z'), skipped: 0, next: null });
  });

  describe('after a long downtime on a cron schedule', () => {
    let calls: number;
    const counting = (spec: ScheduleSpec) =>
      new Proxy(spec, {
        get(target, key) {
          // nextOccurrence reads `kind` once per call
          if (key === 'kind') calls++;
          return Reflect.get(target, key) as unknown;
        },
      });
    const cronDef = (misfire: 'skip' | 'run-once' | 'catch-up(3)') => {
      const def = makeDef('a', { cron: '* * * * *', misfire }, MisfirePlanTask);
      return { ...def, spec: counting(def.spec) };
    };
    const from = at('2026-01-05T10:01:00Z');
    // a year of minutes: 525k occurrences
    const now = at('2027-01-05T10:10:30Z');

    beforeEach(() => (calls = 0));

    it('skip: jumps past now and reports a bounded count', () => {
      const p = planOccurrence(cronDef('skip'), from, now);
      expect(p).to.deep.include({ kind: 'misfire', skippedCapped: true });
      expect(p.skipped).to.be.at.least(100);
      expect(iso(p.next)).to.eq('2027-01-05T10:11:00.000Z');
      expect(calls).to.be.below(200);
    });

    it('run-once: finds the latest missed occurrence without enumerating the window', () => {
      const p = planOccurrence(cronDef('run-once'), from, now);
      expect(p).to.deep.include({ kind: 'run', trigger: 'catch-up', scheduledAt: at('2027-01-05T10:10:00Z'), skippedCapped: true });
      expect(iso(p.next)).to.eq('2027-01-05T10:11:00.000Z');
      expect(calls).to.be.below(300);
    });

    it('catch-up(3): starts with the third-to-last missed occurrence', () => {
      const p = planOccurrence(cronDef('catch-up(3)'), from, now);
      expect(p).to.deep.include({ kind: 'run', trigger: 'catch-up', scheduledAt: at('2027-01-05T10:08:00Z'), skippedCapped: true });
      expect(iso(p.next)).to.eq('2027-01-05T10:09:00.000Z');
      expect(calls).to.be.below(400);
    });

    const warsaw = makeDef('a', { cron: '30 2 * * *', timezone: 'Europe/Warsaw', misfire: 'catch-up(3)' }, MisfirePlanTask);
    const fullScan = (start: number, end: number) => {
      const all: number[] = [];
      for (let t: number | null = start; t !== null && t <= end; t = nextOccurrence(warsaw.spec, t)) all.push(t);
      return all;
    };

    it('finds the same occurrences as a full scan across both DST changes', () => {
      const start = at('2026-03-20T01:30:00Z');
      const end = at('2026-10-27T12:00:00Z');
      const all = fullScan(start, end);
      const p = planOccurrence(warsaw, start, end);
      expect(p).to.deep.include({ scheduledAt: all[all.length - 3], next: all[all.length - 2], skippedCapped: true });
      expect(p.skipped).to.be.below(all.length - 3);
    });

    it('counts exactly when the window is short', () => {
      const start = at('2026-03-20T01:30:00Z');
      const end = at('2026-04-02T12:00:00Z');
      const all = fullScan(start, end);
      const p = planOccurrence(warsaw, start, end);
      expect(p).to.deep.include({ scheduledAt: all[all.length - 3], next: all[all.length - 2], skipped: all.length - 3 });
      expect(p).to.not.have.property('skippedCapped');
    });
  });
});
