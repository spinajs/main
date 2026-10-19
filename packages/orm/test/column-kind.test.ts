import 'mocha';
import { expect } from 'chai';

import { columnKind, lookupValue } from '../src/column-kind.js';
import type { ColumnKind } from '../src/column-kind.js';

const col = (Type: string, NativeType = Type) => ({ Type, NativeType });

const SPELLINGS: [string, ColumnKind][] = [
  // sqlite: the declared type as written
  ['INTEGER', 'integer'],
  ['INT', 'integer'],
  ['BIGINT', 'integer'],
  ['UNSIGNED BIG INT', 'integer'],
  ['TEXT', 'text'],
  ['VARCHAR(64)', 'text'],
  ['NUMERIC', 'decimal'],
  ['REAL', 'decimal'],
  ['BLOB', 'other'],
  ['DATETIME', 'other'],
  // postgres: udt_name
  ['int2', 'integer'],
  ['int4', 'integer'],
  ['int8', 'integer'],
  ['numeric', 'decimal'],
  ['float4', 'decimal'],
  ['float8', 'decimal'],
  ['uuid', 'uuid'],
  ['varchar', 'text'],
  ['bpchar', 'text'],
  ['text', 'text'],
  ['timestamp', 'other'],
  ['bool', 'other'],
  ['interval', 'other'],
  ['jsonb', 'other'],
  // mysql: DATA_TYPE, and a COLUMN_TYPE with size and sign
  ['int', 'integer'],
  ['tinyint', 'integer'],
  ['smallint', 'integer'],
  ['mediumint', 'integer'],
  ['bigint', 'integer'],
  ['int(10) unsigned', 'integer'],
  ['decimal', 'decimal'],
  ['double', 'decimal'],
  ['float', 'decimal'],
  ['char', 'text'],
  ['longtext', 'text'],
  ['datetime', 'other'],
  ['binary', 'other'],
  // mssql: DATA_TYPE
  ['uniqueidentifier', 'uuid'],
  ['nvarchar', 'text'],
  ['nchar', 'text'],
  ['ntext', 'text'],
  ['money', 'decimal'],
  ['datetime2', 'other'],
  ['bit', 'other'],
];

describe('columnKind and lookupValue', () => {
  it('names the kind of every driver spelling', () => {
    for (const [type, kind] of SPELLINGS) expect(columnKind(col(type)), type).to.equal(kind);
  });

  it('reads NativeType when Type is empty', () => {
    expect(columnKind(col('', 'int4'))).to.equal('integer');
    expect(columnKind(col('', ''))).to.equal('other');
  });

  it('an integer column takes integer text only, as a number while it is safe', () => {
    const c = col('int4');
    expect(lookupValue(c, '42')).to.equal(42);
    expect(lookupValue(c, '-7')).to.equal(-7);
    expect(lookupValue(c, '9007199254740993')).to.equal('9007199254740993');
    for (const t of ['abc', '4.2', '', ' 42', '042', '1e3', '0x10']) expect(lookupValue(c, t), t).to.equal(undefined);
  });

  it('a decimal column takes decimal text, unchanged', () => {
    const c = col('numeric');
    expect(lookupValue(c, '1.50')).to.equal('1.50');
    expect(lookupValue(c, '-3')).to.equal('-3');
    for (const t of ['abc', '1.', '.5', '1e3', '']) expect(lookupValue(c, t), t).to.equal(undefined);
  });

  it('a uuid column takes a uuid only', () => {
    const c = col('uniqueidentifier');
    expect(lookupValue(c, '0B6C6F1E-5F43-4A3E-9D3E-2A4B1C0D9E8F')).to.equal('0B6C6F1E-5F43-4A3E-9D3E-2A4B1C0D9E8F');
    expect(lookupValue(c, 'not-a-uuid')).to.equal(undefined);
  });

  it('any other column takes the text as it is', () => {
    for (const type of ['varchar', 'TEXT', 'datetime', 'blob']) expect(lookupValue(col(type), 'abc'), type).to.equal('abc');
  });
});
