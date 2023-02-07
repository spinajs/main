import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { TestConfiguration, req, FakeRbacPolicy } from './common.js';
import { Controllers, HttpServer } from '@spinajs/http';
import { RbacPolicy } from '@spinajs/rbac-http';

import 'mocha';
import sinon from 'sinon';

import '../src/index.js';

import { expect } from 'chai';
import { Belongs } from './models/Belongs.js';
import { Test } from './models/Test.js';
import { Test2 } from './models/Test2.js';

describe('crud delete tests', function () {
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

    DI.clearCache();
  });

  afterEach(async () => {
    sinon.restore();

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
    ]);
  });

  it('DEL /:model', async () => {
    // const m = new Test({ Text: 'added1' });
    // await m.insert();

    // const result = await req()
    //   .del('repository/test/' + m.Id)
    //   .set('Accept', 'application/json')
    //   .send();
    // expect(result).to.have.status(200);

    // const m2 = Test.where('Id', m.Id);
    // expect(m2).to.be.null;
  });

  it('DEL /:model:bulkDelete', async () => {});

  it('DEL /:model/:id/:relation/:id', async () => {});

  it('DEL /:model/:id/:relation/:id oneToOne relation', async () => {});

  it('DEL /:model/:id/:relation/:id:bulkDelete', async () => {
    const m = new Test2({ Text: 'added1' });
    await m.insert();

    const m2 = new Test2({ Text: 'added2' });
    await m2.insert();

    const result = await req().post('repository/test/1/testtwos:deleteBulk').set('Accept', 'application/json').send([m.Id, m2.Id]);

    expect(result).to.have.status(200);

    const r = await Test2.query().whereIn('Id', [m.Id, m2.Id]);
    expect(r.length).to.eq(0);
  });

  it('DEL /:model/:id should throw', async () => {});

  it('DEL /:model/:id/:relation/:id should throw when no owner', async () => {});
});
