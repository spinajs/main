/* eslint-disable prettier/prettier */
import { expect } from 'chai';
import 'mocha';
import { DateTime } from 'luxon';
import { createSnapshot, snapshotEquals, snapshotValue, UNCOPYABLE } from '../src/snapshot.js';

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

  /**
   * A mutable instance of a class the ORM does not own used to be stored in the snapshot BY
   * REFERENCE. The baseline then mutated along with the model, the diff came out empty, and
   * the caller's edit was silently never written — the exact failure the module header warns
   * about. It is now marked uncopyable (always dirty) unless a converter says otherwise.
   */
  describe('uncopyable values', () => {
    class Money {
      constructor(public amount: number) {}
    }

    it('does not alias a class instance it cannot copy', () => {
      const live = new Money(10);
      const baseline = snapshotValue(live);

      expect(baseline).to.equal(UNCOPYABLE);
      expect(baseline).to.not.equal(live);
    });

    it('reports an uncopyable column as changed rather than silently clean', () => {
      const live = new Money(10);
      const baseline = snapshotValue(live);

      // Same object, never touched — still reported as changed. A redundant write is the
      // deliberate trade against a silently lost one.
      expect(snapshotEquals(baseline, live)).to.equal(false);

      live.amount = 20;
      expect(snapshotEquals(baseline, live)).to.equal(false);
    });

    it('lets a converter opt into a precise diff', () => {
      const converter = {
        toDB: (v: any) => v,
        fromDB: (v: any) => v,
        snapshotValue: (v: Money) => new Money(v.amount),
        snapshotEquals: (a: Money, b: Money) => a.amount === b.amount,
      };

      const live = new Money(10);
      const baseline = snapshotValue(live, converter) as Money;

      expect(baseline).to.be.instanceOf(Money);
      expect(baseline).to.not.equal(live);
      expect(snapshotEquals(baseline, live, converter)).to.equal(true);

      live.amount = 20;
      expect(snapshotEquals(baseline, live, converter)).to.equal(false);
    });
  });
});
