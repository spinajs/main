import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { TestConfiguration, FakeRbacPolicy, req } from './common.js';
import { Controllers, HttpServer } from '@spinajs/http';
import { RbacPolicy } from '@spinajs/rbac-http';
import { expect } from 'chai';
import sinon from 'sinon';
import 'mocha';

import { Belongs } from './models/Belongs.js';
import { Test } from './models/Test.js';
import { Test2 } from './models/Test2.js';
import '../src/PlainJsonCollectionTransformer.js';
import '../src/index.js';

describe('crud get tests', function () {
  this.timeout(105000);

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    DI.setESMModuleSupport();

    DI.register(FakeRbacPolicy).as(RbacPolicy);

    await DI.resolve(Configuration);

    await DI.resolve(Controllers);
    const server = await DI.resolve(HttpServer);
    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();

    const orm = DI.get(Orm);
    orm.dispose();

    DI.uncache(Orm);
  });

  beforeEach(async () => {
    await DI.resolve(Orm);

    await Test.truncate();
    await Test2.truncate();
    await Belongs.truncate();

    await Belongs.insert([{ Text: 'Belongs-1' }, { Text: 'Belongs-2' }, { Text: 'Belongs-3' }]);
    await Test.insert([
      { Text: 'Test-1', belongs_id: 1 },
      { Text: 'Test-2', belongs_id: 2 },
      { Text: 'Test-3', belongs_id: 3 },
    ]);
    await Test2.insert([
      { Text: 'Test2-1', test_id: 1 },
      { Text: 'Test2-2', test_id: 1 },
      { Text: 'Test2-3', test_id: 2 },
      { Text: 'Test2-4', test_id: 2 },
      { Text: 'Test2-5', test_id: 3 },
    ]);
  });

  afterEach(async () => {
    sinon.restore();
  });

  describe('GET methods as guest', function () {
    it('GET /:model should return forbidden', async () => {});
    it('GET /:model/:id should return forbidden', async () => {});
    it('GET /:model/:id/:relation should return forbidden', async () => {});
    it('GET /:model/:id/:relation/:id should return forbidden', async () => {});

    it('GET /:model', async () => {
      const result = await req().get('collection/test').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);

      const data = JSON.parse(result.text);
      expect(data.Data).to.be.an('array');
      expect(data.Data).to.have.length(3);
      expect(data.Data[0].Id).to.eq(1);
      expect(data.Data[1].Id).to.eq(2);
      expect(data.Data[2].Id).to.eq(3);
    });

    it('GET /:model/:id', async () => {
      const result = await req().get('collection/test/1').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);

      const data = JSON.parse(result.text);
      expect(data.Id).to.eq(1);
    });

    it('GET /:model/:id/:relation', async () => {
      const result = await req().get('collection/test/1/teststwos').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);

      const data = JSON.parse(result.text);
      expect(data.Data).to.be.an('array');
      expect(data.Data).to.have.length(2);
      expect(data.Data[0].Id).to.eq(1);
      expect(data.Data[1].Id).to.eq(2);
      expect(data.Data[0].Text).to.eq('Test2-1');
      expect(data.Data[1].Text).to.eq('Test2-2');
    });
    it('GET /:model/:id/:relation/:id', async () => {
      const result = await req().get('collection/test/1/teststwos/1').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);

      const data = JSON.parse(result.text);
      expect(data.Id).to.eq(1);
      expect(data.Text).to.eq('Test2-1');
    });

    it('GET /:model/:id with & include', async () => {
      const result = await req().get('collection/test/1?includes=TestsTwos,Belongs').set('Accept', 'application/json').send();
      expect(result).to.have.status(200);

      const data = JSON.parse(result.text);
      expect(data.Id).to.eq(1);
      expect(data.Text).to.eq('Test-1');

      expect(data.Belongs).to.be.not.undefined;
      expect(data.Belongs.Text).to.eq('Belongs-1');
      expect(data.TestsTwos).to.be.not.undefined;
      expect(data.TestsTwos).to.be.an('array');
      expect(data.TestsTwos).to.have.length(2);
      expect(data.TestsTwos[0].Text).to.eq('Test2-1');
      expect(data.TestsTwos[1].Text).to.eq('Test2-2');
    });
  });

  describe('GET methods as logged user', function () {
    describe('Get any', function () {
      it('GET /:model should return forbidden', async () => {});
      it('GET /:model/:id should return forbidden', async () => {});
      it('GET /:model/:id/:relation should return forbidden', async () => {});
      it('GET /:model/:id/:relation/:id should return forbidden', async () => {});
      it('GET /:model/:id with & include should return forbidden ', async () => {});

      it('GET /:model', async () => {});
      it('GET /:model/:id', async () => {});
      it('GET /:model/:id/:relation', async () => {});
      it('GET /:model/:id/:relation/:id', async () => {});
    });

    describe('Get own', function () {
      it('GET /:model should return forbidden', async () => {});
      it('GET /:model/:id should return forbidden', async () => {});
      it('GET /:model/:id/:relation should return forbidden', async () => {});
      it('GET /:model/:id/:relation/:id should return forbidden', async () => {});
      it('GET /:model/:id with & include should return forbidden ', async () => {});

      it('GET /:model', async () => {});
      it('GET /:model/:id', async () => {});
      it('GET /:model/:id/:relation', async () => {});
      it('GET /:model/:id/:relation/:id', async () => {});
      it('GET /:model/:id with & include', async () => {});

      it('GET /:model should be filtered', async () => {});
      it('GET /:model/:id/:relation should be filtered', async () => {});
    });
  });
});
