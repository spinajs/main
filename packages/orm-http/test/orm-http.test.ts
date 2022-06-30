import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { TestConfiguration, req } from './common';
import { Simple } from './controllers/Simple';
import { Controllers, HttpServer } from '@spinajs/http';
import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { OrmHttpBootstrapper } from './../src/index';

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

    const b = await DI.resolve(OrmHttpBootstrapper);
    b.bootstrap();
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

    it('should hydrate data to model', async () => {
      const spy = DI.get(Simple).testHydrate as sinon.SinonSpy;
      await req()
        .post('simple/testHydrate')
        .send({
          model: {
            Text: 'hydrated',
          },
        });

      expect(spy.args[0][0].constructor.name).to.eq('Test');
      expect(spy.args[0][0].Text).to.eq('hydrated');
    });
  });
});
