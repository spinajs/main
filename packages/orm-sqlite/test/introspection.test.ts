import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { ModelColumn, ModelEntry } from '@spinajs/manifest';
import { manifestColumns, Orm, RawQuery, type IColumnDescriptor } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';

import { SQLITE_SQL_DIALECT, SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const driver = () => db().Connections.get('sqlite') as SqliteOrmDriver;

describe('sqlite index and foreign-key introspection', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    const schema = driver().schema();
    await schema.createTable('in_users', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Email').unique();
      t.string('Name');
    });
    await schema.createTable('in_posts', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.int('UserId').notNull();
      t.int('Views');
      t.foreignKey('UserId').references('in_users', 'Id').cascade();
    });
    await schema.createTable('in_codes', (t) => {
      t.int('TenantId').notNull().primaryKey();
      t.string('Code', 32).notNull().primaryKey();
    });
    await driver().index().name('ix_posts_user_views').table('in_posts').columns(['UserId', 'Views']);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('reports the rowid primary key as PRIMARY and a composite index in key order', async () => {
    expect(await driver().tableIndexes('in_posts')).to.deep.equal([
      { name: 'PRIMARY', columns: ['Id'], unique: true, primary: true },
      { name: 'ix_posts_user_views', columns: ['UserId', 'Views'], unique: false, primary: false },
    ]);
  });

  it('reports a unique column and a composite primary key', async () => {
    expect((await driver().tableIndexes('in_users')).filter((i) => i.unique && !i.primary).map((i) => i.columns)).to.deep.equal([['Email']]);
    expect((await driver().tableIndexes('in_codes')).filter((i) => i.primary).map((i) => i.columns)).to.deep.equal([['TenantId', 'Code']]);
  });

  it('reports foreign keys with their referential actions', async () => {
    expect(await driver().tableForeignKeys('in_posts')).to.deep.equal([{ name: 'fk_in_posts_0', column: 'UserId', table: 'in_users', references: 'Id', onDelete: 'CASCADE', onUpdate: 'CASCADE' }]);
  });

  it('leaves tableInfo as it was: Unique from a single-column unique index, the foreign key on its column', async () => {
    const users = await driver().tableInfo('in_users');
    expect(users.find((c) => c.Name === 'Email')!.Unique).to.equal(true);
    expect(users.find((c) => c.Name === 'Id')!.Unique).to.equal(false);

    const posts = await driver().tableInfo('in_posts');
    expect(posts.find((c) => c.Name === 'UserId')!.ForeignKeyDescription).to.deep.equal({ From: 'UserId', Table: 'in_users', To: 'Id' });
  });

  it('reports whether the connection enforces foreign keys', async () => {
    expect(await driver().foreignKeysEnforced()).to.equal(false);
    await driver().schema().raw('PRAGMA foreign_keys = ON');
    expect(await driver().foreignKeysEnforced()).to.equal(true);
    await driver().schema().raw('PRAGMA foreign_keys = OFF');
  });

  it('reads a default as a string, a number, or a RawQuery for an expression', async () => {
    await driver().schema().createTable('in_defaults', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Code').default().value("it's");
      t.int('Count').default().value(5);
      t.double('Ratio').default().value(-1.5);
      t.dateTime('Seen').default().raw(RawQuery.create('CURRENT_TIMESTAMP'));
      t.dateTime('Stamp').default().dateTime();
      t.boolean('Flag').default().value(1);
      t.text('Note');
    });
    const defaults = (await driver().tableInfo('in_defaults')).map((c) => [c.Name, c.DefaultValue instanceof RawQuery ? { raw: c.DefaultValue.Query } : c.DefaultValue] as const);
    expect(defaults).to.deep.equal([
      ['Id', null],
      ['Code', "it's"],
      ['Count', 5],
      ['Ratio', -1.5],
      ['Seen', { raw: 'CURRENT_TIMESTAMP' }],
      ['Stamp', { raw: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" }],
      ['Flag', true],
      ['Note', null],
    ]);
  });

  it('flags Unique under db.Models.Source = manifest the columns tableInfo() flags, so onDuplicate() targets the same index', async () => {
    await driver().schema().createTable('in_tags', (t) => {
      t.string('Code', 16).primaryKey();
    });
    const column = (name: string, family: 'integer' | 'text', primary: boolean, unique?: true): ModelColumn => ({ name, type: { text: 'unknown' }, primary, nullable: false, sql: { family, unique } });
    const entry = (tableName: string, columns: ModelColumn[]): ModelEntry => ({ id: `app:${tableName}`, className: tableName, tableName, columns, relations: [], accessResource: false, source: { file: 'src/models.ts', line: 1, col: 1, package: 'app' } });
    const unique = (columns: IColumnDescriptor[]) => columns.filter((c) => c.Unique).map((c) => c.Name);
    const entries = [
      entry('in_users', [column('Id', 'integer', true), column('Email', 'text', false, true), column('Name', 'text', false)]),
      entry('in_codes', [column('TenantId', 'integer', true), column('Code', 'text', true)]),
      entry('in_tags', [column('Code', 'text', true)]),
    ];
    for (const e of entries) {
      expect(unique(manifestColumns(e, SQLITE_SQL_DIALECT)), e.tableName).to.deep.equal(unique(await driver().tableInfo(e.tableName)));
    }
    expect(unique(await driver().tableInfo('in_tags'))).to.deep.equal(['Code']);
  });
});
