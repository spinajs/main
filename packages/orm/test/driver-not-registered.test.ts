import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';
import { Orm, OrmException } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class UnregisteredDriverConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: { Connections: [{ Driver: 'orm-driver-nobody-registered', Name: 'main' }] },
    };
  }
}

describe('a connection whose driver is not registered', () => {
  beforeEach(() => {
    DI.clearCache();
    DI.register(UnregisteredDriverConf).as(Configuration);
  });

  afterEach(() => {
    DI.unregister(UnregisteredDriverConf);
    DI.clearCache();
  });

  it('fails the Orm boot naming the driver token', async () => {
    await expect(Promise.resolve(DI.resolve(Orm))).to.be.rejectedWith(OrmException, 'ORM connection driver orm-driver-nobody-registered not registered');
  });
});
