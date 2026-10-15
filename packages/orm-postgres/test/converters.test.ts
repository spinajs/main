/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import 'mocha';
import { DateTime } from 'luxon';

import { PostgresDatetimeValueConverter, PostgresJsonValueConverter } from '../src/converters.js';
import { utcTypeParser } from '../src/index.js';

const col = (Type: string) => ({ Type }) as any;

describe('PostgresJsonValueConverter', () => {
  const c = new PostgresJsonValueConverter();

  it('passes through what node-postgres already parsed from json/jsonb', () => {
    expect(c.fromDB({ a: 1 })).to.deep.equal({ a: 1 });
    expect(c.fromDB([1, 2])).to.deep.equal([1, 2]);
    expect(c.fromDB(5)).to.equal(5);
    expect(c.fromDB(true)).to.equal(true);
    expect(c.fromDB(null)).to.equal(null);
  });

  it('reads a JSON string value as that string', () => {
    expect(c.fromDB('plain')).to.equal('plain');
  });

  it('still parses JSON text from a TEXT column', () => {
    expect(c.fromDB('{"a":1}')).to.deep.equal({ a: 1 });
  });
});

describe('PostgresDatetimeValueConverter', () => {
  const c = new PostgresDatetimeValueConverter();
  const warsaw = DateTime.fromISO('2026-07-01T12:00:00.123', { zone: 'Europe/Warsaw' });

  it('writes an instant as UTC ISO with milliseconds, whatever the value zone', () => {
    expect(c.toDB(warsaw, undefined as any, col('timestamptz'))).to.equal('2026-07-01T10:00:00.123Z');
    expect(c.toDB(new Date('2026-07-01T10:00:00.123Z'), undefined as any, col('timestamp'))).to.equal('2026-07-01T10:00:00.123Z');
    expect(c.toDB(warsaw, undefined as any, undefined as any)).to.equal('2026-07-01T10:00:00.123Z');
    expect(c.toDB('2026-07-01T12:00:00.123+02:00' as any, undefined as any, col('timestamptz'))).to.equal('2026-07-01T10:00:00.123Z');
  });

  it('keeps the calendar day for a date column, numbers for numeric columns and null', () => {
    expect(c.toDB(warsaw, undefined as any, col('date'))).to.equal('2026-07-01');
    expect(c.toDB(warsaw, undefined as any, col('int8'))).to.equal(warsaw.toUnixInteger());
    expect(c.toDB(null as any, undefined as any, col('timestamptz'))).to.equal(null);
  });

  it('leaves an unset value unset, so the insert takes the column default', () => {
    expect(c.toDB(undefined as any, undefined as any, col('timestamptz'))).to.equal(undefined);
  });

  it('keeps a DateTime the app assigned as it is (zone included)', () => {
    expect((c.fromDB(warsaw) as DateTime).toISO()).to.equal(warsaw.toISO());
  });

  it('keeps the dehydrate formats of the shared converter', () => {
    expect(c.toDB(warsaw, undefined as any, col('timestamptz'), undefined, { dateTimeFormat: 'iso' } as any)).to.equal(warsaw.toISO());
    expect(c.toDB(warsaw, undefined as any, col('timestamptz'), undefined, { dateTimeFormat: 'unix' } as any)).to.equal(warsaw.toUnixInteger());
  });

  it('reads an instant as a UTC DateTime with the same milliseconds', () => {
    const read = c.fromDB(new Date('2026-07-01T10:00:00.123Z')) as DateTime;
    expect(read.zoneName).to.equal('UTC');
    expect(read.toMillis()).to.equal(Date.parse('2026-07-01T10:00:00.123Z'));
    expect((c.fromDB('2026-07-01 10:00:00.123') as DateTime).toISO()).to.equal('2026-07-01T10:00:00.123Z');
    expect(c.fromDB(null as any)).to.equal(null);
  });
});

describe('utcTypeParser', () => {
  it('reads DATE as UTC midnight of its calendar day', () => {
    expect((utcTypeParser(1082)('2026-10-15') as Date).toISOString()).to.equal('2026-10-15T00:00:00.000Z');
  });

  it('reads a legacy TIMESTAMP (no zone) as UTC', () => {
    expect((utcTypeParser(1114)('2026-07-01 10:00:00.123') as Date).toISOString()).to.equal('2026-07-01T10:00:00.123Z');
  });

  it('leaves timestamptz and other types to pg-types', () => {
    expect((utcTypeParser(1184)('2026-07-01 12:00:00.123+02') as Date).toISOString()).to.equal('2026-07-01T10:00:00.123Z');
    expect(utcTypeParser(23)('42')).to.equal(42);
  });
});
