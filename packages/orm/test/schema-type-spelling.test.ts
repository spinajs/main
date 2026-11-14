import * as chai from 'chai';
import 'mocha';
import { buildModelJsonSchema, columnToSchema } from '../src/schema.js';
import { IColumnDescriptor, IModelDescriptor } from '../src/interfaces.js';

const expect = chai.expect;

function column(Type: string): IColumnDescriptor {
  return { Name: 'col', Type, MaxLength: 0, Comment: '', Nullable: false, AutoIncrement: false, Ignore: false, Converter: null } as unknown as IColumnDescriptor;
}

function typeOf(Type: string): string | undefined {
  return columnToSchema(column(Type)).type;
}

/**
 * SQLite's `PRAGMA table_info` reports a column type the way the table declared it ( `INTEGER`,
 * `REAL`, `DECIMAL(10,2)` ), not the lower-case `DATA_TYPE` MySQL and MSSQL hand back.
 */
describe('columnToSchema and buildModelJsonSchema read a SQL type in any spelling', () => {
  it('maps the type SQLite reports for an int() column to integer', () => {
    expect(typeOf('INTEGER')).to.eq('integer');
  });

  it('maps the SQLite storage classes and affinities', () => {
    expect(typeOf('INT')).to.eq('integer');
    expect(typeOf('REAL')).to.eq('number');
    expect(typeOf('NUMERIC')).to.eq('number');
    expect(typeOf('BOOLEAN')).to.eq('boolean');
    expect(typeOf('TEXT')).to.eq('string');
  });

  it('ignores a length or precision suffix and surrounding blanks', () => {
    expect(typeOf('DECIMAL(10,2)')).to.eq('number');
    expect(typeOf(' bigint ')).to.eq('integer');
    expect(typeOf('VARCHAR(64)')).to.eq('string');
  });

  it('ignores the sign and zero-fill attributes of an integer column', () => {
    // what SqliteColumnCompiler emits for `.unsigned()`, and PRAGMA table_info reports back
    expect(typeOf('INTEGER UNSIGNED')).to.eq('integer');
    expect(typeOf('REAL UNSIGNED')).to.eq('number');
    expect(typeOf('DECIMAL UNSIGNED')).to.eq('number');
    expect(typeOf('int(11) unsigned zerofill')).to.eq('integer');
    expect(typeOf('BIGINT SIGNED')).to.eq('integer');
    expect(typeOf('UNSIGNED BIG INT')).to.eq('integer');
  });

  it('still maps the camel-case ColumnType value of a declared dateTime column', () => {
    expect(typeOf('dateTime')).to.eq('string');
    expect(buildModelJsonSchema({ Columns: [column('dateTime')] } as unknown as IModelDescriptor)).to.have.nested.property('properties.col.format', 'date-time');
  });

  it('applies a driver response override whatever the spelling of the column type and of the override key', () => {
    for (const key of ['decimal', 'DECIMAL']) {
      const descriptor = { Columns: [column('DECIMAL(10,2)')], Driver: { ResponseSchemaTypes: { [key]: { type: 'integer' } } } } as unknown as IModelDescriptor;
      expect(buildModelJsonSchema(descriptor, 'response'), key).to.have.nested.property('properties.col.type', 'integer');
      expect(columnToSchema(column('DECIMAL(10,2)'), { [key]: { type: 'integer' } }).type, key).to.eq('integer');
    }
  });
});
