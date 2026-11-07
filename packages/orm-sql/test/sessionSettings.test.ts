import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { NotSupported } from '@spinajs/exceptions';
import { ConnectionSessionSettings, Orm, SessionSettingsQueryBuilder } from '@spinajs/orm';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

function connection() {
  return DI.get(Orm)!.Connections.get('sqlite')!;
}

class FixedSettings extends ConnectionSessionSettings {
  async settings() {
    return { 'spina.a': '1' };
  }
}

describe('session settings on a dialect without them', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.unregister(FixedSettings);
    DI.uncache(ConnectionSessionSettings);
    DI.clearCache();
  });

  it('refuses to compile them, naming the settings', () => {
    const builder = connection().Container.resolve(SessionSettingsQueryBuilder, [connection(), { 'spina.a': '1' }]);
    expect(() => builder.toDB()).to.throw(NotSupported, /spina\.a/);
  });

  it('fails a transaction instead of running it without them', async () => {
    DI.register(FixedSettings).as(ConnectionSessionSettings);
    let ran = false;
    await expect(connection().transaction(async () => (ran = true))).to.be.rejectedWith(NotSupported);
    expect(ran).to.equal(false);
  });
});
