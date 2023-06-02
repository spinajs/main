// import { DI, Bootstrapper } from '@spinajs/di';
// import { Configuration } from '@spinajs/configuration';
// import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
// import { Orm } from '@spinajs/orm';
// import { TestConfiguration, FakeRbacPolicy, req } from './common.js';
// import { Controllers, HttpServer } from '@spinajs/http';
// import { RbacPolicy } from '@spinajs/rbac-http';
// import { expect } from 'chai';
// import sinon from 'sinon';
// import 'mocha';

// import { Belongs } from './models/Belongs.js';
// import { Test } from './models/Test.js';
// import { Test2 } from './models/Test2.js';
// import '../src/PlainJsonCollectionTransformer.js';
// import '../src/index.js';

// describe('crud get tests', function () {
//   this.timeout(105000);

//   before(async () => {
//     DI.clearCache();

//     DI.register(TestConfiguration).as(Configuration);
//     DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

//     DI.setESMModuleSupport();

//     DI.register(FakeRbacPolicy).as(RbacPolicy);

//     const botstrappers = await DI.resolve(Array.ofType(Bootstrapper));
//     for (const b of botstrappers) {
//       await b.bootstrap();
//     }

//     await DI.resolve(Configuration);
//     await DI.resolve(Controllers);

//     const server = await DI.resolve(HttpServer);
//     server.start();
//   });

//   after(async () => {
//     const server = await DI.resolve<HttpServer>(HttpServer);
//     server.stop();

//     const orm = DI.get(Orm);
//     orm.dispose();

//     DI.uncache(Orm);
//   });

//   beforeEach(async () => {
//     await DI.resolve(Orm);

//     await Test.truncate();
//     await Test2.truncate();
//     await Belongs.truncate();
//   });

//   afterEach(async () => {
//     sinon.restore();
//   });

//   it('POST /:model', async () => {
//     const m = new Test();
//     m.Text = 'test';

//     const result = await req().post('collection/test').set('Accept', 'application/json').send(m.dehydrate());
//     expect(result.status).to.be.eq(200);

//     const rm = JSON.parse(result.text);
//     expect(rm[0].Id).to.be.eq(1);
//   });

//   it('POST /:model/:id/:relation', async () => {
//     const m = new Test();
//     m.Text = 'test';
//     await m.insert();

//     const result = await req()
//       .post('collection/test/1/teststwos')
//       .set('Accept', 'application/json')
//       .send([
//         { Text: 'test1', test_id: 1 },
//         { Text: 'test2', test_id: 1 },
//         { Text: 'test3', test_id: 1 },
//       ]);
//     expect(result.status).to.be.eq(200);

//     const rm = JSON.parse(result.text);
//     expect(rm[0].Id).to.be.eq(1);
//     expect(rm[1].Id).to.be.eq(2);
//     expect(rm[2].Id).to.be.eq(3);

//     const m2 = await Test2.all();
//     expect(m2.length).to.be.eq(3);
//     expect(m2[0].Text).to.be.eq('test1');
//     expect(m2[1].Text).to.be.eq('test2');
//     expect(m2[2].Text).to.be.eq('test3');
//   });
// });
