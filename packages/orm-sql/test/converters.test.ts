import { expect } from 'chai';
import 'mocha';

import { SqlBooleanValueConverter } from './../src/converters.js';

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
