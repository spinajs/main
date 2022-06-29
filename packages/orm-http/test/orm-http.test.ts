import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import chai from 'chai';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { TestConfiguration } from './common';
import { Simple } from './controllers/Simple';
import { Controllers, HttpServer } from '@spinajs/http';
import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import chaiHttp from 'chai-http';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

export function req() {
  return chai.request('http://localhost:1337/');
}

describe('Http orm tests', () => {
  const sb = sinon.createSandbox();

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    sb.spy(Simple.prototype as any);

    await DI.resolve(Controllers);
    await DI.resolve(Orm);
    const server = await DI.resolve(HttpServer);

    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    sb.restore();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('query params', function () {
    it('simple query', async () => {
      const spy = DI.get(Simple).testGet as sinon.SinonSpy;

      await req().get('simple/1');

      expect(spy.args[0][0].constructor.name).to.eq('Test');
      expect(spy.args[0][0].Text).to.equal('witaj');
    });
  });
});
