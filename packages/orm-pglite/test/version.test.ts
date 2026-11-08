import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, Model, ModelBase, OptimisticLockError, Orm, Primary, QueryContext, Version } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { PgliteOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class PgliteVersionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    Object.assign(this.Config, {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: 'pglite-version', Filename: ':memory:', Migration: { OnStartup: false } }] },
    });
  }
}

@Connection('pglite-version')
@Model('pgl_ver_doc')
class PglVerDoc extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  @Version()
  public Revision: number;
}

describe('@Version optimistic locking on PGlite', function () {
  this.timeout(60000);

  let orm: Orm | undefined;

  before(async () => {
    DI.clearCache();
    DI.register(PgliteVersionConf).as(Configuration);
    DI.register(PgliteOrmDriver).as('orm-driver-pglite');
    orm = await DI.resolve(Orm);
    const driver = orm.Connections.get('pglite-version') as PgliteOrmDriver;
    await driver.executeOnDb('CREATE TABLE pgl_ver_doc ("Id" serial PRIMARY KEY, "Title" text, "Revision" int NOT NULL)', [], QueryContext.Schema);
    await orm.reloadTableInfo();
  });

  after(async () => {
    await orm?.dispose();
    DI.unregister(PgliteVersionConf);
    DI.clearCache();
  });

  async function stalePair(): Promise<[PglVerDoc, PglVerDoc]> {
    const doc = new PglVerDoc({ Title: 'draft' });
    await doc.insert();
    expect(doc.Revision).to.eq(1);
    const a = await PglVerDoc.where({ Id: doc.Id }).firstOrFail();
    const b = await PglVerDoc.where({ Id: doc.Id }).firstOrFail();
    a.Title = 'from a';
    await a.update();
    expect(a.Revision).to.eq(2);
    return [a, b];
  }

  it('update() refuses a stale copy', async () => {
    const [, b] = await stalePair();
    b.Title = 'from b';

    await expect(b.update()).to.be.rejectedWith(OptimisticLockError);
  });

  it('save() refuses a stale copy', async () => {
    const [, b] = await stalePair();
    b.Title = 'from b';

    await expect(b.save()).to.be.rejectedWith(OptimisticLockError);
  });

  it('destroy() refuses a stale copy', async () => {
    const [, b] = await stalePair();

    await expect(b.destroy()).to.be.rejectedWith(OptimisticLockError);
  });
});
