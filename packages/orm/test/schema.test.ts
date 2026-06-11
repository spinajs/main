import * as chai from 'chai';
import 'mocha';
import { ColumnType } from '../src/enums.js';
import { buildModelJsonSchema } from '../src/schema.js';
import { IColumnDescriptor, IModelDescriptor } from '../src/interfaces.js';

const expect = chai.expect;

// columnToSchema detects booleans by the converter's class name.
class BooleanValueConverter {}

function column(overrides: Partial<IColumnDescriptor>): IColumnDescriptor {
  return {
    Name: 'col',
    Type: ColumnType.STRING,
    MaxLength: 0,
    Comment: '',
    Nullable: false,
    AutoIncrement: false,
    Ignore: false,
    Converter: null,
    ...overrides,
  } as unknown as IColumnDescriptor;
}

function build(columns: Partial<IColumnDescriptor>[]): any {
  return buildModelJsonSchema({ Columns: columns.map(column) } as unknown as IModelDescriptor);
}

describe('buildModelJsonSchema', () => {
  it('maps SQL column types to JSON-schema types', () => {
    const schema = build([
      { Name: 'count', Type: ColumnType.INTEGER },
      { Name: 'title', Type: ColumnType.STRING },
      { Name: 'price', Type: ColumnType.DECIMAL },
      { Name: 'active', Type: ColumnType.BOOLEAN },
      { Name: 'createdAt', Type: ColumnType.DATE_TIME },
      { Name: 'meta', Type: ColumnType.JSON },
    ]);

    expect(schema.type).to.equal('object');
    expect(schema.properties.count.type).to.equal('integer');
    expect(schema.properties.title.type).to.equal('string');
    expect(schema.properties.price.type).to.equal('number');
    expect(schema.properties.active.type).to.equal('boolean');
    expect(schema.properties.createdAt).to.deep.equal({ type: 'string', format: 'date-time' });
    expect(schema.properties.meta.type).to.equal('object');
  });

  it('falls back to string for unknown column types', () => {
    const schema = build([{ Name: 'shape', Type: 'geometry' }]);
    expect(schema.properties.shape.type).to.equal('string');
  });

  it('treats a tinyint with a boolean converter as boolean', () => {
    const schema = build([{ Name: 'flag', Type: ColumnType.TINY_INTEGER, Converter: new BooleanValueConverter() as any }]);
    expect(schema.properties.flag.type).to.equal('boolean');
  });

  it('excludes @Ignore columns (e.g. a hidden password)', () => {
    const schema = build([
      { Name: 'id', Type: ColumnType.INTEGER, AutoIncrement: true },
      { Name: 'email', Type: ColumnType.STRING },
      { Name: 'password', Type: ColumnType.STRING, Ignore: true },
    ]);

    expect(Object.keys(schema.properties)).to.have.members(['id', 'email']);
    expect(schema.properties).to.not.have.property('password');
  });

  it('marks non-nullable, non-autoincrement columns as required', () => {
    const schema = build([
      { Name: 'id', Type: ColumnType.INTEGER, AutoIncrement: true }, // generated → not required
      { Name: 'email', Type: ColumnType.STRING }, // required
      { Name: 'nick', Type: ColumnType.STRING, Nullable: true }, // optional → not required
    ]);

    expect(schema.required).to.deep.equal(['email']);
  });

  it('adds maxLength, description and nullable when the column has them', () => {
    const schema = build([{ Name: 'bio', Type: ColumnType.STRING, MaxLength: 255, Comment: 'User bio', Nullable: true }]);

    expect(schema.properties.bio).to.deep.equal({
      type: 'string',
      maxLength: 255,
      description: 'User bio',
      nullable: true,
    });
  });

  it('omits "required" when no column is required', () => {
    const schema = build([{ Name: 'id', Type: ColumnType.INTEGER, AutoIncrement: true }]);
    expect(schema.required).to.equal(undefined);
  });
});
