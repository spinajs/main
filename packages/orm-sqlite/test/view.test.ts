/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, LiteralQuoter, Orm, QueryContext, RawQuery } from '@spinajs/orm';
import { SqlLiteralQuoter } from '@spinajs/orm-sql';

import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf } from './common.js';

describe('sqlite views', function () {
  this.timeout(25000);

  let connection: SqliteOrmDriver;

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    await DI.resolve(Configuration);
    const orm = await DI.resolve(Orm);
    connection = orm.Connections.get('sqlite') as SqliteOrmDriver;

    await connection.executeOnDb(`CREATE TABLE IF NOT EXISTS view_users (Id INTEGER PRIMARY KEY AUTOINCREMENT, Login TEXT, Role TEXT)`, [], QueryContext.Schema);
    await connection.executeOnDb(`DELETE FROM view_users`, [], QueryContext.Delete);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  const view = (build: (view: CreateViewQueryBuilder) => void) => connection.schema().createView('view_admins', build);

  it('claims the shared literal quoter', () => {
    expect(connection.Container.resolve<LiteralQuoter>(LiteralQuoter)).to.be.instanceOf(SqlLiteralQuoter);
  });

  it('compiles the clauses sqlite has', () => {
    const result = view((v) => v.temporary().ifNotExists().columns(['Login']).as(new RawQuery('SELECT Login FROM view_users'))).toDB();

    expect(result.expression).to.eq('CREATE TEMP VIEW IF NOT EXISTS `view_admins` (`Login`) AS SELECT Login FROM view_users');
  });

  it('throws for the clauses sqlite does not have', () => {
    const raw = new RawQuery('SELECT 1');

    expect(() => view((v) => v.orReplace().as(raw)).toDB()).to.throw(MethodNotImplemented, 'sqlite does not support OR REPLACE');
    expect(() => view((v) => v.algorithm('MERGE').as(raw)).toDB()).to.throw(MethodNotImplemented, 'ALGORITHM');
    expect(() => view((v) => v.security('INVOKER').as(raw)).toDB()).to.throw(MethodNotImplemented, 'SQL SECURITY');
    expect(() => view((v) => v.checkOption().as(raw)).toDB()).to.throw(MethodNotImplemented, 'CHECK OPTION');
  });

  it('creates a view whose body carries a binding, reads through it and drops it', async () => {
    await connection.executeOnDb(`INSERT INTO view_users (Login, Role) VALUES (?, ?)`, ['alice', 'admin'], QueryContext.Insert);
    await connection.executeOnDb(`INSERT INTO view_users (Login, Role) VALUES (?, ?)`, ['bob', 'user'], QueryContext.Insert);

    await view((v) => v.ifNotExists().as((select) => select.from('view_users').where('Role', 'admin')));

    const rows = (await connection.executeOnDb(`SELECT Login FROM view_admins`, [], QueryContext.Select)) as any[];
    expect(rows.map((row) => row.Login)).to.deep.eq(['alice']);

    await connection.schema().dropView('view_admins').ifExists();

    const left = (await connection.executeOnDb(`SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'view_admins'`, [], QueryContext.Select)) as any[];
    expect(left).to.have.lengthOf(0);
  });
});
