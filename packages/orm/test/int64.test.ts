/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { Int64ValueConverter } from '../src/converters.js';
import { Int64 } from '../src/decorators.js';
import { extractModelDescriptor } from '../src/descriptor.js';
import { OrmException } from '../src/exceptions.js';
import { ModelBase } from '../src/model.js';
import { buildModelJsonSchema } from '../src/schema.js';

class Int64Holder extends ModelBase {
  @Int64()
  public Counter: string;

  @Int64('bigint')
  public Big: bigint;

  @Int64('number')
  public Small: number;
}

const BEYOND_SAFE = '9007199254740993';

describe('@Int64 and Int64ValueConverter', () => {
  it('attaches the converter with its mode, string by default', () => {
    const converters = extractModelDescriptor(Int64Holder)!.Converters;

    expect(converters.get('Counter')).to.deep.eq({ Class: Int64ValueConverter, Options: { as: 'string' } });
    expect(converters.get('Big')).to.deep.eq({ Class: Int64ValueConverter, Options: { as: 'bigint' } });
    expect(converters.get('Small')).to.deep.eq({ Class: Int64ValueConverter, Options: { as: 'number' } });
  });

  it('refuses an unknown mode and a second converter', () => {
    expect(() => {
      class UnknownMode extends ModelBase {
        @Int64('float' as never)
        public V: string;
      }
      return UnknownMode;
    }).to.throw(InvalidArgument);

    expect(() => {
      class TwoConverters extends ModelBase {
        @Int64('number')
        @Int64('string')
        public V: string;
      }
      return TwoConverters;
    }).to.throw(InvalidArgument);
  });

  it('reads every driver representation as the declared type', () => {
    const converter = new Int64ValueConverter();

    expect(converter.fromDB('42', {}, { as: 'string' })).to.eq('42');
    expect(converter.fromDB(42, {}, { as: 'string' })).to.eq('42');
    expect(converter.fromDB(42n, {}, { as: 'string' })).to.eq('42');
    expect(converter.fromDB(BEYOND_SAFE, {}, { as: 'string' })).to.eq(BEYOND_SAFE);
    expect(converter.fromDB(BEYOND_SAFE, {}, { as: 'bigint' })).to.eq(9007199254740993n);
    expect(converter.fromDB(42, {}, { as: 'bigint' })).to.eq(42n);
    expect(converter.fromDB('42', {}, { as: 'number' })).to.eq(42);
    expect(converter.fromDB(42)).to.eq('42');
    expect(converter.fromDB(null, {}, { as: 'number' })).to.eq(null);
  });

  it('refuses what a number cannot hold and what already lost precision', () => {
    const converter = new Int64ValueConverter();

    expect(() => converter.fromDB(BEYOND_SAFE, {}, { as: 'number' })).to.throw(OrmException, 'MAX_SAFE_INTEGER');
    expect(() => converter.fromDB(Number.MAX_SAFE_INTEGER + 2, {}, { as: 'string' })).to.throw(OrmException, 'precision');
    expect(() => converter.fromDB('4.2', {}, { as: 'string' })).to.throw(OrmException, 'not an integer');
  });

  it('writes bigints and decimal strings as text and safe integers as numbers', () => {
    const converter = new Int64ValueConverter();

    expect(converter.toDB(9007199254740993n)).to.eq(BEYOND_SAFE);
    expect(converter.toDB(BEYOND_SAFE)).to.eq(BEYOND_SAFE);
    expect(converter.toDB(42)).to.eq(42);
    expect(converter.toDB(null)).to.eq(null);
    expect(() => converter.toDB(Number.MAX_SAFE_INTEGER + 2)).to.throw(InvalidArgument);
    expect(() => converter.toDB('4.2')).to.throw(InvalidArgument);
  });

  it('publishes the declared type in the JSON schema', () => {
    const descriptor: any = {
      Columns: [
        { Name: 'Small', Type: 'int8', NativeType: 'int8', Nullable: false, MaxLength: -1, Comment: '' },
        { Name: 'Counter', Type: 'int8', NativeType: 'int8', Nullable: false, MaxLength: -1, Comment: '' },
      ],
      Converters: new Map([
        ['Small', { Class: Int64ValueConverter, Options: { as: 'number' } }],
        ['Counter', { Class: Int64ValueConverter, Options: { as: 'string' } }],
      ]),
      Hidden: [],
    };

    const response = buildModelJsonSchema(descriptor, 'response');
    const request = buildModelJsonSchema(descriptor, 'request');

    expect(response.properties.Small.type).to.eq('integer');
    expect(response.properties.Counter.type).to.eq('string');
    expect(request.properties.Small.type).to.eq('integer');
    expect(request.properties.Counter.type).to.eq('string');
  });
});
