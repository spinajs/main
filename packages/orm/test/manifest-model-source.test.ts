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

  it('reports a declared column missing from the table and a family mismatch, never an undeclared column', () => {
    const drift = columnDrift(account, [live('Id', 'int4'), live('Name', 'varchar'), live('Active', 'int4'), live('Seen', 'timestamptz'), live('Ref', 'bytea'), live('Legacy', 'text')], POSTGRES, 'default');
    expect(drift.map((d) => [d.kind, d.message])).to.deep.equal([
      ['family', 'column accounts.Active is int4 on connection default, model Account declares boolean'],
      ['missing', 'column Rank of model Account is missing from table accounts on connection default'],
    ]);
  });

  it('matches column names ignoring case on a dialect with caseInsensitiveIdentifiers, and compares no family on an unknown dialect', () => {
    const columns = [live('ID', 'int4'), live('name', 'varchar'), live('ACTIVE', 'int4'), live('seen', 'timestamptz'), live('ref', 'bytea'), live('rank', 'int4')];
    expect(columnDrift(account, columns, { ...POSTGRES, caseInsensitiveIdentifiers: true }, 'default').map((d) => d.message)).to.deep.equal(['column accounts.Active is int4 on connection default, model Account declares boolean']);
    expect(columnDrift(account, columns, POSTGRES, 'default').map((d) => d.kind)).to.deep.equal(['missing', 'missing', 'missing', 'missing', 'missing', 'missing']);
    expect(columnDrift(account, [live('Id', 'x'), live('Name', 'x'), live('Active', 'x'), live('Seen', 'x'), live('Ref', 'x'), live('Rank', 'x')], undefined, 'default')).to.deep.equal([]);
  });
});
