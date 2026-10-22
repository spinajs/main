import { expect } from 'chai';
import 'mocha';
import { InvalidArgument } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { IsoDatetimeValueConverter, SqlDatetimeValueConverter } from '../src/converters.js';

const AT = Date.UTC(2026, 9, 19, 12, 0, 0, 123);
// A fifth argument means dehydrating, so a statement value is written with four.
const write = (c: SqlDatetimeValueConverter, value: unknown, column?: object, dehydrate?: object) => (dehydrate ? c.toDB(value, null as any, column as any, undefined, dehydrate) : c.toDB(value, null as any, column as any));

describe('SqlDatetimeValueConverter (MySQL)', () => {
  const c = new SqlDatetimeValueConverter();

  it('writes the UTC wall clock with milliseconds, whatever the zone of the input', () => {
    expect(write(c, new Date(AT))).to.eq('2026-10-19 12:00:00.123');
    expect(write(c, DateTime.fromMillis(AT).setZone('Asia/Kolkata'))).to.eq('2026-10-19 12:00:00.123');
    expect(write(c, '2026-10-19T14:00:00.123+02:00')).to.eq('2026-10-19 12:00:00.123');
  });

  it('keeps both instants of a DST fold apart', () => {
    const first = DateTime.fromMillis(Date.UTC(2026, 9, 25, 0, 30)).setZone('Europe/Warsaw');
    const second = DateTime.fromMillis(Date.UTC(2026, 9, 25, 1, 30)).setZone('Europe/Warsaw');

    expect(first.toFormat('HH:mm'), 'the same local wall clock').to.eq(second.toFormat('HH:mm'));
    expect(write(c, first)).to.eq('2026-10-25 00:30:00.000');
    expect(write(c, second)).to.eq('2026-10-25 01:30:00.000');
  });

  it('writes four-digit years to the millisecond', () => {
    expect(write(c, DateTime.utc(9999, 12, 31, 23, 59, 59, 999))).to.eq('9999-12-31 23:59:59.999');
  });

  it('writes unix seconds into a numeric column', () => {
    expect(write(c, new Date(AT), { Name: 'at', Type: 'int' })).to.eq(Math.floor(AT / 1000));
  });

  it('dehydrates in UTC', () => {
    expect(write(c, new Date(AT), undefined, { dateTimeFormat: 'iso' })).to.eq('2026-10-19T12:00:00.123Z');
    expect(write(c, new Date(AT), undefined, { dateTimeFormat: 'sql' })).to.eq('2026-10-19 12:00:00.123');
    expect(write(c, new Date(AT), undefined, { dateTimeFormat: 'unix' })).to.eq(Math.floor(AT / 1000));
  });

  it('dehydrates as ISO 8601 in UTC when no format is asked for, as toJSON() does', () => {
    expect(c.toDB(new Date(AT), null as any, { Name: 'at', Type: 'datetime' } as any, undefined, undefined)).to.eq('2026-10-19T12:00:00.123Z');
    expect(write(c, DateTime.fromMillis(AT).setZone('Asia/Kolkata'), undefined, {})).to.eq('2026-10-19T12:00:00.123Z');
  });

  it('writes null for no value and refuses text that is not a datetime', () => {
    expect(write(c, null)).to.eq(null);
    expect(write(c, undefined)).to.eq(null);
    expect(() => write(c, 'soon', { Name: 'at', Type: 'datetime' })).to.throw(InvalidArgument, 'column at');
  });

  it('reads a driver value as a DateTime in UTC', () => {
    const dt = c.fromDB(new Date(AT))!;

    expect(dt.toMillis()).to.eq(AT);
    expect(dt.zoneName).to.eq('UTC');
  });
});

describe('IsoDatetimeValueConverter (PostgreSQL, SQLite, MSSQL)', () => {
  const c = new IsoDatetimeValueConverter();

  it('writes fixed-width ISO-8601 in UTC, so text order is time order', () => {
    const texts = [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1, 0, 0, 0, 1), Date.UTC(2026, 9, 25, 0, 30), AT].map((ms) => write(c, DateTime.fromMillis(ms).setZone('Asia/Kolkata')) as string);

    expect(texts[3]).to.eq('2026-10-19T12:00:00.123Z');
    expect(texts.every((t) => t.length === 24)).to.eq(true);
    expect([...texts].sort()).to.deep.eq([texts[0], texts[1], texts[3], texts[2]]);
  });

  it('reads its own text back', () => {
    expect(c.fromDB('2026-10-19T12:00:00.123Z')!.toMillis()).to.eq(AT);
  });
});
