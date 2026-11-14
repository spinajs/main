import * as chai from 'chai';
import 'mocha';
import { buildModelJsonSchema } from '../src/schema.js';
import { IColumnDescriptor, IModelDescriptor } from '../src/interfaces.js';

const expect = chai.expect;

function typeOf(Type: string, descriptor: Partial<IModelDescriptor> = {}): unknown {
  const col = { Name: 'col', Type, MaxLength: 0, Comment: '', Nullable: false, AutoIncrement: false, Ignore: false, Converter: null } as unknown as IColumnDescriptor;
  return buildModelJsonSchema({ ...descriptor, Columns: [col] } as unknown as IModelDescriptor, 'response').properties.col.type;
}

/**
 * SQLite's `PRAGMA table_info` reports a column type the way the table declared it ( `INTEGER`,
 * `REAL`, `DECIMAL(10,2)` ), not the lower-case `DATA_TYPE` MySQL and MSSQL hand back.
 */
describe('buildModelJsonSchema reads a SQL type in any spelling', () => {
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
    const col = { Name: 'col', Type: 'dateTime', MaxLength: 0, Comment: '', Nullable: false, AutoIncrement: false, Ignore: false, Converter: null } as unknown as IColumnDescriptor;
    expect(buildModelJsonSchema({ Columns: [col] } as unknown as IModelDescriptor).properties.col.format).to.eq('date-time');
  });

  it('applies a driver response override whatever the spelling', () => {
    expect(typeOf('DECIMAL(10,2)', { Driver: { ResponseSchemaTypes: { decimal: { type: 'integer' } } } } as unknown as Partial<IModelDescriptor>)).to.eq('integer');
  });
});
