import 'mocha';
import { expect } from 'chai';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, Model, ModelBase, Orm, OrmDriver, Primary, QueryContext, readYourWrites } from '@spinajs/orm';
import _ from 'lodash';
import { randomBytes } from 'node:crypto';
import { PostgresOrmDriver } from '../../src/index.js';
import { adminQuery, PG_SERVER, requirePostgres } from './support.js';

const database = `orm_replicas_${randomBytes(4).toString('hex')}`;

class ReplicaConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [
            {
              Driver: 'orm-driver-postgres',
              Name: 'pgrr',
              ...PG_SERVER,
              Database: database,
              Options: { Schema: 'public' },
              Replicas: [{ Options: { Schema: 'replica' } }],
              Migration: { OnStartup: false },
            },
          ],
        },
      },
      (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

@Connection('pgrr')
@Model('rr_item')
class RrItem extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

async function readName(): Promise<string> {
  return (await RrItem.where({ Id: 1 }).firstOrFail()).Name;
}

describe('postgres read replicas (integration)', function () {
  this.timeout(60000);

  let orm: Orm | undefined;
  let primary: OrmDriver;

  before(async function () {
    await requirePostgres(this);
    await adminQuery(`CREATE DATABASE "${database}"`);
    DI.clearCache();
    DI.register(ReplicaConf).as(Configuration);
    DI.register(PostgresOrmDriver).as('orm-driver-postgres');

    orm = await DI.resolve(Orm);
    const pg = orm.Connections.get('pgrr') as PostgresOrmDriver;
    primary = pg;
    await pg.executeOnDb('CREATE SCHEMA replica', [], QueryContext.Schema);
    for (const schema of ['public', 'replica']) {
      await pg.executeOnDb(`CREATE TABLE ${schema}.rr_item ("Id" int PRIMARY KEY, "Name" text NOT NULL)`, [], QueryContext.Schema);
      await pg.executeOnDb(`INSERT INTO ${schema}.rr_item ("Id", "Name") VALUES (1, '${schema}')`, [], QueryContext.Insert);
    }
    await orm.reloadTableInfo();
  });

  afterEach(async () => {
    await primary?.update().in('rr_item').update({ Name: 'public' }).where({ Id: 1 });
  });

  after(async () => {
    await orm?.dispose();
    DI.unregister(ReplicaConf);
    DI.clearCache();
    await adminQuery(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
  });

  it('reads a model select from the replica outside any scope', async () => {
    expect(await readName()).to.eq('replica');
  });

  it('reads its own write inside a scope, and the replica again outside it', async () => {
    await readYourWrites(async () => {
      const item = await RrItem.where({ Id: 1 }).onPrimary().firstOrFail();
      item.Name = 'written';
      await item.update();

      expect(await readName()).to.eq('written');
    });

    expect(await readName()).to.eq('replica');
  });

  it('reads the primary inside a transaction', async () => {
    expect(await primary.transaction(() => readName())).to.eq('public');
  });
});
