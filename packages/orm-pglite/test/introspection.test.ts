import 'mocha';
import { expect } from 'chai';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import '@spinajs/log';
import { Orm } from '@spinajs/orm';
import { createTestApp, type TestApp } from '@spinajs/testing';

import { PgliteOrmDriver } from '../src/index.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

const configuration: Class<Configuration> = class IntrospectionConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.set('logger', SILENT);
    this.set('db', { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: 'introspect', Options: { Schema: 'shop' } }] });
  }
};

describe('postgres index and foreign-key introspection (on PGlite)', function () {
  let app: TestApp;
  let driver: PgliteOrmDriver;

  before(async () => {
    app = await createTestApp({ configuration, register: (c) => c.register(PgliteOrmDriver).as('orm-driver-pglite') });
    driver = (await app.resolve(Orm)).Connections.get('introspect') as PgliteOrmDriver;

    const schema = driver.schema();
    await schema.createTable('in_users', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Email').unique();
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
    await driver.index().name('ix_posts_user_views').table('in_posts').columns(['UserId', 'Views']);
  });

  after(async () => {
    await app.dispose();
  });

  it('reports the primary key and a composite index in key order, from the configured schema', async () => {
    expect(await driver.tableIndexes('in_posts')).to.deep.equal([
      { name: 'in_posts_pkey', columns: ['Id'], unique: true, primary: true },
      { name: 'ix_posts_user_views', columns: ['UserId', 'Views'], unique: false, primary: false },
    ]);
  });

  it('reports a unique column and a composite primary key', async () => {
    expect((await driver.tableIndexes('in_users')).filter((i) => i.unique && !i.primary).map((i) => i.columns)).to.deep.equal([['Email']]);
    expect((await driver.tableIndexes('in_codes')).filter((i) => i.primary).map((i) => i.columns)).to.deep.equal([['TenantId', 'Code']]);
  });

  it('reports foreign keys with their referential actions', async () => {
    const keys = await driver.tableForeignKeys('in_posts');

    expect(keys.map((k) => ({ column: k.column, table: k.table, references: k.references, onDelete: k.onDelete, onUpdate: k.onUpdate }))).to.deep.equal([
      { column: 'UserId', table: 'in_users', references: 'Id', onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    ]);
    expect(keys[0].name).to.be.a('string').and.not.equal('');
  });

  it('reads nothing for a table of another schema', async () => {
    expect(await driver.tableIndexes('in_posts', 'public')).to.deep.equal([]);
  });

  it('tableInfo reports the length of a bounded varchar and -1 for the rest', async () => {
    const codes = await driver.tableInfo('in_codes', 'shop');

    expect(codes.find((c) => c.Name === 'Code')!.MaxLength).to.equal(32);
    expect(codes.find((c) => c.Name === 'TenantId')!.MaxLength).to.equal(-1);
  });
});
