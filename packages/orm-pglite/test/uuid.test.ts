import 'mocha';
import { expect } from 'chai';
import { FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';
import { Connection, Model, ModelBase, Orm, Primary, QueryContext, Uuid } from '@spinajs/orm';
import { createTestApp, type TestApp } from '@spinajs/testing';

import { PgliteOrmDriver } from '../src/index.js';

const CONNECTION = 'pglite-uuid';

class PgliteUuidConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] });
    this.set('db', { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: CONNECTION }] });
  }
}

@Connection(CONNECTION)
@Model('pgl_uuid_item')
class PglUuidItem extends ModelBase {
  @Primary()
  @Uuid()
  public Id: string;

  public Name: string;
}

describe('@Uuid() on PGlite', function () {
  this.timeout(60000);

  let app: TestApp | undefined;
  let driver: PgliteOrmDriver;

  before(async () => {
    app = await createTestApp({ configuration: PgliteUuidConfiguration, register: (c) => c.register(PgliteOrmDriver).as('orm-driver-pglite') });
    const orm = await app.resolve(Orm);
    driver = orm.Connections.get(CONNECTION) as PgliteOrmDriver;
    await driver.executeOnDb('CREATE TABLE pgl_uuid_item ("Id" bytea PRIMARY KEY, "Name" text)', [], QueryContext.Schema);
    await orm.reloadTableInfo();
  });

  after(async () => {
    await app?.dispose();
  });

  it('writes a uuid key as 16 bytes and reads it back as its dashed text', async () => {
    const id = '0db8f7f5-56cd-4801-ac23-ad6d78bfec3f';
    await new PglUuidItem({ Id: id, Name: 'first' }).insert();

    const [raw] = (await driver.executeOnDb('SELECT "Id" FROM pgl_uuid_item', [], QueryContext.Select)) as Array<{ Id: Uint8Array }>;
    expect(raw.Id).to.be.instanceOf(Uint8Array);
    expect(raw.Id.byteLength).to.eq(16);

    const [item] = await PglUuidItem.all();
    expect(item.Id).to.eq(id);
  });
});
