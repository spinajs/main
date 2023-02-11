// import { DI } from '@spinajs/di';
// import { Configuration } from '@spinajs/configuration';
// import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
// import { Orm } from '@spinajs/orm';
// import { TestConfiguration, req } from './common.js';
// import { Controllers, HttpServer, BasePolicy, Request as sRequest } from '@spinajs/http';
// import { RbacPolicy } from '@spinajs/rbac-http';

// import 'mocha';
// import sinon from 'sinon';

// import '../src/index.js';

// import { expect } from 'chai';
// // import { Belongs } from './models/Belongs.js';
// import { Test } from './models/Test.js';
// import { Test2 } from './models/Test2.js';

// class FakeRbacPolicy extends BasePolicy {
//   isEnabled(): boolean {
//     return true;
//   }
//   execute(_req: sRequest): Promise<void> {
//     return Promise.resolve();
//   }
// }

// describe('Http orm tests', function () {
//   this.timeout(105000);

//   before(async () => {
//     DI.register(TestConfiguration).as(Configuration);
//     DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

//     DI.setESMModuleSupport();

//     DI.register(FakeRbacPolicy).as(RbacPolicy);

//     await DI.resolve(Configuration);
//     await DI.resolve(Orm);
//     await DI.resolve(Controllers);
//     const server = await DI.resolve(HttpServer);
//     server.start();
//   });

//   after(async () => {
//     const server = await DI.resolve<HttpServer>(HttpServer);
//     server.stop();
//   });

//   afterEach(() => {
//     sinon.restore();
//   });

//   describe('api methods', function () {
//     it('get one', async () => {
//       const result = await req().get('collection/test/1').set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);
//       expect(result).to.be.json;
//       expect(JSON.parse(result.text)).to.eql({
//         Id: 1,
//         Text: "witaj"
//       })
//     });

//     it('should 404 on get one', async () => {
//       const result = await req().get('collection/test/22').set('Accept', 'application/json').send();
//       expect(result).to.have.status(404);
//     });

//     it('should 404 on get one for relation', async () => {
//       const result = await req().get('collection/test/1/teststwos/12').set('Accept', 'application/json').send();
//       expect(result).to.have.status(404);
//     });

//     it('get all', async () => {
//       const result = await req().get('collection/test').set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);

//       expect(data.Total).to.eq(2);
//       expect(data.Data).to.be.an('array');
//       expect(data.Data[0]).to.eql({
//         Id: 1,
//         Text: "witaj"
//       });

//       expect(data.Data[1]).to.eql({
//         Id: 2,
//         Text: "swiecie"
//       })
//     });

//     it('get all relations', async () => {
//       const result = await req().get('collection/test/1/testtwos').set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data.Total).to.eq(4);
//       expect(data.Data[0]).to.eql({
//         Id: 1,
//         Text: 'hello',
//         test_id: 1
//       });

//       expect(data.Data[1]).to.eql({
//         Id: 2,
//         Text: 'world',
//         test_id: 1
//       });
//     });

//     it('get relation', async () => {
//       const result = await req().get('collection/test/1/testtwos/3').set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data).to.eql({
//         Id: 3,
//         Text: 'hello'
//       });
//     });

//     it('get all with filters', async () => {

//       const result = await req().get('collection/test?filter={"Text":"swiecie"}').set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data.Data[0]).to.eql({
//         Id: 2,
//         Text: 'swiecie'
//       });
//     });

//     it('get all with limit & pagination', async () => {
//       const result = await req().get('collection/test?page=2&perPage=1').set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data.Data[0]).to.eql({
//         Id: 2,
//         Text: 'swiecie'
//       });
//     });

//     it('get all relation with filters', async () => {

//       const result = await req().get('collection/test/1/testtwos?filter={"Text":"world"}').set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data.Data[0]).to.eql({
//         Id: 2,
//         Text: 'world'
//       });
//       expect(data.Data[0]).to.eql({
//         Id: 3,
//         Text: 'world'
//       });
//     });

//     it('get all relation with limit & pagination', async () => {
//       const result = await req().get('collection/test/1/testtwos?page=2&perPage=2').set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data.Data[0]).to.eql({
//         Id: 2,
//         Text: 'world'
//       });
//       expect(data.Data[0]).to.eql({
//         Id: 3,
//         Text: 'world'
//       });
//     });

//     it('insert one', async () => {
//       const m = new Test();
//       m.Text = 'added';

//       const result = await req().post('repository/test').set('Accept', 'application/json').send(m.toJSON());
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data.Id).to.eq(3);

//       const r = await Test.where("Text", "added").first();
//       expect(r).to.be.not.null;
//       expect(r.Id).to.eq(3);

//     });

//     it('insert many', async () => {

//       const toAdd = [
//         new Test({ Text: 'added1' }),
//         new Test({ Text: 'added2' }),
//         new Test({ Text: 'added3' })
//       ]

//       const result = await req().post('repository/test').set('Accept', 'application/json').send(
//         toAdd
//       );
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data.length).to.eq(3);
//       expect(data[0].Id).to.eq(4);
//       expect(data[1].Id).to.eq(5);
//       expect(data[2].Id).to.eq(6);

//       expect(data[0].Text).to.eq('added1');
//       expect(data[1].Text).to.eq('added2');
//       expect(data[2].Text).to.eq('added3');

//       const models = await Test.query().whereIn('Id', [4, 5, 6]);
//       expect(models.length).to.eq(3);
//       expect(models[0].Id).to.eq(4);
//       expect(models[1].Id).to.eq(5);
//       expect(models[2].Id).to.eq(6);

//     });

//     it('insert one relation', async () => {
//       const m = new Test2({ Text: 'added1' })
//       const result = await req().post('repository/test/1/testtwos').set('Accept', 'application/json').send(
//         m
//       );

//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data.Id).to.eq(4);

//       const r = await Test2.where('Id', 4).first();
//       expect(r.Id).to.eq(4);
//     });

//     it('insert many relation', async () => {

//       const toAdd = [
//         new Test2({ Text: 'added1' }),
//         new Test2({ Text: 'added2' }),
//         new Test2({ Text: 'added3' })
//       ]

//       const result = await req().post('repository/test/1/testtwos').set('Accept', 'application/json').send(
//         toAdd
//       );
//       expect(result).to.have.status(200);

//       const data = JSON.parse(result.text);
//       expect(data.length).to.eq(3);
//       expect(data[0].Id).to.eq(4);
//       expect(data[1].Id).to.eq(5);
//       expect(data[2].Id).to.eq(6);

//       expect(data[0].Text).to.eq('added1');
//       expect(data[1].Text).to.eq('added2');
//       expect(data[2].Text).to.eq('added3');

//       const models = await Test2.query().whereIn('Id', [4, 5, 6]);
//       expect(models.length).to.eq(3);
//       expect(models[0].Id).to.eq(4);
//       expect(models[1].Id).to.eq(5);
//       expect(models[2].Id).to.eq(6);
//     });

//     it('delete one', async () => {

//       const m = new Test({ Text: 'added1' });
//       await m.insert();

//       const result = await req().del('repository/test/' + m.Id).set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);

//       const m2 = Test.where('Id', m.Id);
//       expect(m2).to.be.null;
//     });

//     it('delete many', async () => {

//       const m = new Test({ Text: 'added1' });
//       await m.insert();

//       const m2 = new Test({ Text: 'added2' });
//       await m2.insert();

//       const result = await req().post('repository/test:deleteBulk').set('Accept', 'application/json').send(
//         [m.Id, m2.Id]
//       );
//       expect(result).to.have.status(200);

//       const r = await Test.query().whereIn('Id', [m.Id, m2.Id]);
//       expect(r.length).to.eq(0);
//     });

//     it('delete one relation', async () => {

//       const m = new Test2({ Text: 'added1' });
//       await m.insert();

//       const result = await req().del('repository/test/1/testtwos/' + m.Id).set('Accept', 'application/json').send();

//       expect(result).to.have.status(200);

//       const m2 = Test2.where('Id', m.Id);
//       expect(m2).to.be.null;
//     });

//     it('delete many relation', async () => {

//       const m = new Test2({ Text: 'added1' });
//       await m.insert();

//       const m2 = new Test2({ Text: 'added2' });
//       await m2.insert();

//       const result = await req().post('repository/test/1/testtwos:deleteBulk').set('Accept', 'application/json').send(
//         [m.Id, m2.Id]
//       );

//       expect(result).to.have.status(200);

//       const r = await Test2.query().whereIn('Id', [m.Id, m2.Id]);
//       expect(r.length).to.eq(0);

//     });

//     it('delete one should return 404 ', async () => {
//       const result = await req().post('repository/test/55/testtwos/1').set('Accept', 'application/json').send();
//       expect(result).to.have.status(200);
//     });

//     it('update one', async () => {

//       const result = await req().put('repository/test/1').set('Accept', 'application/json').send(
//         { Text: 'updated' }
//       );

//       expect(result).to.have.status(200);

//       const m = await Test.where("Id", 1).first();
//       expect(m.Text).to.eq('updated');
//     });

//     it('update one relation', async () => {

//       const result = await req().put('repository/test/1/testtwos/1').set('Accept', 'application/json').send(
//         { Text: 'updated' }
//       );

//       expect(result).to.have.status(200);

//       const m = await Test2.where("Id", 1).first();
//       expect(m.Text).to.eq('updated');

//     });
//   });
// });
