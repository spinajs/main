/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable prettier/prettier */
import * as chai from 'chai';
import { DateTime } from 'luxon';

import { parse, isConfigValueEqual } from './../src/models/DbConfig.js';

const expect = chai.expect;

describe('configuration-db-source codec', function () {
  describe('parse', () => {
    it('parses primitive string-ish types as-is', () => {
      expect(parse('hello', 'string')).to.equal('hello');
      expect(parse('/path/to/file', 'file')).to.equal('/path/to/file');
      expect(parse('one', 'oneOf')).to.equal('one');
    });

    it('parses numeric types', () => {
      expect(parse('42', 'int')).to.equal(42);
      expect(parse('10.4', 'float')).to.equal(10.4);
      expect(parse('3', 'range')).to.equal(3);
    });

    it('parses booleans regardless of driver representation', () => {
      // sqlite stores 0/1, other drivers may store 'true'/'false' or native booleans
      expect(parse('1', 'boolean')).to.equal(true);
      expect(parse('0', 'boolean')).to.equal(false);
      expect(parse('true', 'boolean')).to.equal(true);
      expect(parse('false', 'boolean')).to.equal(false);
      expect(parse(1 as any, 'boolean')).to.equal(true);
      expect(parse(0 as any, 'boolean')).to.equal(false);
      expect(parse(true as any, 'boolean')).to.equal(true);
    });

    it('parses json / manyOf via JSON', () => {
      expect(parse(JSON.stringify({ a: 1 }), 'json')).to.deep.equal({ a: 1 });
      expect(parse('["a","b"]', 'manyOf')).to.deep.equal(['a', 'b']);
    });

    it('parses date / time / datetime to luxon DateTime', () => {
      const d = parse('24-06-2026', 'date') as DateTime;
      expect(DateTime.isDateTime(d)).to.be.true;
      expect(d.day).to.equal(24);
      expect(d.month).to.equal(6);
      expect(d.year).to.equal(2026);

      const t = parse('13:05:09', 'time') as DateTime;
      expect(DateTime.isDateTime(t)).to.be.true;
      expect(t.hour).to.equal(13);
      expect(t.minute).to.equal(5);

      const dt = parse('2026-06-24T13:05:09.000', 'datetime') as DateTime;
      expect(DateTime.isDateTime(dt)).to.be.true;
    });

    it('parses range types into arrays of DateTime', () => {
      const dates = parse('24-06-2026;25-06-2026', 'date-range') as DateTime[];
      expect(dates).to.have.lengthOf(2);
      expect(dates.every((x) => DateTime.isDateTime(x))).to.be.true;
      expect(dates[1].day).to.equal(25);
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
