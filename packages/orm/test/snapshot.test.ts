/* eslint-disable prettier/prettier */
import { expect } from 'chai';
import 'mocha';
import { DateTime } from 'luxon';
import { createSnapshot, snapshotEquals, snapshotValue } from '../src/snapshot.js';

describe('snapshot primitives', () => {
  describe('snapshotValue', () => {
    it('returns primitives unchanged', () => {
      expect(snapshotValue(1)).to.equal(1);
      expect(snapshotValue('a')).to.equal('a');
      expect(snapshotValue(true)).to.equal(true);
      expect(snapshotValue(null)).to.equal(null);
      expect(snapshotValue(undefined)).to.equal(undefined);
    });

    it('copies an array so mutating the source does not change the copy', () => {
      const source = [1, 2, 3];
      const copy = snapshotValue(source) as number[];

      source.push(4);
      source[0] = 99;

      expect(copy).to.deep.equal([1, 2, 3]);
      expect(copy).to.not.equal(source);
    });

    it('copies a plain object so mutating the source does not change the copy', () => {
      const source = { a: 1, nested: { b: 2 } };
      const copy = snapshotValue(source) as { a: number; nested: { b: number } };

      source.a = 99;
      source.nested.b = 99;

      expect(copy.a).to.equal(1);
      expect(copy.nested.b).to.equal(2);
      expect(copy).to.not.equal(source);
    });

    it('copies a Buffer so mutating the source does not change the copy', () => {
      const source = Buffer.from([1, 2, 3]);
      const copy = snapshotValue(source) as Buffer;

      source[0] = 99;

      expect([...copy]).to.deep.equal([1, 2, 3]);
      expect(copy).to.not.equal(source);
    });

    it('copies a Date so mutating the source does not change the copy', () => {
      const source = new Date(0);
      const copy = snapshotValue(source) as Date;

      source.setFullYear(2000);

      expect(copy.getTime()).to.equal(0);
      expect(copy).to.not.equal(source);
    });

    it('returns a luxon DateTime as-is because it is immutable', () => {
      const source = DateTime.fromISO('2020-01-01T00:00:00.000Z');
      expect(snapshotValue(source)).to.equal(source);
    });
  });

  describe('snapshotEquals', () => {
    it('compares primitives by value', () => {
      expect(snapshotEquals(1, 1)).to.equal(true);
      expect(snapshotEquals(1, 2)).to.equal(false);
      expect(snapshotEquals(null, undefined)).to.equal(false);
      expect(snapshotEquals(0, '')).to.equal(false);
    });

    it('compares luxon DateTime by instant', () => {
      const a = DateTime.fromISO('2020-01-01T00:00:00.000Z');
      const b = DateTime.fromISO('2020-01-01T00:00:00.000Z');
      const c = DateTime.fromISO('2020-01-02T00:00:00.000Z');

      expect(a).to.not.equal(b);
      expect(snapshotEquals(a, b)).to.equal(true);
      expect(snapshotEquals(a, c)).to.equal(false);
    });

    it('compares Date by instant', () => {
      expect(snapshotEquals(new Date(5), new Date(5))).to.equal(true);
      expect(snapshotEquals(new Date(5), new Date(6))).to.equal(false);
    });

    it('compares Buffer by content', () => {
      expect(snapshotEquals(Buffer.from([1, 2]), Buffer.from([1, 2]))).to.equal(true);
      expect(snapshotEquals(Buffer.from([1, 2]), Buffer.from([1, 3]))).to.equal(false);
    });

    it('compares arrays and plain objects deeply', () => {
      expect(snapshotEquals([1, [2]], [1, [2]])).to.equal(true);
      expect(snapshotEquals([1, [2]], [1, [3]])).to.equal(false);
      expect(snapshotEquals({ a: { b: 1 } }, { a: { b: 1 } })).to.equal(true);
      expect(snapshotEquals({ a: { b: 1 } }, { a: { b: 2 } })).to.equal(false);
    });
  });

  describe('createSnapshot', () => {
    it('starts with empty column and relation maps', () => {
      const s = createSnapshot();
      expect(s.Columns.size).to.equal(0);
      expect(s.Relations.size).to.equal(0);
    });
  });
});
