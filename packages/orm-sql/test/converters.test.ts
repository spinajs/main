import { expect } from 'chai';
import 'mocha';

import { TimeSpan } from '@spinajs/util';
import { snapshotValue } from '@spinajs/orm';

import { SqlBooleanValueConverter, SqlTimeValueConverter } from './../src/converters.js';

/**
 * `toDB` serves two callers with two encodings, and only the ARITY tells them apart.
 *
 * - four arguments  -> an INSERT/UPDATE payload (`ModelToSqlConverter`,
 *   `StandardObjectToSqlConverter`) or a WHERE binding (`compilers.ts`, `statements.ts`).
 *   SQL wants 0/1.
 * - five arguments  -> `dehydrators.ts`, the path behind `dehydrate()`, `toJSON()` and every
 *   serialized response. JSON wants the boolean the property declares, and it is what
 *   `columnToSchema` publishes for a column carrying this converter.
 *
 * The fifth argument may itself be `undefined` - `ModelBase.toJSON()` calls `dehydrate()` with no
 * options - so these tests pin the arity rather than the value. A converter that checked
 * `dehydrateOptions !== undefined` would pass the "with options" case below and silently answer
 * `0` to the one after it.
 */
describe('SqlBooleanValueConverter', () => {
  const converter = new SqlBooleanValueConverter();

  it('renders 0/1 for a database write ( no dehydrate options passed )', () => {
    expect(converter.toDB(true)).to.equal(1);
    expect(converter.toDB(false)).to.equal(0);

    // the shape the model->sql converters and the where-clause compilers actually call with
    expect(converter.toDB(true, undefined, undefined, undefined)).to.equal(1);
    expect(converter.toDB(false, undefined, undefined, undefined)).to.equal(0);
  });

  it('renders a boolean when dehydrating, with options', () => {
    expect(converter.toDB(1, undefined, undefined, undefined, { dateTimeFormat: 'iso' })).to.equal(true);
    expect(converter.toDB(0, undefined, undefined, undefined, { dateTimeFormat: 'iso' })).to.equal(false);
  });

  it('renders a boolean when dehydrating without options - toJSON() passes none', () => {
    expect(converter.toDB(1, undefined, undefined, undefined, undefined)).to.equal(true);
    expect(converter.toDB(0, undefined, undefined, undefined, undefined)).to.equal(false);
  });

  it('reads 0/1, true/false and the string forms back as booleans', () => {
    expect(converter.fromDB(1)).to.equal(true);
    expect(converter.fromDB('1')).to.equal(true);
    expect(converter.fromDB(true)).to.equal(true);

    expect(converter.fromDB(0)).to.equal(false);
    expect(converter.fromDB('0')).to.equal(false);
    expect(converter.fromDB(false)).to.equal(false);
    expect(converter.fromDB(null)).to.equal(false);
  });
});

/**
 * `time` columns hydrate to a {@link TimeSpan}, an instance of a class the ORM does not own.
 * The generic snapshot path can only mark such a value `UNCOPYABLE`, which never compares equal
 * to anything: the column is then reported as changed on every single diff, with no usable
 * `OldValue`, and the model never converges to clean. These hooks are how the converter opts
 * into a real baseline — the TimeSpan's total milliseconds, a copyable primitive.
 */
describe('SqlTimeValueConverter snapshot hooks', () => {
  const converter = new SqlTimeValueConverter();

  it('baselines a TimeSpan as a copyable primitive, not UNCOPYABLE', () => {
    const baseline = converter.snapshotValue(TimeSpan.fromHours(8));

    expect(baseline).to.equal(8 * TimeSpan.MILLIS_PER_HOUR);

    // the value the converter hands the snapshot must survive the ORM's generic copy step
    expect(snapshotValue(baseline, converter)).to.equal(8 * TimeSpan.MILLIS_PER_HOUR);

    // and the generic path must route a LIVE TimeSpan through the hook rather than answering
    // UNCOPYABLE. Pinned to the exact millis, not merely `not.equal(UNCOPYABLE)`: that weaker form
    // holds for any wrong number too, and this is the assertion the whole fix rests on.
    expect(snapshotValue(TimeSpan.fromHours(8), converter)).to.equal(8 * TimeSpan.MILLIS_PER_HOUR);
  });

  it('passes null and undefined through unchanged', () => {
    expect(converter.snapshotValue(null)).to.equal(null);
    expect(converter.snapshotValue(undefined)).to.equal(undefined);
  });

  it('compares equal TimeSpans as equal, whichever side is already a number', () => {
    expect(converter.snapshotEquals(TimeSpan.fromHours(8), TimeSpan.fromHours(8))).to.equal(true);
    expect(converter.snapshotEquals(converter.snapshotValue(TimeSpan.fromHours(8)), TimeSpan.fromHours(8))).to.equal(true);
    expect(converter.snapshotEquals(TimeSpan.fromMinutes(90), new TimeSpan(90 * TimeSpan.MILLIS_PER_MINUTE))).to.equal(true);
  });

  it('compares different TimeSpans as not equal', () => {
    expect(converter.snapshotEquals(TimeSpan.fromHours(8), TimeSpan.fromHours(9))).to.equal(false);
    expect(converter.snapshotEquals(converter.snapshotValue(TimeSpan.fromHours(8)), TimeSpan.fromHours(9))).to.equal(false);
  });

  it('keeps null / undefined / value strictly distinct, like the generic snapshotEquals', () => {
    expect(converter.snapshotEquals(null, TimeSpan.fromHours(8))).to.equal(false);
    expect(converter.snapshotEquals(TimeSpan.fromHours(8), null)).to.equal(false);
    expect(converter.snapshotEquals(undefined, TimeSpan.fromHours(8))).to.equal(false);
    expect(converter.snapshotEquals(null, undefined)).to.equal(false);
    expect(converter.snapshotEquals(undefined, null)).to.equal(false);

    // both absent in the same way is still "no change"
    expect(converter.snapshotEquals(null, null)).to.equal(true);
    expect(converter.snapshotEquals(undefined, undefined)).to.equal(true);
  });

  it('a clean round trip through the converter leaves the column clean', () => {
    // what hydration does: fromDB -> snapshotValue as the baseline, then the same value re-read
    const baseline = converter.snapshotValue(converter.fromDB('08:30:00'));

    expect(converter.snapshotEquals(baseline, converter.fromDB('08:30:00'))).to.equal(true);
    expect(converter.snapshotEquals(baseline, converter.fromDB('09:30:00'))).to.equal(false);
  });
});
