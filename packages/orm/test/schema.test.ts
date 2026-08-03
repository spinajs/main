import * as chai from 'chai';
import 'mocha';
import { ColumnType } from '../src/enums.js';
import { buildModelJsonSchema } from '../src/schema.js';
import { IColumnDescriptor, IModelDescriptor } from '../src/interfaces.js';

const expect = chai.expect;

// A driver that hands DECIMAL back as a string, the way mysql2 does.
const STRING_DECIMAL_DRIVER = { ResponseSchemaTypes: { [ColumnType.DECIMAL]: { type: 'string' } } };

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

function build(columns: Partial<IColumnDescriptor>[], descriptor: Partial<IModelDescriptor> = {}): any {
  return buildModelJsonSchema({ ...descriptor, Columns: columns.map(column) } as unknown as IModelDescriptor);
}

function buildResponse(columns: Partial<IColumnDescriptor>[], descriptor: Partial<IModelDescriptor> = {}): any {
  return buildModelJsonSchema({ ...descriptor, Columns: columns.map(column) } as unknown as IModelDescriptor, 'response');
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

  /**
   * `ColumnType.DATE_TIME` is 'dateTime', but every driver stores the column's own
   * DATA_TYPE string, and MySQL / MSSQL spell it 'datetime'. The key never matched, so
   * `created_at` came out as a bare string with no `format` - a generated client parsed
   * it as text instead of a date.
   */
  it('recognises the driver spelling of DATETIME as well as ColumnType.DATE_TIME', () => {
    const schema = build([{ Name: 'created_at', Type: 'datetime' }]);
    expect(schema.properties.created_at).to.deep.equal({ type: 'string', format: 'date-time' });
  });

  /**
   * DECIMAL is where the two contracts genuinely differ, and only for some drivers.
   * A model used directly as `@Body()` documents what a client may SEND: JSON numbers,
   * as it always did. Demanding a string there would break every generated write client.
   */
  it('keeps DECIMAL a number on the request side, whatever the driver returns', () => {
    expect(build([{ Name: 'price', Type: ColumnType.DECIMAL }]).properties.price).to.deep.equal({ type: 'number' });
    expect(build([{ Name: 'price', Type: ColumnType.DECIMAL }], { Driver: STRING_DECIMAL_DRIVER } as any).properties.price).to.deep.equal({ type: 'number' });
  });

  /**
   * The response side asks the DRIVER, because "DECIMAL comes back as a string" is a
   * mysql2 fact ( decimalNumbers off by default - above 2^53 a float loses exactly the
   * precision DECIMAL exists to keep ), not a universal one: tedious and sqlite hand
   * back JS numbers. A driver-agnostic map made the spec lie for one of the two groups.
   */
  it('lets the driver override a type on the response side only', () => {
    const withDriver = buildResponse([{ Name: 'price', Type: ColumnType.DECIMAL }], { Driver: STRING_DECIMAL_DRIVER } as any);
    const withoutDriver = buildResponse([{ Name: 'price', Type: ColumnType.DECIMAL }]);

    expect(withDriver.properties.price).to.deep.equal({ type: 'string' });
    expect(withoutDriver.properties.price, 'a driver that declares nothing keeps the shared default').to.deep.equal({ type: 'number' });
  });

  /**
   * `dehydrate()` / `dehydrateWithRelations()` unconditionally omit `@Hidden()` properties, so those
   * columns can never appear in a response - rbac's User hides `Password` and `Id`.
   * Advertising them made the spec describe fields the ORM guarantees are absent, and put
   * a `Password` property on a public response schema.
   */
  it('omits hidden columns from the response schema, and only from it', () => {
    const columns = [
      { Name: 'Id', Type: ColumnType.INTEGER, AutoIncrement: true },
      { Name: 'Email', Type: ColumnType.STRING },
      { Name: 'Password', Type: ColumnType.STRING },
    ];

    const response = buildResponse(columns, { Hidden: ['Password', 'Id'] } as any);
    const request = build(columns, { Hidden: ['Password', 'Id'] } as any);

    expect(Object.keys(response.properties), 'a hidden column cannot appear in a response').to.deep.equal(['Email']);
    expect(Object.keys(request.properties), 'the write contract still accepts them').to.have.members(['Id', 'Email', 'Password']);
  });

  it('never marks a response property required - a response is partial by construction', () => {
    const schema = buildResponse([{ Name: 'email', Type: ColumnType.STRING }]);

    expect(schema.properties.email.type).to.equal('string');
    expect(schema).to.not.have.property('required');
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
