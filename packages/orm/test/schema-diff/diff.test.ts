import { expect } from 'chai';
import type { Diagnostic, ModelColumn, ModelEntry, SqlDialectProfile } from '@spinajs/manifest';
import { RawQuery } from '../../src/builders/raw.js';
import type { IColumnDescriptor } from '../../src/interfaces.js';
import { diffSchema } from '../../src/schema-diff/diff.js';
import { buildTargetSchema } from '../../src/schema-diff/target.js';
import type { DiffOptions, LiveTableExtras, SchemaChange, TargetTable } from '../../src/schema-diff/types.js';
import { col, id, live, manifestOf, model } from './fixture.js';

const profile = (name: string, nativeTypes: SqlDialectProfile['nativeTypes'], extra: Partial<SqlDialectProfile> = {}): SqlDialectProfile => ({
  name,
  grammar: name,
  placeholders: 'question',
  families: {},
  count: 'number',
  sum: {},
  avg: {},
  predicates: 'number',
  nativeTypes,
  ...extra,
});

const POSTGRES = profile('postgresql', { int4: ['integer'], varchar: ['text', 'enum'], text: ['text', 'enum'] });
const MSSQL = profile('transactsql', { int: ['integer'], nvarchar: ['text', 'enum', 'json'] });
const SQLITE = profile('sqlite', { integer: ['integer', 'bigint'], text: ['text', 'date', 'datetime', 'time', 'enum'], boolean: ['boolean'] }, { untrustedNullability: ['boolean'] });

const target = (...models: ModelEntry[]): TargetTable[] => buildTargetSchema(manifestOf(models), 'default');
const summary = (changes: SchemaChange[]): string[] => changes.map((c) => `${c.destructive ? '!' : ''}${c.kind} ${c.table}${c.reason ? ` (${c.reason})` : ''}`);
const codes = (diagnostics: Diagnostic[]): string[] => diagnostics.map((d) => `${d.code} ${d.message}`);

const pk = live('Id', 'int4', { PrimaryKey: true, AutoIncrement: true });
const title = live('Title', 'varchar');
const posts = (...columns: ModelColumn[]): ModelEntry => model('Post', 'posts', [id(), col('Title', { family: 'text', inferred: true }), ...columns]);

function run(models: ModelEntry[], columns: IColumnDescriptor[], extras: LiveTableExtras = { hasRows: true }, options: DiffOptions = {}): { changes: string[]; diagnostics: string[] } {
  const diagnostics: Diagnostic[] = [];
  const changes = diffSchema(target(...models), new Map([['posts', columns]]), new Map([['posts', extras]]), { dialect: POSTGRES, diagnostics, ...options });
  return { changes: summary(changes), diagnostics: codes(diagnostics) };
}

describe('diffSchema', () => {
  it('creates a table the database does not have', () => {
    expect(summary(diffSchema(target(posts()), new Map()))).to.deep.equal(['createTable posts']);
  });

  it('finds nothing when the table matches', () => {
    expect(run([posts()], [pk, title])).to.deep.equal({ changes: [], diagnostics: [] });
  });

  it('adds columns; NOT NULL without a default is destructive on a table with rows', () => {
    const models = [posts(col('Summary', { family: 'text', inferred: true }, { nullable: true }), col('Rank', { family: 'integer', inferred: true }))];
    expect(run(models, [pk, title]).changes).to.deep.equal(['addColumn posts', '!addColumn posts (posts.Rank is NOT NULL without a default and the table has rows)']);
    expect(run(models, [pk, title], { hasRows: false }).changes).to.deep.equal(['addColumn posts', 'addColumn posts']);
  });

  it('changes a family: integer to bigint is safe, text to integer is destructive', () => {
    const models = [posts(col('Views', { family: 'bigint', inferred: true }), col('Score', { family: 'integer', inferred: true }))];
    expect(run(models, [pk, title, live('Views', 'int4'), live('Score', 'text')]).changes).to.deep.equal([
      'alterColumn posts (posts.Views: type int4 → bigint)',
      '!alterColumn posts (posts.Score: type text → integer)',
    ]);
  });

  it('widens and narrows an explicit length where the driver reports one (postgres, mssql)', () => {
    const models = [posts(col('Code', { family: 'text', length: 100 }), col('Tag', { family: 'text', length: 20 }))];
    expect(run(models, [pk, title, live('Code', 'varchar', { MaxLength: 50 }), live('Tag', 'varchar', { MaxLength: 40 })])).to.deep.equal({
      changes: ['alterColumn posts (posts.Code: length 50 → 100)', '!alterColumn posts (posts.Tag: length 40 → 20)'],
      diagnostics: [],
    });
    const columns = [live('Id', 'int', { PrimaryKey: true }), live('Title', 'nvarchar'), live('Code', 'nvarchar', { MaxLength: 50 }), live('Tag', 'nvarchar', { MaxLength: 40 })];
    expect(run(models, columns, { hasRows: true }, { dialect: MSSQL }).changes).to.deep.equal(['alterColumn posts (posts.Code: length 50 → 100)', '!alterColumn posts (posts.Tag: length 40 → 20)']);
  });

  it('notes MIG003 once per table when the driver reports no lengths (sqlite, mysql)', () => {
    const models = [posts(col('Code', { family: 'text', length: 100 }), col('Tag', { family: 'text', length: 20 }))];
    const sqlite = [live('Id', 'INTEGER', { PrimaryKey: true }), live('Title', 'TEXT'), live('Code', 'TEXT'), live('Tag', 'TEXT')];
    expect(run(models, sqlite, { hasRows: true }, { dialect: SQLITE })).to.deep.equal({ changes: [], diagnostics: ['MIG003 lengths of posts not compared: the driver reports none'] });
  });

  it('marks a modify that re-states a precision or a length it never compared as destructive (Q16)', () => {
    const models = [posts(col('Price', { family: 'decimal', precision: 10, scale: 2 }, { nullable: true }), col('Rate', { family: 'decimal' }, { nullable: true }))];
    expect(run(models, [pk, title, live('Price', 'numeric'), live('Rate', 'numeric')]).changes).to.deep.equal([
      '!alterColumn posts (posts.Price: NULL allowed, precision not compared; re-stated as (10,2))',
      "!alterColumn posts (posts.Rate: NULL allowed, precision not compared; re-stated as the driver's default)",
    ]);
    const sqlite = [model('Post', 'posts', [id(), col('Code', { family: 'text', length: 50 }, { nullable: true })])];
    expect(run(sqlite, [live('Id', 'INTEGER', { PrimaryKey: true }), live('Code', 'TEXT')], { hasRows: true }, { dialect: SQLITE }).changes).to.deep.equal(['!alterColumn posts (posts.Code: NULL allowed, length not compared; re-stated as 50)']);
  });

  it('marks a modify destructive when a converter turned the live default into an object it cannot re-state (Q16)', () => {
    const models = [posts(col('Opens', { family: 'text' }, { nullable: true }))];
    const opens = (DefaultValue: unknown): IColumnDescriptor => live('Opens', 'text', { DefaultValue });
    expect(run(models, [pk, title, opens({ some: 'object' })]).changes).to.deep.equal(['!alterColumn posts (posts.Opens: NULL allowed, live default not re-statable)']);
    expect(run(models, [pk, title, opens('08:00')]).changes).to.deep.equal(['alterColumn posts (posts.Opens: NULL allowed)']);
    expect(run(models, [pk, title, opens(RawQuery.create('CURRENT_TIME'))]).changes).to.deep.equal(['alterColumn posts (posts.Opens: NULL allowed)']);
    const stated = [posts(col('Opens', { family: 'text', default: '08:00' }, { nullable: true }))];
    expect(run(stated, [pk, title, opens({ some: 'object' })]).changes).to.deep.equal(['alterColumn posts (posts.Opens: NULL allowed)']);
  });

  it('compares the nullability of explicit columns only, and never of a sqlite boolean', () => {
    const models = [posts(col('Body', { family: 'text' }, { nullable: true }), col('Flag', { family: 'text' }), col('Note', { family: 'text', inferred: true }, { nullable: true }), col('Tag', { family: 'text', default: 'x' }))];
    expect(run(models, [pk, title, live('Body', 'text'), live('Flag', 'text', { Nullable: true }), live('Note', 'text'), live('Tag', 'text', { Nullable: true, DefaultValue: 'x' })]).changes).to.deep.equal([
      'alterColumn posts (posts.Body: NULL allowed)',
      '!alterColumn posts (posts.Flag: NOT NULL)',
      '!alterColumn posts (posts.Tag: NOT NULL)',
    ]);
    const sqlite = [model('Post', 'posts', [id(), col('Done', { family: 'boolean' }, { nullable: true })])];
    expect(run(sqlite, [live('Id', 'INTEGER', { PrimaryKey: true }), live('Done', 'BOOLEAN')], { hasRows: true }, { dialect: SQLITE }).changes).to.deep.equal([]);
  });

  it('lists an undeclared column as unmanaged with MIG002, never drops it, and warns MIG004 when inserts would fail (D19 rules 2, 4)', () => {
    expect(run([posts()], [pk, title, live('Legacy', 'text', { Nullable: true }), live('Mandatory', 'int4'), live('Counted', 'int4', { DefaultValue: 0 })])).to.deep.equal({
      changes: ['unmanaged posts', 'unmanaged posts', 'unmanaged posts'],
      diagnostics: [
        'MIG002 column posts.Legacy is declared by no model (Post) and is left as it is',
        'MIG002 column posts.Mandatory is declared by no model (Post) and is left as it is',
        'MIG004 column posts.Mandatory is NOT NULL without a default and no model declares it: inserts through Post fail; declare it on a model or give it a default',
        'MIG002 column posts.Counted is declared by no model (Post) and is left as it is',
      ],
    });
  });

  it('drops an undeclared column only after --base, on an exhaustive table, or by --prune (D19 rule 3)', () => {
    const legacy = live('Body', 'text', { Nullable: true });
    const base = target(posts(col('Body', { family: 'text', inferred: true }, { nullable: true })));
    expect(run([posts()], [pk, title, legacy], { hasRows: true }, { base }).changes).to.deep.equal(['!dropColumn posts (posts.Body was removed from the models since --base)']);
    const exhaustive = model('Post', 'posts', [id(), col('Title', { family: 'text', inferred: true })], { exhaustive: true });
    expect(run([exhaustive], [pk, title, legacy]).changes).to.deep.equal(['!dropColumn posts (posts is exhaustive and no model declares Body)']);
    expect(run([posts()], [pk, title, legacy], { hasRows: true }, { prune: ['posts.Body'] }).changes).to.deep.equal(['!dropColumn posts (--prune posts.Body)']);
  });

  it('adds missing indexes and unique columns, and drops an index --base had', () => {
    const current = model('Post', 'posts', [id(), col('Title', { family: 'text', inferred: true }), col('Slug', { family: 'text', unique: true })], { indexes: [{ columns: ['Title', 'Id'], unique: false }] });
    const base = target(model('Post', 'posts', [id(), col('Title', { family: 'text', inferred: true })], { indexes: [{ name: 'ix_old', columns: ['Title'], unique: false }] }));
    const indexes = [
      { name: 'posts_pkey', columns: ['Id'], unique: true, primary: true },
      { name: 'ix_old', columns: ['Title'], unique: false, primary: false },
    ];
    const changes = diffSchema(target(current), new Map([['posts', [pk, title, live('Slug', 'varchar')]]]), new Map([['posts', { hasRows: true, indexes }]]), { dialect: POSTGRES, base });
    expect(changes.map((c) => (c.kind === 'addIndex' || c.kind === 'dropIndex' ? `${c.kind} ${c.detail.name}` : c.kind))).to.deep.equal(['addIndex ix_posts_Title_Id', 'addIndex uq_posts_Slug', 'dropIndex ix_old']);
    expect(summary(changes)[2]).to.equal('!dropIndex posts (index ix_old on posts was removed from the models since --base)');
  });

  it('without tableIndexes() notes MIG003 and falls back to the Unique flag of single-column uniques', () => {
    const models = [model('Post', 'posts', [id(), col('Title', { family: 'text', inferred: true }), col('Slug', { family: 'text', unique: true })], { indexes: [{ columns: ['Title'], unique: false }] })];
    expect(run(models, [pk, title, live('Slug', 'varchar')])).to.deep.equal({ changes: ['addIndex posts'], diagnostics: ['MIG003 indexes of posts not compared: the driver has no tableIndexes()'] });
    expect(run(models, [pk, title, live('Slug', 'varchar', { Unique: true })]).changes).to.deep.equal([]);
  });

  it('notes MIG003 without tableForeignKeys() and MIG005 for a foreign key an existing table lacks', () => {
    const models = [model('User', 'users', [id()]), model('Post', 'posts', [id(), col('OwnerId', { family: 'integer', inferred: true })], { relations: [{ name: 'Owner', kind: 'belongsTo', target: 'User', foreignKey: 'OwnerId' }] })];
    const columns = new Map([['users', [pk]], ['posts', [pk, live('OwnerId', 'int4')]]]);
    const check = (extras: Map<string, LiveTableExtras>): string[] => {
      const diagnostics: Diagnostic[] = [];
      expect(diffSchema(target(...models), columns, extras, { dialect: POSTGRES, diagnostics })).to.deep.equal([]);
      return codes(diagnostics);
    };
    expect(check(new Map())).to.deep.equal(['MIG003 foreign keys of posts not compared: the driver has no tableForeignKeys()']);
    expect(check(new Map([['posts', { foreignKeys: [] }]]))).to.deep.equal([
      'MIG005 foreign key posts.OwnerId → users.Id is missing; the schema builder adds foreign keys only in createTable, so add it in a hand-written migration',
    ]);
    expect(check(new Map([['posts', { foreignKeys: [{ name: 'fk', column: 'OwnerId', table: 'users', references: 'Id' }] }]]))).to.deep.equal([]);
  });

  it('drops a table that --base mapped and no model maps now', () => {
    const changes = diffSchema(target(model('User', 'users', [id()])), new Map([['users', [pk]], ['posts', [pk]]]), new Map(), { dialect: POSTGRES, base: target(model('User', 'users', [id()]), model('Post', 'posts', [id()])) });
    expect(summary(changes)).to.deep.equal(['!dropTable posts (posts is mapped by no model since --base)']);
  });

  it('notes MIG003 for an unknown native type and for an unknown dialect', () => {
    expect(run([posts()], [pk, live('Title', 'citext')]).diagnostics).to.deep.equal(['MIG003 type of posts.Title not compared: citext is not a known postgresql type']);
    expect(run([posts()], [pk, title], { hasRows: true }, { dialect: undefined }).diagnostics).to.deep.equal(['MIG003 types of posts not compared: the dialect of the driver is unknown']);
  });

  describe('dialect flags', () => {
    const NATIVE = { integer: ['integer' as const], text: ['text' as const], blob: ['binary' as const] };
    const FOLDING = profile('sqlite', NATIVE, { caseInsensitiveIdentifiers: true, unboundedText: true });
    const EXACT = profile('sqlite', NATIVE);
    const LIVE_ID = live('Id', 'integer', { PrimaryKey: true, AutoIncrement: true });
    const options = (dialect: SqlDialectProfile): DiffOptions => ({ dialect });

    it('matches column names ignoring case when the dialect says so', () => {
      const columns = [live('ID', 'integer', { PrimaryKey: true, AutoIncrement: true }), live('TITLE', 'text')];
      expect(run([posts()], columns, { hasRows: false }, options(FOLDING))).to.deep.equal({ changes: [], diagnostics: [] });
      expect(run([posts()], columns, { hasRows: false }, options(EXACT)).changes).to.deep.equal(['addColumn posts', 'addColumn posts', 'unmanaged posts', 'unmanaged posts']);
    });

    it('still shows a real rename as add plus unmanaged', () => {
      const columns = [LIVE_ID, live('Heading', 'text')];
      expect(run([posts()], columns, { hasRows: false }, options(FOLDING)).changes).to.deep.equal(['addColumn posts', 'unmanaged posts']);
    });

    it('matches table names ignoring case, live and --base', () => {
      const columns = new Map([['POSTS', [LIVE_ID, live('title', 'text')]]]);
      const base = target(model('Post', 'Posts', [id(), col('Title', { family: 'text', inferred: true })]));
      expect(summary(diffSchema(target(posts()), columns, new Map(), { dialect: FOLDING, base }))).to.deep.equal([]);
      expect(summary(diffSchema(target(posts()), columns, new Map(), options(EXACT)))).to.deep.equal(['createTable posts']);
      const gone = diffSchema(target(model('User', 'users', [id()])), new Map([['users', [LIVE_ID]], ['POSTS', [LIVE_ID]]]), new Map(), { dialect: FOLDING, base: target(model('User', 'users', [id()]), posts()) });
      expect(summary(gone)).to.deep.equal(['!dropTable posts (posts is mapped by no model since --base)']);
    });

    it('reads the live extras of a table by its folded name too', () => {
      const models = [model('Post', 'posts', [id(), col('Title', { family: 'text', inferred: true })], { indexes: [{ columns: ['Title'], unique: false }] })];
      const columns = new Map([['POSTS', [LIVE_ID, live('Title', 'text')]]]);
      const extras = new Map([['POSTS', { hasRows: true, indexes: [{ name: 'ix', columns: ['Title'], unique: false, primary: false }] }]]);
      expect(summary(diffSchema(target(...models), columns, extras, options(FOLDING)))).to.deep.equal([]);
    });

    it('merges model columns and tables whose names differ only in case', () => {
      const merged = target(model('A', 'Users', [id(), col('name', { family: 'text', inferred: true })]), model('B', 'users', [id(), col('Name', { family: 'text', length: 50 })]));
      expect(merged.map((t) => t.name)).to.deep.equal(['Users', 'users']);
      const changes = diffSchema(merged, new Map(), new Map(), options(FOLDING));
      expect(changes.map((c) => c.kind)).to.deep.equal(['createTable']);
      const created = changes[0];
      expect(created.kind === 'createTable' ? created.detail.columns.map((c) => `${c.name}:${c.sql.length ?? ''}`) : []).to.deep.equal(['Id:', 'name:50']);
      expect(diffSchema(merged, new Map(), new Map(), options(EXACT)).map((c) => c.kind)).to.deep.equal(['createTable', 'createTable']);
    });

    it('reports conflicting specs of case-only twins as MIG001', () => {
      const diagnostics: Diagnostic[] = [];
      diffSchema(target(model('A', 'users', [id(), col('name', { family: 'text', length: 10 })]), model('B', 'users', [id(), col('Name', { family: 'text', length: 20 })])), new Map(), new Map(), { dialect: FOLDING, diagnostics });
      expect(diagnostics.map((d) => d.code)).to.deep.equal(['MIG001']);
    });

    it('matches the columns of an index ignoring case', () => {
      const models = [model('Post', 'posts', [id(), col('Title', { family: 'text', inferred: true })], { indexes: [{ columns: ['Title'], unique: false }] })];
      const extras = { hasRows: true, indexes: [{ name: 'ix', columns: ['Title'.toLowerCase()], unique: false, primary: false }] };
      const columns = [LIVE_ID, live('Title', 'text')];
      expect(run(models, columns, extras, options(FOLDING)).changes).to.deep.equal([]);
      expect(run(models, columns, extras, options(EXACT)).changes).to.deep.equal(['addIndex posts']);
    });

    it('does not call a re-stated text length destructive on an unbounded-text dialect, but keeps binary', () => {
      const models = [model('Post', 'posts', [id(), col('Title', { family: 'text', length: 200 }, { nullable: true }), col('Raw', { family: 'binary', length: 16 }, { nullable: true })])];
      const columns = [LIVE_ID, live('Title', 'text'), live('Raw', 'blob')];
      expect(run(models, columns, { hasRows: true }, options(FOLDING)).changes).to.deep.equal([
        'alterColumn posts (posts.Title: NULL allowed)',
        '!alterColumn posts (posts.Raw: NULL allowed, length not compared; re-stated as 16)',
      ]);
      expect(run(models, columns, { hasRows: true }, options(EXACT)).changes[0]).to.equal('!alterColumn posts (posts.Title: NULL allowed, length not compared; re-stated as 200)');
    });

    it('warns MIG006 when altering a column rebuilds a table that a live or a created table references', () => {
      const REBUILDS = profile('sqlite', NATIVE, { alterColumnRebuildsTable: true });
      const models = [
        model('User', 'users', [id(), col('Name', { family: 'text' }, { nullable: true }), col('ParentId', { family: 'integer', inferred: true })]),
        model('Post', 'posts', [id(), col('OwnerId', { family: 'integer', inferred: true })]),
        model('Comment', 'comments', [id(), col('UserId', { family: 'integer', inferred: true })], { relations: [{ name: 'User', kind: 'belongsTo', target: 'User', foreignKey: 'UserId' }] }),
      ];
      const columns = new Map([
        ['users', [LIVE_ID, live('Name', 'text'), live('ParentId', 'integer')]],
        ['posts', [LIVE_ID, live('OwnerId', 'integer')]],
      ]);
      const extras = new Map<string, LiveTableExtras>([
        ['users', { hasRows: true, foreignKeys: [{ name: 'self', column: 'ParentId', table: 'users', references: 'Id' }] }],
        ['posts', { hasRows: true, foreignKeys: [{ name: 'fk', column: 'OwnerId', table: 'users', references: 'Id' }] }],
      ]);
      const check = (dialect: SqlDialectProfile): string[] => {
        const diagnostics: Diagnostic[] = [];
        diffSchema(target(...models), columns, extras, { dialect, diagnostics });
        return codes(diagnostics).filter((d) => d.startsWith('MIG006'));
      };
      expect(check(REBUILDS)).to.deep.equal(['MIG006 altering a column of users rebuilds the table, which fails while foreign keys are enforced: it is referenced by posts, comments']);
      expect(check(EXACT)).to.deep.equal([]);
    });
  });
});
