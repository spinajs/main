import { QueryParams } from './controllers/params/QueryParams';
import 'mocha';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '../src';
import { Intl } from '@spinajs/intl';
import sinon, { assert } from 'sinon';
import { req, TestConfiguration } from './common';
import { expect } from 'chai';
import { SampleModel, SampleObject } from './dto';
import { HeaderParams } from './controllers/params/HeaderParams';

describe('controller action test params', function () {
  this.timeout(15000);
  const sb = sinon.createSandbox();

  before(async () => {
    sb.spy(QueryParams.prototype as any);
    sb.spy(HeaderParams.prototype as any);

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    const server = await DI.resolve<HttpServer>(HttpServer);

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
      await req().get('params/query/simple?a=hello&b=true&c=666');
      assert.calledWith(DI.get(QueryParams).simple as sinon.SinonSpy, 'hello', true, 666);
    });

    it('queryObject', async () => {
      await req().get('params/query/queryObject?a={"id":1,"name":"test"}');
      assert.calledWith(DI.get(QueryParams).queryObject as sinon.SinonSpy, {
        id: 1,
        name: 'test',
      });
    });
    it('queryModel', async () => {
      await req().get('params/query/queryModel?a={"id":1,"name":"test","args":[1,2,3]}');
      const spy = DI.get(QueryParams).queryModel as sinon.SinonSpy;

      expect(spy.args[0][0].constructor.name).to.eq('SampleModel');
      expect((spy.args[0][0] as SampleModel).id).to.eq(1);
      expect((spy.args[0][0] as SampleModel).name).to.eq('test');
      expect((spy.args[0][0] as SampleModel).args).to.include.members([1, 2, 3]);
    });
    it('queryMixedData', async () => {
      await req().get('params/query/queryMixedData?a={"id":1,"name":"test","args":[1,2,3]}&b={"id":1,"name":"test"}&c=hello world');
      const spy = DI.get(QueryParams).queryMixedData as sinon.SinonSpy;

      expect(spy.args[0][0].constructor.name).to.eq('SampleModel');
      expect((spy.args[0][0] as SampleModel).id).to.eq(1);
      expect((spy.args[0][0] as SampleModel).name).to.eq('test');
      expect((spy.args[0][0] as SampleModel).args).to.include.members([1, 2, 3]);

      expect((spy.args[0][1] as SampleObject).id).to.eq(1);
      expect((spy.args[0][1] as SampleObject).name).to.eq('test');

      expect(spy.args[0][2]).to.eq('hello world');
    });
    it('queryObjectWithSchema', async () => {
      await req().get('params/query/queryObjectWithSchema?a={"id":1,"name":"test"}');
      assert.calledWith(DI.get(QueryParams).queryObject as sinon.SinonSpy, {
        id: 1,
        name: 'test',
      });
      const badResult = await req().get('params/query/queryObjectWithSchema?a={"id":"hello","name":"test"}').set('Accept', 'application/json');
      expect(badResult).to.have.status(400);
      expect(badResult).to.be.json;
      expect(badResult.body).to.be.not.null;
    });
    it('queryModelWithSchema', async () => {
      await req().get('params/query/queryModelWithSchema?a={"id":1,"name":"test","args":[1,2,3]}');
      const spy = DI.get(QueryParams).queryModel as sinon.SinonSpy;

      expect(spy.args[0][0].constructor.name).to.eq('SampleModel');
      expect((spy.args[0][0] as SampleModel).id).to.eq(1);
      expect((spy.args[0][0] as SampleModel).name).to.eq('test');
      expect((spy.args[0][0] as SampleModel).args).to.include.members([1, 2, 3]);

      const badResult = await req().get('params/query/queryModelWithSchema?a={"id":"hello","name":"test","args":[1,2,3]}').set('Accept', 'application/json');
      expect(badResult).to.have.status(400);
      expect(badResult).to.be.json;
      expect(badResult.body).to.be.not.null;
    });
    it('queryDate', async () => {
      const spy = DI.get(QueryParams).queryDate as sinon.SinonSpy;

      await req().get('params/query/queryDate?a=2022-06-28T20:59:55Z');

      expect(spy.args[0][0].constructor.name).to.eq('DateTime');
      expect(spy.args[0][0].toFormat('dd-MM-yyyy')).to.eq('28-06-2022');
    });
    it('queryDateFromUnixtime', async () => {
      const spy = DI.get(QueryParams).queryDateFromUnixtime as sinon.SinonSpy;

      await req().get('params/query/queryDateFromUnixtime?a=1656367511');

      expect(spy.args[0][0].constructor.name).to.eq('DateTime');
      expect(spy.args[0][0].toFormat('dd-MM-yyyy')).to.eq('28-06-2022');
    });
    it('queryUuid', async () => {
      const spy = DI.get(QueryParams).queryUuid as sinon.SinonSpy;
      await req().get('params/query/queryUuid?a=3e9eb5ac-e2bb-4b11-9931-afc3ec7245fb');
      expect(spy.args[0][0]).to.eq('3e9eb5ac-e2bb-4b11-9931-afc3ec7245fb');
    });
    it('pkey', async () => {
      const spy = DI.get(QueryParams).pkey as sinon.SinonSpy;
      await req().get('params/query/pkey?id=1');
      expect(spy.args[0][0]).to.eq(1);
    });
  });

  describe('headers params', function () {
    it('headerParam', async () => {
      await req().get('params/headers/headerParam').set('x-custom-header', 'hello world');
      assert.calledWith(DI.get(HeaderParams).headerParam as sinon.SinonSpy, 'hello world');
    });

    it('headerDate', async () => {
      const spy = DI.get(HeaderParams).headerDate as sinon.SinonSpy;

      await req().get('params/headers/headerDate').set('x-custom-header', 'Date: Wed, 21 Oct 2015 07:28:00 GMT');
      expect(spy.args[0][0].constructor.name).to.eq('DateTime');
      expect(spy.args[0][0].toFormat('dd-MM-yyyy HH:mm:ss')).to.eq('21-10-2015 09:28:00');
    });

    it('headerParamNoName', async () => {
      const spy = DI.get(HeaderParams).headerParamNoName as sinon.SinonSpy;

      await req().get('params/headers/headerParamNoName').set('customHeaderName', 'hello world');
      expect(spy.args[0][0]).to.eq('hello world');
    });

    it('headerParamObject', async () => {
      await req().get('params/headers/headerParamObject').set('x-custom-header', '{"id":1,"name":"test"}');
      assert.calledWith(DI.get(HeaderParams).headerParamObject as sinon.SinonSpy, {
        id: 1,
        name: 'test',
      });
    });
    it('headerParamModel', async () => {
      const spy = DI.get(HeaderParams).headerParamModel as sinon.SinonSpy;
      await req().get('params/headers/headerParamModel').set('x-custom-header', '{"id":1,"name":"test","args":[1,2,3]}');

      expect(spy.args[0][0].constructor.name).to.eq('SampleModel');
      expect((spy.args[0][0] as SampleModel).id).to.eq(1);
      expect((spy.args[0][0] as SampleModel).name).to.eq('test');
      expect((spy.args[0][0] as SampleModel).args).to.include.members([1, 2, 3]);
    });
    it('headerParamObjectWithSchema', async () => {
      await req().get('params/headers/headerParamObjectWithSchema').set('x-custom-header', '{"id":1,"name":"test"}');
      assert.calledWith(DI.get(HeaderParams).headerParamObjectWithSchema as sinon.SinonSpy, {
        id: 1,
        name: 'test',
      });
      const badResult = await req().get('params/headers/headerParamObjectWithSchema').set('x-custom-header', '{"id":"ddd","name":"test"}').set('Accept', 'application/json');
      expect(badResult).to.have.status(400);
      expect(badResult).to.be.json;
      expect(badResult.body).to.be.not.null;
    });
  });

  describe('url params', function () {});

  describe('body params', function () {});

  describe('form params', function () {});

  describe('coockie params', function () {});

  describe('from cvs file', function () {});

  describe('from json files', function () {});

  describe('custom types', function () {});

  describe('date types', function () {});
});
