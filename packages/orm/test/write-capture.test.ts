import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { QueryMiddleware } from '../src/interfaces.js';
import { WriteCaptureMiddleware, captureKeyText } from '../src/capture/index.js';
import { countKeyless, keyTexts, keylessIdentity } from '../src/capture/keys.js';
import { requiredTables, unmatchedTables } from '../src/capture/middleware.js';
import { ORM_CONFIGURATION_SCHEMA } from '../src/configuration-schema.js';
import { WriteCaptureRequired } from '../src/exceptions.js';

const expect = chai.expect;

describe('write capture registration', () => {
  it('is a QueryMiddleware at order 91', () => {
    expect(DI.getRegisteredTypes(QueryMiddleware)).to.include(WriteCaptureMiddleware);
    expect(new WriteCaptureMiddleware().order).to.eq(91);
  });

  it('turns keys into text and refuses what has none', () => {
    expect(captureKeyText('a')).to.eq('a');
    expect(captureKeyText(7)).to.eq('7');
    expect(captureKeyText(2n ** 70n)).to.eq('1180591620717411303424');
    expect(captureKeyText(1.5)).to.eq(undefined);
    expect(captureKeyText(new Date(0))).to.eq(undefined);
  });

  it('keeps the key values with no text apart from the texts', () => {
    const bytes = Buffer.from([1]);
    expect(keyTexts(['a', 7, 'a', bytes, 1.5])).to.deep.eq({ keys: ['a', '7'], keyless: [bytes, 1.5] });
  });

  it('counts a keyless row several reads met once', () => {
    expect(countKeyless([[Buffer.from([1]), Buffer.from([2])], [], [Buffer.from([2]), Buffer.from([3])]])).to.eq(3);
    expect(countKeyless([[new Date(0)], [new Date(0)], [1.5]])).to.eq(2);
    expect(countKeyless([[1.5, 2.5], [2.5, NaN], [NaN]])).to.eq(3);
  });

  it('tells keyless values of different kinds apart', () => {
    expect(countKeyless([[Buffer.from([0x15])], [new Date(15)], [15.5], [Buffer.from([0x15]), new Date(15), 15.5]])).to.eq(3);
  });

  it('counts byte arrays by the bytes of their own view', () => {
    const bytes = Uint8Array.from([1, 2, 1, 2]);
    expect(countKeyless([[bytes.subarray(0, 2)], [bytes.subarray(2, 4), bytes.subarray(1, 3)], [Uint8Array.from([2, 1])]])).to.eq(2);
    expect(countKeyless([[Uint8Array.from([0x15])], [Buffer.from([0x15])], [Uint8Array.from([0x15])]])).to.eq(2);
  });

  it('gives byte arrays, dates and numbers an identity, so they are not compared pairwise', () => {
    expect(keylessIdentity(Uint8Array.from([1, 2]).subarray(1))).to.eq('u:02');
    expect(keylessIdentity(Buffer.from([1, 2]))).to.eq('b:0102');
    expect(keylessIdentity(new Date(15))).to.eq('d:15');
    expect(keylessIdentity(1.5)).to.eq('n:1.5');
    expect(keylessIdentity({ a: 1 })).to.eq(undefined);
  });

  it('compares a keyless value of another kind by value', () => {
    expect(countKeyless([[{ a: 1 }, true], [{ a: 1 }, { a: 2 }, true]])).to.eq(3);
  });

  it('declares db.WriteCapture closed to other keys: MaxRows with 0 meaning no limit, Required as a list of table names that is empty by default', () => {
    expect(ORM_CONFIGURATION_SCHEMA.properties.WriteCapture).to.deep.equal({
      type: 'object',
      propertyNames: { enum: ['MaxRows', 'Required'] },
      properties: {
        MaxRows: { type: 'integer', minimum: 0, default: 0 },
        Required: { type: 'array', items: { type: 'string', minLength: 1 }, default: [] },
      },
    });
  });

  it('reads the required tables, none while the key is not set', () => {
    expect(requiredTables(undefined)).to.deep.eq([]);
    expect(requiredTables([])).to.deep.eq([]);
    expect(requiredTables(['invoice', 'invoice_line'])).to.deep.eq(['invoice', 'invoice_line']);
  });

  it('refuses a value that is not a list of names, so that it never reads as no list', () => {
    for (const value of ['invoice', { invoice: true }, ['invoice', 7], null, 0]) {
      expect(() => requiredTables(value)).to.throw(InvalidOperation, 'write capture: db.WriteCapture.Required must be a list of table names');
    }
  });

  it('names the required tables no table matches, comparing without case', () => {
    expect(unmatchedTables(['Invoice', 'INVOICE_LINE', 'invoce'], ['invoice', 'invoice_line'])).to.deep.eq(['invoce']);
    expect(unmatchedTables(['invoice'], [])).to.deep.eq(['invoice']);
  });

  it('refuses an unobserved write with an InvalidOperation of its own', () => {
    expect(new WriteCaptureRequired('refused')).to.be.instanceOf(InvalidOperation);
  });
});
