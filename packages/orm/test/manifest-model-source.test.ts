import { expect } from 'chai';
import { ManifestMissing, type SqlDialectProfile } from '@spinajs/manifest';
import { columnDrift, manifestColumns, manifestModelEntry } from '../src/manifest-model-source.js';
import { RawQuery } from '../src/builders/raw.js';
import { col, id, live, manifestOf, model } from './schema-diff/fixture.js';

const dialect = (nativeTypes: SqlDialectProfile['nativeTypes'], extra: Partial<SqlDialectProfile> = {}): SqlDialectProfile => ({
  name: 'test',
  grammar: 'test',
  placeholders: 'question',
  families: {},
  count: 'number',
  sum: {},
  avg: {},
  predicates: 'number',
  nativeTypes,
  ...extra,
});

const POSTGRES = dialect({ int4: ['integer'], varchar: ['text', 'enum'], text: ['text', 'enum'], timestamptz: ['datetime'], bytea: ['binary', 'uuid'] });

describe('manifest model source', () => {
  const account = model('Account', 'accounts', [
    id(),
    col('Name', { family: 'text', length: 80 }),
    col('Active', { family: 'boolean', inferred: true }),
    col('Seen', { family: 'datetime', nativeType: 'timestamptz' }, { nullable: true }),
    col('Ref', { family: 'uuid', unique: true, default: { raw: 'gen_random_uuid()' } }),
    col('Rank', { family: 'integer', default: 0, unsigned: true }),
  ]);

  it('finds a registered model by class and table, and throws ManifestMissing for a stale manifest', () => {
    expect(manifestModelEntry(manifestOf([account]), 'Account', 'accounts')).to.equal(account);
    expect(() => manifestModelEntry(manifestOf([account]), 'Ghost', 'ghosts')).to.throw(ManifestMissing, 'model Ghost (table ghosts) is registered but not listed in the manifest models: rebuild the manifest ( spinajs build )');
  });

  it('throws ManifestMissing when more than one manifest model has the class and table name', () => {
    const subclass = model('Account', 'accounts', [id()], { id: '@acme/accounts:Account' });
    expect(() => manifestModelEntry(manifestOf([account, subclass]), 'Account', 'accounts')).to.throw(ManifestMissing, 'model Account (table accounts) matches more than one manifest model (app:Account, @acme/accounts:Account)');
  });

  it('builds descriptors whose native type is the nativeType or the ColumnType name of the family, which is also the converter key', () => {
    const defaults = manifestColumns(account).map((c): unknown => c.DefaultValue);
    expect(manifestColumns(account).map((c) => [c.Name, c.NativeType, c.MaxLength, c.Nullable, c.PrimaryKey, c.AutoIncrement, c.Unique, c.Unsigned])).to.deep.equal([
      ['Id', 'int', -1, false, true, true, true, false],
      ['Name', 'string', 80, false, false, false, false, false],
      ['Active', 'boolean', -1, false, false, false, false, false],
      ['Seen', 'timestamptz', -1, true, false, false, false, false],
      ['Ref', 'uuid', -1, false, false, false, true, false],
      ['Rank', 'int', -1, false, false, false, false, true],
    ]);
    // shaped as tableInfo() shapes them: a literal, or a RawQuery that Model.setDefaults() leaves to the database
    expect(defaults.filter((d) => !(d instanceof RawQuery))).to.deep.equal([undefined, undefined, undefined, undefined, 0]);
    expect(defaults[4]).to.be.instanceOf(RawQuery);
    expect((defaults[4] as RawQuery).Query).to.equal('gen_random_uuid()');
    expect(manifestColumns(account).map((c) => c.Type)).to.deep.equal(manifestColumns(account).map((c) => c.NativeType));
  });

  it('names every family by a ColumnType value so buildModelJsonSchema keeps its output (Q18)', () => {
    const families = ['integer', 'bigint', 'decimal', 'float', 'text', 'boolean', 'date', 'time', 'datetime', 'json', 'binary', 'uuid', 'enum'] as const;
    const entry = model('F', 'f', families.map((family) => col(family, { family, ...(family === 'enum' ? { enumValues: ['a'] } : {}) })));
    expect(manifestColumns(entry).map((c) => c.NativeType)).to.deep.equal(['int', 'bigint', 'decimal', 'float', 'string', 'boolean', 'date', 'time', 'dateTime', 'json', 'binary', 'uuid', 'enum']);
  });

  it('flags a primary key column Unique as the dialect profile says tableInfo() does', () => {
    const unique = (entry: typeof account, profile?: SqlDialectProfile) => manifestColumns(entry, profile).filter((c) => c.Unique).map((c) => c.Name);
    const sqliteLike = dialect({ integer: ['integer', 'bigint'], text: ['text'] }, { uniquePrimaryKey: 'indexed', rowidType: 'integer' });
    const textKey = model('Tag', 'tags', [col('Code', { family: 'text' }, { primary: true })]);
    const intKey = model('Row', 'rows', [col('Id', { family: 'integer', nativeType: 'int' }, { primary: true })]);
    const composite = model('Code', 'codes', [col('TenantId', { family: 'integer' }, { primary: true }), col('Code', { family: 'text' }, { primary: true })]);
    expect(unique(account)).to.deep.equal(['Id', 'Ref']);
    expect(unique(account, POSTGRES)).to.deep.equal(['Id', 'Ref']);
    expect(unique(account, sqliteLike)).to.deep.equal(['Ref']);
    expect(unique(textKey, sqliteLike)).to.deep.equal(['Code']);
    // only INTEGER is the rowid; an INT key has an index
    expect(unique(intKey, sqliteLike)).to.deep.equal(['Id']);
    expect(unique(composite, sqliteLike)).to.deep.equal([]);
    expect(unique(composite, POSTGRES)).to.deep.equal(['TenantId', 'Code']);
    expect(unique(account, { ...POSTGRES, uniquePrimaryKey: 'none' })).to.deep.equal(['Ref']);
  });

  it('reports a declared column missing from the table and a family mismatch, never an undeclared column', () => {
    const drift = columnDrift(account, [live('Id', 'int4'), live('Name', 'varchar'), live('Active', 'int4'), live('Seen', 'timestamptz'), live('Ref', 'bytea'), live('Legacy', 'text')], POSTGRES, 'default');
    expect(drift.map((d) => [d.kind, d.message])).to.deep.equal([
      ['family', 'column accounts.Active is int4 on connection default, model Account declares boolean'],
      ['missing', 'column Rank of model Account is missing from table accounts on connection default'],
    ]);
  });

  it('warns when a column the model requires without a default is nullable or has a default in the table', () => {
    const columns = [live('Id', 'int4'), live('Name', 'varchar', { Nullable: true }), live('Active', 'bool', { DefaultValue: true }), live('Seen', 'timestamptz', { Nullable: true }), live('Ref', 'bytea', { DefaultValue: 'x' }), live('Rank', 'int4', { DefaultValue: 0 })];
    expect(columnDrift(account, columns, POSTGRES, 'default').map((d) => [d.kind, d.message])).to.deep.equal([
      ['nullability', 'column accounts.Name is nullable on connection default, model Account requires a value and states no default: writes without one fail'],
      ['nullability', 'column accounts.Active has a default on connection default, model Account requires a value and states no default: writes without one fail'],
    ]);
  });

  it('does not warn about the nullability of a column the ORM fills on every new instance', () => {
    const columns = [live('Id', 'int4'), live('Name', 'varchar', { Nullable: true }), live('Active', 'bool', { DefaultValue: true }), live('Seen', 'timestamptz'), live('Ref', 'bytea'), live('Rank', 'int4')];
    expect(columnDrift(account, columns, POSTGRES, 'default', ['Name']).map((d) => [d.kind, d.column])).to.deep.equal([['nullability', 'Active']]);
  });

  it('matches column names ignoring case on a dialect with caseInsensitiveIdentifiers, and compares no family on an unknown dialect', () => {
    const columns = [live('ID', 'int4'), live('name', 'varchar'), live('ACTIVE', 'int4'), live('seen', 'timestamptz'), live('ref', 'bytea'), live('rank', 'int4')];
    expect(columnDrift(account, columns, { ...POSTGRES, caseInsensitiveIdentifiers: true }, 'default').map((d) => d.message)).to.deep.equal(['column accounts.Active is int4 on connection default, model Account declares boolean']);
    expect(columnDrift(account, columns, POSTGRES, 'default').map((d) => d.kind)).to.deep.equal(['missing', 'missing', 'missing', 'missing', 'missing', 'missing']);
    expect(columnDrift(account, [live('Id', 'x'), live('Name', 'x'), live('Active', 'x'), live('Seen', 'x'), live('Ref', 'x'), live('Rank', 'x')], undefined, 'default')).to.deep.equal([]);
  });
});
