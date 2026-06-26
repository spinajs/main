/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable prettier/prettier */
import * as chai from 'chai';
import { DateTime } from 'luxon';

import { DbConfigValueConverter, isConfigValueEqual } from './../src/index.js';

const expect = chai.expect;

const converter = new DbConfigValueConverter();
const OPTS = { TypeColumn: 'Type' };

// read a stored text value of a given Type back into its runtime value
function fromDb(value: any, type: string) {
  return converter.fromDB(value, { Type: type }, OPTS);
}

// serialize a runtime value of a given Type into its stored text form
function toDb(value: any, type: string) {
  return converter.toDB(value, { Type: type } as any, undefined as any, OPTS);
}

describe('DbConfigValueConverter', function () {
  describe('fromDB', () => {
    it('reads string-ish types as-is', () => {
      expect(fromDb('hello', 'string')).to.equal('hello');
      expect(fromDb('/path/to/file', 'file')).to.equal('/path/to/file');
      expect(fromDb('one', 'oneOf')).to.equal('one');
    });

    it('reads numeric types', () => {
      expect(fromDb('42', 'number')).to.equal(42);
      expect(fromDb('10.4', 'float')).to.equal(10.4);
      expect(fromDb('3', 'range')).to.equal(3);
    });

    it('reads canonical booleans', () => {
      expect(fromDb('true', 'boolean')).to.equal(true);
      expect(fromDb('false', 'boolean')).to.equal(false);
    });

    it('reads json / manyOf via JSON', () => {
      expect(fromDb(JSON.stringify({ a: 1 }), 'json')).to.deep.equal({ a: 1 });
      expect(fromDb('["a","b"]', 'manyOf')).to.deep.equal(['a', 'b']);
    });

    it('reads date / time / datetime (ISO) to luxon DateTime', () => {
      const d = fromDb('2026-06-24', 'date') as DateTime;
      expect(DateTime.isDateTime(d)).to.be.true;
      expect(d.day).to.equal(24);
      expect(d.month).to.equal(6);
      expect(d.year).to.equal(2026);

      const t = fromDb('13:05:09', 'time') as DateTime;
      expect(DateTime.isDateTime(t)).to.be.true;
      expect(t.hour).to.equal(13);
      expect(t.minute).to.equal(5);

      const dt = fromDb('2026-06-24T13:05:09.000', 'datetime') as DateTime;
      expect(DateTime.isDateTime(dt)).to.be.true;
    });

    it('reads range types into arrays of DateTime', () => {
      const dates = fromDb('2026-06-24;2026-06-25', 'date-range') as DateTime[];
      expect(dates).to.have.lengthOf(2);
      expect(dates.every((x) => DateTime.isDateTime(x))).to.be.true;
      expect(dates[1].day).to.equal(25);
    });

    it('passes null / empty values through untouched', () => {
      expect(fromDb(null, 'datetime')).to.equal(null);
      expect(fromDb(undefined, 'date')).to.equal(undefined);
      expect(fromDb('', 'json')).to.equal('');
    });
  });

  describe('toDB round-trips', () => {
    it('numbers / booleans / strings', () => {
      expect(toDb(42, 'number')).to.equal('42');
      expect(toDb(10.4, 'float')).to.equal('10.4');
      expect(toDb(true, 'boolean')).to.equal('true');
      expect(toDb(false, 'boolean')).to.equal('false');
      expect(toDb('hi', 'string')).to.equal('hi');
    });

    it('json / manyOf', () => {
      expect(toDb({ a: 1 }, 'json')).to.equal('{"a":1}');
      expect(toDb(['a', 'b'], 'manyOf')).to.equal('["a","b"]');
    });

    it('date / time / datetime serialize to ISO and round-trip', () => {
      const date = DateTime.fromISO('2026-06-24');
      const stored = toDb(date, 'date') as string;
      expect(stored).to.equal('2026-06-24');
      expect((fromDb(stored, 'date') as DateTime).day).to.equal(24);

      const dt = DateTime.fromISO('2026-06-24T13:05:09.000Z');
      const storedDt = toDb(dt, 'datetime') as string;
      expect(DateTime.isDateTime(fromDb(storedDt, 'datetime'))).to.be.true;
    });

    it('date-range round-trips', () => {
      const range = [DateTime.fromISO('2026-06-24'), DateTime.fromISO('2026-06-25')];
      const stored = toDb(range, 'date-range') as string;
      expect(stored).to.equal('2026-06-24;2026-06-25');
      const back = fromDb(stored, 'date-range') as DateTime[];
      expect(back.map((x) => x.day)).to.deep.equal([24, 25]);
    });

    it('passes null / undefined through untouched', () => {
      expect(toDb(null, 'datetime')).to.equal(null);
      expect(toDb(undefined, 'number')).to.equal(undefined);
    });
  });

  describe('isConfigValueEqual', () => {
    it('treats equal DateTimes (different instances) as equal', () => {
      const a = DateTime.fromISO('2026-06-24T10:00:00.000Z');
      const b = DateTime.fromISO('2026-06-24T10:00:00.000Z');

      expect(a === b).to.be.false; // different instances
      expect(isConfigValueEqual(a, b)).to.be.true;
    });

    it('treats different DateTimes as not equal', () => {
      const a = DateTime.fromISO('2026-06-24T10:00:00.000Z');
      const b = DateTime.fromISO('2026-06-24T11:00:00.000Z');

      expect(isConfigValueEqual(a, b)).to.be.false;
    });

    it('compares arrays of DateTime element-wise', () => {
      const a = [DateTime.fromISO('2026-06-24T10:00:00.000Z'), DateTime.fromISO('2026-06-25T10:00:00.000Z')];
      const b = [DateTime.fromISO('2026-06-24T10:00:00.000Z'), DateTime.fromISO('2026-06-25T10:00:00.000Z')];
      const c = [DateTime.fromISO('2026-06-24T10:00:00.000Z'), DateTime.fromISO('2026-06-26T10:00:00.000Z')];

      expect(isConfigValueEqual(a, b)).to.be.true;
      expect(isConfigValueEqual(a, c)).to.be.false;
    });

    it('falls back to deep equality for non-DateTime values', () => {
      expect(isConfigValueEqual('a', 'a')).to.be.true;
      expect(isConfigValueEqual(1, 1)).to.be.true;
      expect(isConfigValueEqual({ a: 1 }, { a: 1 })).to.be.true;
      expect(isConfigValueEqual({ a: 1 }, { a: 2 })).to.be.false;
    });
  });
});
