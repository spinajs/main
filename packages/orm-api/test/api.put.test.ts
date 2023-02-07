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

describe('crud put tests', function () {
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

  it('PUT /:model', async () => {
    const result = await req().put('collection/test/1').set('Accept', 'application/json').send({ Id: 1, Text: 'test1-putted' });
    expect(result.status).to.be.eq(200);

    const m = await Test.get(1);
    expect(m.Text).to.be.eq('test1-putted');
  });

  it('PUT /:model/:id/:relation', async () => {
    const result = await req().put('collection/test/1/teststwos/1').set('Accept', 'application/json').send({ Id: 1, Text: 'Test2-1-putted' });
    expect(result.status).to.be.eq(200);

    const m = await Test2.get(1);
    expect(m.Text).to.be.eq('Test2-1-putted');
  });
});
