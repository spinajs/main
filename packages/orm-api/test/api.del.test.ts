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
import './../src/PlainJsonCollectionTransformer.js';
import '../src/index.js';

describe('crud delete tests', function () {
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

  it('DEL /:model', async () => {
    const result = await req().del('collection/test/1').set('Accept', 'application/json').send();
    expect(result).to.have.status(200);
    const m2 = await Test.where('Id', 1).first();
    expect(m2).to.be.undefined;
  });

  it('DEL /:model/__batchDelete', async () => {
    const result = await req().post('collection/test/__batchDelete').set('Accept', 'application/json').send([1, 2, 3]);
    expect(result).to.have.status(200);
    const m2 = await Test.query().whereIn('Id', [1, 2, 3]);
    expect(m2.length).to.eq(0);
  });

  it('DEL /:model/:id/:relation/:id', async () => {
    const result = await req().del('collection/test/1/teststwos/1').set('Accept', 'application/json').send();
    expect(result).to.have.status(200);
    const m2 = await Test2.query().where('Id', 1).first();
    expect(m2).to.be.undefined;
  });

  it('DEL /:model/:id/:relation/:id should throw if parent not exists', async () => {
    const result = await req().del('collection/test/111/teststwos/1').set('Accept', 'application/json').send();
    expect(result).to.have.status(404);
  });

  it('DEL /:model/:id/:relation/:id oneToOne relation', async () => {
    const result = await req().del('collection/test/1/belongs/1').set('Accept', 'application/json').send();
    expect(result).to.have.status(200);

    const m2 = await Belongs.query().where('Id', 1).first();
    expect(m2).to.be.undefined;

    const m3 = await Test.query().where('Id', 1).populate('Belongs').first();
    expect(m3).to.not.be.undefined;
    expect(m3.Belongs.Value).to.be.undefined;
  });

  it('DEL /:model/:id/:relation/__batchDelete', async () => {
    const result = await req().post('collection/test/1/teststwos/__batchDelete').set('Accept', 'application/json').send([1, 2]);
    expect(result).to.have.status(200);
    const m2 = await Test2.query().whereIn('Id', [1, 2]);
    expect(m2.length).to.be.eq(0);
  });
});
