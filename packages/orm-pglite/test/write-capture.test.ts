import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, InsertQueryBuilder, Model, ModelBase, Orm, Primary, QueryContext, WriteObserver, createQuery } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, QueryBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { PgliteOrmDriver } from '../src/index.js';

class PgliteCaptureConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    Object.assign(this.Config, {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: 'pglite-capture', Filename: ':memory:', Migration: { OnStartup: false } }] },
    });
  }
}

@Connection('pglite-capture')
@Model('pgl_cap_member')
class PglCapMember extends ModelBase {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

const writes: CapturedWrite[] = [];

class Recorder extends WriteObserver {
  interest(query: QueryBuilder): CaptureInterest | undefined {
    return query.Model === PglCapMember ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    writes.push(write);
  }
}

describe('write capture on PGlite', function () {
  this.timeout(60000);

  let orm: Orm | undefined;

  before(async () => {
    DI.clearCache();
    DI.register(PgliteCaptureConf).as(Configuration);
    DI.register(PgliteOrmDriver).as('orm-driver-pglite');
    DI.register(Recorder).as(WriteObserver);
    orm = await DI.resolve(Orm);
    const driver = orm.Connections.get('pglite-capture') as PgliteOrmDriver;
    await driver.executeOnDb('CREATE TABLE pgl_cap_member ("Id" serial PRIMARY KEY, "Email" text UNIQUE, "Name" text)', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE UNIQUE INDEX pgl_cap_member_pair ON pgl_cap_member ("Name", "Email")', [], QueryContext.Schema);
    await driver.executeOnDb(`INSERT INTO pgl_cap_member ("Id", "Email", "Name") VALUES (1, 'a', 'one'), (2, 'x', 'two')`, [], QueryContext.Schema);
    await orm.reloadTableInfo();
  });

  after(async () => {
    DI.unregister(Recorder);
    await orm?.dispose();
    DI.clearCache();
  });

  it('reads an upsert by its ON CONFLICT target alone, whatever other unique indexes the table has', async () => {
    const { query } = createQuery(PglCapMember, InsertQueryBuilder);
    query.values({ Id: 5, Email: 'x', Name: 'new' }).onDuplicate('Email').update(['Name']);
    await query;

    expect(writes[0].unknownKeys).to.eq(false);
    expect(writes[0].rows).to.deep.eq([{ id: '2', before: { Id: 2, Email: 'x', Name: 'two' }, after: { Id: 2, Email: 'x', Name: 'new' } }]);
  });
});
