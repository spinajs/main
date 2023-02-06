import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { TestConfiguration, req } from './common.js';
import { Controllers, HttpServer, BasePolicy, Request as sRequest } from '@spinajs/http';
import { RbacPolicy } from '@spinajs/rbac-http';

import 'mocha';
import sinon from 'sinon';

import '../src/index.js';

import { expect } from 'chai';
// import { Belongs } from './models/Belongs.js';
import { Test } from './models/Test.js';
// import { Test2 } from './models/Test2.js';

class FakeRbacPolicy extends BasePolicy {
  isEnabled(): boolean {
    return true;
  }
  execute(_req: sRequest): Promise<void> {
    return Promise.resolve();
  }
}

describe('Http orm tests', function () {
  this.timeout(105000);

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    DI.setESMModuleSupport();

    DI.register(FakeRbacPolicy).as(RbacPolicy);

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
    await DI.resolve(Controllers);
    const server = await DI.resolve(HttpServer);
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
    it('get one', async () => {
      const result = await req().get('collection/test/1').set('Accept', 'application/json').send();

      expect(result).to.have.status(200);
    });

    it('should 404 on get one', async () => {
      const result = await req().get('collection/test/22').set('Accept', 'application/json').send();

      expect(result).to.have.status(404);
    });

    it('should 404 on get one for relation', async () => {
      const result = await req().get('collection/test/22').set('Accept', 'application/json').send();
      expect(result).to.have.status(404);
    });

    it('get all', async () => {
      const result = await req().get('collection/test').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);
      expect(result).to.be.an('array');
    });

    it('get all relations', async () => {});

    it('get relation', async () => {});

    it('get all with filters', async () => {});

    it('get all with limit & pagination', async () => {});

    it('get all relation with filters', async () => {});

    it('get all relation with limit & pagination', async () => {});

    it('insert one', async () => {
      const m = new Test();
      m.Text = 'hello';

      const result = await req().post('repository/test').set('Accept', 'application/json').send(m.toJSON());
      expect(result).to.have.status(200);
    });

    it('insert many', async () => {
      const result = await req().get('repository/test?include=Belongs,TestsTwos').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);
    });

    it('insert one relation', async () => {});

    it('insert many relation', async () => {});

    it('delete one', async () => {});

    it('delete one should return 404', async () => {});

    it('delete many', async () => {});

    it('delete one relation', async () => {});

    it('delete many relation', async () => {});

    it('delete one should return 404', async () => {});

    it('update one', async () => {});

    it('update one relation', async () => {});
  });
});
