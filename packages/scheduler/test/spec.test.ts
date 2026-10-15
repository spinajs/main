import { expect } from 'chai';
import { DateTime, Settings } from 'luxon';
import { InvalidArgument } from '@spinajs/exceptions';
import { describeSpec, nextOccurrence, parseSpec, ScheduleSpec } from '../src/index.js';

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

function occurrences(spec: ScheduleSpec, fromIso: string, toIso: string): number[] {
  const out: number[] = [];
  let t = nextOccurrence(spec, ms(fromIso));
  while (t !== null && t <= ms(toIso)) {
    out.push(t);
    t = nextOccurrence(spec, t);
  }
  return out;
}

describe('parseSpec', () => {
  it('accepts exactly one of cron / every / at / manual', () => {
    expect(parseSpec({ cron: '0 2 * * *', timezone: 'Europe/Warsaw' }, 'a')).to.deep.eq({
      kind: 'cron',
      expression: '0 2 * * *',
      timezone: 'Europe/Warsaw',
    });
    expect(parseSpec({ every: '5m' }, 'a')).to.deep.eq({
      kind: 'every',
      expression: '5m',
      intervalMs: 300_000,
      timezone: 'UTC',
    });
    expect(parseSpec({ at: '2026-06-01T12:00:00Z' }, 'a')).to.include({ kind: 'at', at: ms('2026-06-01T12:00:00Z') });
    expect(parseSpec({ manual: true }, 'a')).to.deep.eq({ kind: 'manual', expression: 'manual', timezone: 'UTC' });
  });

  it('rejects missing, conflicting and invalid specs with the schedule name', () => {
    expect(() => parseSpec({}, 'nightly')).to.throw(InvalidArgument, /nightly.*one of/);
    expect(() => parseSpec({ cron: '* * * * *', every: '1m' }, 'nightly')).to.throw(InvalidArgument, /only one/);
    expect(() => parseSpec({ cron: 'not a cron' }, 'nightly')).to.throw(InvalidArgument, /cron/);
    expect(() => parseSpec({ cron: '* * * * *', timezone: 'Mars/Olympus' }, 'nightly')).to.throw(
      InvalidArgument,
      /time zone/,
    );
    expect(() => parseSpec({ every: '500ms' }, 'nightly')).to.throw(InvalidArgument, /whole seconds/);
    expect(() => parseSpec({ every: '1500ms' }, 'nightly')).to.throw(InvalidArgument, /whole seconds/);
    expect(() => parseSpec({ at: 'tomorrow' }, 'nightly')).to.throw(InvalidArgument, /ISO/);
  });
});

describe('nextOccurrence', () => {
  it('every: anchored on the epoch grid so all replicas agree', () => {
    const spec = parseSpec({ every: '5m' }, 'a');
    expect(iso(nextOccurrence(spec, ms('2026-01-05T10:02:13.456Z')))).to.eq('2026-01-05T10:05:00.000Z');
    expect(iso(nextOccurrence(spec, ms('2026-01-05T10:05:00.000Z')))).to.eq('2026-01-05T10:10:00.000Z');
  });

  it('cron: strictly after, five and six fields, time zones', () => {
    expect(iso(nextOccurrence(parseSpec({ cron: '*/15 * * * *' }, 'a'), ms('2026-01-05T10:00:00Z')))).to.eq(
      '2026-01-05T10:15:00.000Z',
    );
    expect(iso(nextOccurrence(parseSpec({ cron: '*/30 * * * * *' }, 'a'), ms('2026-01-05T10:00:00Z')))).to.eq(
      '2026-01-05T10:00:30.000Z',
    );
    expect(
      iso(nextOccurrence(parseSpec({ cron: '0 2 * * *', timezone: 'Europe/Warsaw' }, 'a'), ms('2026-01-05T10:00:00Z'))),
    ).to.eq('2026-01-06T01:00:00.000Z');
  });

  it('at: fires once, manual: never', () => {
    const at = parseSpec({ at: '2026-06-01T12:00:00Z' }, 'a');
    expect(iso(nextOccurrence(at, ms('2026-05-01T00:00:00Z')))).to.eq('2026-06-01T12:00:00.000Z');
    expect(nextOccurrence(at, ms('2026-06-01T12:00:00Z'))).to.eq(null);
    expect(nextOccurrence(parseSpec({ manual: true }, 'a'), 0)).to.eq(null);
  });

  it('describes the spec for the API', () => {
    expect(describeSpec(parseSpec({ every: '5m' }, 'a'))).to.deep.eq({
      kind: 'every',
      expression: '5m',
      timezone: 'UTC',
    });
  });
});

// Luxon guesses the offset of an ambiguous local time from Settings.now(), so DST results must not depend on the season the test runs in.
for (const [label, now] of [
  ['real clock', null],
  ['luxon now in winter', '2026-01-15T12:00:00Z'],
  ['luxon now in summer', '2026-07-15T12:00:00Z'],
] as const) {
  describe(`nextOccurrence across DST (${label})`, () => {
    const realNow = Settings.now;
    before(() => {
      if (now) Settings.now = () => Date.parse(now);
    });
    after(() => {
      Settings.now = realNow;
    });

    it('at: a local time without offset resolves like a cron wall time', () => {
      const at = (value: string) => iso((parseSpec({ at: value, timezone: 'Europe/Warsaw' }, 'a') as { at: number }).at);
      expect(at('2026-06-01T12:00:00')).to.eq('2026-06-01T10:00:00.000Z');
      expect(at('2026-01-05T12:00:00.750')).to.eq('2026-01-05T11:00:00.000Z');
      // repeated autumn hour: first pass (CEST)
      expect(at('2026-10-25T02:30:00')).to.eq('2026-10-25T00:30:00.000Z');
      // missing spring hour: shifted forward to 03:30 CEST
      expect(at('2026-03-29T02:30:00')).to.eq('2026-03-29T01:30:00.000Z');
    });

    it('at: an explicit offset wins over the time zone', () => {
      const at = (value: string) => iso((parseSpec({ at: value, timezone: 'Europe/Warsaw' }, 'a') as { at: number }).at);
      expect(at('2026-10-25T02:30:00+01:00')).to.eq('2026-10-25T01:30:00.000Z');
      expect(at('2026-10-25T02:30:00Z')).to.eq('2026-10-25T02:30:00.000Z');
    });

    it('cron: daily 08:00 Europe/Warsaw follows the offset change in autumn', () => {
      const spec = parseSpec({ cron: '0 8 * * *', timezone: 'Europe/Warsaw' }, 'a');
      expect(occurrences(spec, '2026-10-23T12:00:00Z', '2026-10-26T12:00:00Z').map(iso)).to.deep.eq([
        '2026-10-24T06:00:00.000Z',
        '2026-10-25T07:00:00.000Z',
        '2026-10-26T07:00:00.000Z',
      ]);
    });

    it('cron: 02:30 Europe/Warsaw fires once on the autumn day the hour repeats', () => {
      const spec = parseSpec({ cron: '30 2 * * *', timezone: 'Europe/Warsaw' }, 'a');
      const all = occurrences(spec, '2026-10-24T12:00:00Z', '2026-10-26T12:00:00Z');
      const onDay = all.filter((t) => DateTime.fromMillis(t, { zone: 'Europe/Warsaw' }).toISODate() === '2026-10-25');
      expect(onDay).to.have.length(1);
      expect(all.map(iso)).to.include('2026-10-26T01:30:00.000Z');
    });

    it('cron: 02:30 Europe/Warsaw fires once, shifted to 03:30, on the spring day the hour is missing', () => {
      const spec = parseSpec({ cron: '30 2 * * *', timezone: 'Europe/Warsaw' }, 'a');
      const all = occurrences(spec, '2026-03-28T12:00:00Z', '2026-03-30T12:00:00Z');
      const onDay = all.filter((t) => DateTime.fromMillis(t, { zone: 'Europe/Warsaw' }).toISODate() === '2026-03-29');
      expect(onDay.map(iso)).to.deep.eq(['2026-03-29T01:30:00.000Z']);
      expect(all.map(iso)).to.include('2026-03-30T00:30:00.000Z');
      for (let i = 1; i < all.length; i++) expect(all[i]).to.be.greaterThan(all[i - 1]);
    });

    it('cron: keeps firing after the repeated autumn hour, each wall-clock time once', () => {
      // 02:00-02:59 local exists twice on 2026-10-25: 00:00-00:59Z (CEST) and 01:00-01:59Z (CET).
      const quarter = parseSpec({ cron: '*/15 * * * *', timezone: 'Europe/Warsaw' }, 'a');
      expect(occurrences(quarter, '2026-10-24T23:50:00Z', '2026-10-25T02:20:00Z').map(iso)).to.deep.eq([
        '2026-10-25T00:00:00.000Z',
        '2026-10-25T00:15:00.000Z',
        '2026-10-25T00:30:00.000Z',
        '2026-10-25T00:45:00.000Z',
        '2026-10-25T02:00:00.000Z',
        '2026-10-25T02:15:00.000Z',
      ]);
      expect(iso(nextOccurrence(quarter, ms('2026-10-25T01:10:00Z')))).to.eq('2026-10-25T02:00:00.000Z');
      expect(
        iso(
          nextOccurrence(
            parseSpec({ cron: '0 * * * * *', timezone: 'Europe/Warsaw' }, 'a'),
            ms('2026-10-25T01:58:30Z'),
          ),
        ),
      ).to.eq('2026-10-25T02:00:00.000Z');
      expect(
        iso(
          nextOccurrence(parseSpec({ cron: '30 2 * * *', timezone: 'Europe/Warsaw' }, 'a'), ms('2026-10-25T01:00:00Z')),
        ),
      ).to.eq('2026-10-26T01:30:00.000Z');
    });

    it('cron: once per local day across half-hour DST shifts (Australia/Lord_Howe)', () => {
      const spec = parseSpec({ cron: '30 2 * * *', timezone: 'Australia/Lord_Howe' }, 'a');
      for (const [from, to] of [
        ['2026-04-02T00:00:00Z', '2026-04-08T00:00:00Z'],
        ['2026-10-01T00:00:00Z', '2026-10-07T00:00:00Z'],
      ]) {
        const local = occurrences(spec, from, to).map((t) => DateTime.fromMillis(t, { zone: 'Australia/Lord_Howe' }));
        expect(local).to.have.length(6);
        expect(local.map((d) => d.toFormat('HH:mm'))).to.deep.eq(local.map(() => '02:30'));
        expect(new Set(local.map((d) => d.toISODate())).size).to.eq(local.length);
      }
    });
  });
}
