import { AccessControl } from '@spinajs/rbac';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { TestConfiguration, req } from './common';
import { Controllers, HttpServer } from '@spinajs/http';
import 'mocha';
import sinon from 'sinon';

import { OrmHttpBootstrapper } from './../src/index';
import { expect } from 'chai';

describe('Http orm tests', () => {
  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    await DI.resolve(Controllers);
    await DI.resolve(Orm);
    const server = await DI.resolve(HttpServer);

    const b = await DI.resolve(OrmHttpBootstrapper);
    b.bootstrap();

    const ac = await DI.resolve<AccessControl>('AccessControl');
    ac.grant('admin').createAny('test').readAny('test').deleteAny('test').updateAny('test');
    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('api methods', function () {
    it('simple get', async () => {
      const result = await req().get('repository/test/1').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);
    });

    it('populate get', async () => {
      const result = await req().get('repository/test/1?include=Belongs,TestsTwos').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);
    });

    it('get all', async () => {
      const result = await req().get('repository/test').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);
    });

    it('get all with populate', async () => {
      const result = await req().get('repository/test?include=Belongs,TestsTwos').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);
    });
  });
});
