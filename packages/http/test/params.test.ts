import 'mocha';
import * as fs from 'fs';
import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import sinon, { assert } from 'sinon';
import { expect } from 'chai';

import { fsService, fs as sFs } from '@spinajs/fs';

import { dir, req, TestConfiguration } from './common.js';
import { Controllers, HttpServer } from '../src/index.js';
import { CvsSampleObjectWithHydrator, CvsSampleObjectWithHydratorHydrator, SampleCvsModel, SampleModel, SampleObject, SampleObjectWithSchema } from './dto/index.js';
import { HeaderParams } from './controllers/params/HeaderParams.js';
import { UrlParams } from './controllers/params/UrlParams.js';
import { BodyParams } from './controllers/params/BodyParams.js';
import { FormParams } from './controllers/params/FormParams.js';
import { QueryParams } from './controllers/params/QueryParams.js';

import { CoockieParams } from './controllers/params/CoockieParams.js';
import { VariousParams } from './controllers/params/VariousParams.js';
import { TestTransformer as TestFileTransformer } from './file-transformers/custom-file-transformer.js';
import { CustomFileUploader } from './uploaders/custom-uploader.js';
import { CvsFileParams } from './controllers/params/CvsFileParams.js';

describe('controller action test params', function () {
  this.timeout(15000);
  const sb = sinon.createSandbox();

  before(async () => {
    sb.spy(QueryParams.prototype);
    sb.spy(HeaderParams.prototype);
    sb.spy(UrlParams.prototype);
    sb.spy(BodyParams.prototype);
    sb.spy(FormParams.prototype);
    sb.spy(CoockieParams.prototype);
    sb.spy(VariousParams.prototype);
    sb.spy(CustomFileUploader.prototype);
    sb.spy(TestFileTransformer.prototype);
    sb.spy(CvsFileParams.prototype);
    sb.spy(CvsSampleObjectWithHydratorHydrator.prototype);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    DI.register(TestConfiguration).as(Configuration);

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
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
    this.timeout(25000);

    it('simple query', async () => {
      await req().get('params/query/simple?a=hello&b=true&c=666');
      const spy = DI.get(QueryParams).simple as sinon.SinonSpy;

      expect(spy.args[0][0]).to.eq('hello');
      expect(spy.args[0][1]).to.eq(true);
      expect(spy.args[0][2]).to.eq(666);
    });

    it('queryObject', async () => {
      await req().get('params/query/queryObject?a={"id":1,"name":"test"}');

      const spy = DI.get(QueryParams).queryObject as sinon.SinonSpy;
      expect(spy.args[0][0].id).to.eq(1);
      expect(spy.args[0][0].name).to.eq('test');
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
    it('array', async () => {
      const spy = DI.get(QueryParams).array as sinon.SinonSpy;
      await req().get('params/query/array?a=["1","2","3"]');
      expect(spy.args[0][0]).to.be.an('array');
      expect(spy.args[0][0]).to.include.members(['1', '2', '3']);
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
      const spy = DI.get(HeaderParams).headerParamObjectWithSchema as sinon.SinonSpy;

      await req().get('params/headers/headerParamObjectWithSchema').set('x-custom-header', '{"id":1,"name":"test"}');
      expect(spy.args[0][0].constructor.name).to.eq('SampleObjectWithSchema');
      expect((spy.args[0][0] as SampleObjectWithSchema).id).to.eq(1);

      const badResult = await req().get('params/headers/headerParamObjectWithSchema').set('x-custom-header', '{"id":"ddd","name":"test"}').set('Accept', 'application/json');
      expect(badResult).to.have.status(400);
      expect(badResult).to.be.json;
      expect(badResult.body).to.be.not.null;
    });
  });

  describe('url params', function () {
    it('simple', async () => {
      const spy = DI.get(UrlParams).simple as sinon.SinonSpy;
      await req().get('params/url/simple/1');

      expect(spy.args[0][0]).to.eq(1);
    });

    it('simple should fail on invalid arg type', async () => {
      const result = await req().get('params/url/simple/hello').set('Accept', 'application/json');

      expect(result).to.have.status(400);
      expect(result).to.be.json;
      expect(result.body).to.be.not.null;
    });

    it('paramWithHydrator', async () => {
      const spy = DI.get(UrlParams).paramWithHydrator as sinon.SinonSpy;
      await req().get('params/url/paramWithHydrator/1111');

      expect(spy.args[0][0].constructor.name).to.eq('SampleModelWithHydrator2');
      expect(spy.args[0][0].id).to.eq(1111);
    });

    it('paramWithSchema', async () => {
      const spy = DI.get(UrlParams).paramWithSchema as sinon.SinonSpy;
      await req().get('params/url/paramWithSchema/1');

      expect(spy.args[0][0]).to.eq(1);

      const result = await req().get('params/url/paramWithSchema/11111').set('Accept', 'application/json');

      expect(result).to.have.status(400);
      expect(result).to.be.json;
      expect(result.body).to.be.not.null;
    });

    it('multipleParam', async () => {
      const spy = DI.get(UrlParams).multipleParam as sinon.SinonSpy;
      await req().get('params/url/multipleParam/1/test/true');

      expect(spy.args[0][0]).to.eq(1);
      expect(spy.args[0][1]).to.eq('test');
      expect(spy.args[0][2]).to.eq(true);
    });

    it('pkey', async () => {
      const spy = DI.get(UrlParams).pkey as sinon.SinonSpy;
      await req().get('params/url/pkey/1');

      expect(spy.args[0][0]).to.eq(1);

      const result = await req().get('params/url/pkey/hello').set('Accept', 'application/json');

      expect(result).to.have.status(400);
      expect(result).to.be.json;
      expect(result.body).to.be.not.null;
    });

    it('uuid', async () => {
      const spy = DI.get(UrlParams).uuid as sinon.SinonSpy;
      await req().get('params/url/uuid/eb05fc27-77d1-4807-a00a-8a4c86f9680f');

      expect(spy.args[0][0]).to.eq('eb05fc27-77d1-4807-a00a-8a4c86f9680f');

      let result = await req().get('params/url/uuid/eb05fc27-77d1-4807-a00a-0f').set('Accept', 'application/json');

      expect(result).to.have.status(400);
      expect(result).to.be.json;
      expect(result.body).to.be.not.null;

      result = await req().get('params/url/uuid/1').set('Accept', 'application/json');

      expect(result).to.have.status(400);
      expect(result).to.be.json;
      expect(result.body).to.be.not.null;
    });
  });

  describe('body params', function () {
    it('simple', async () => {
      const spy = DI.get(BodyParams).simple as sinon.SinonSpy;
      await req().post('params/body/simple').send({
        id: 1,
      });

      expect(spy.args[0][0]).to.eq(1);
    });

    it('bodyObject', async () => {
      const spy = DI.get(BodyParams).bodyObject as sinon.SinonSpy;
      await req().post('params/body/bodyObject').send({
        id: 1,
        name: 'test',
      });

      expect(spy.args[0][0].id).to.eq(1);
      expect(spy.args[0][0].name).to.eq('test');
    });

    it('multipleBodyObjects', async () => {
      const spy = DI.get(BodyParams).multipleBodyObjects as sinon.SinonSpy;
      await req()
        .post('params/body/multipleBodyObjects')
        .send({
          object1: { id: 1, name: 'test' },
          object2: { id: 2, name: 'test2' },
        });

      expect(spy.args[0][0].id).to.eq(1);
      expect(spy.args[0][0].name).to.eq('test');

      expect(spy.args[0][1].id).to.eq(2);
      expect(spy.args[0][1].name).to.eq('test2');
    });

    it('bodyModel', async () => {
      const spy = DI.get(BodyParams).bodyModel as sinon.SinonSpy;
      await req()
        .post('params/body/bodyModel')
        .send({
          id: 1,
          name: 'test',
          args: [1, 2, 3],
        });

      expect(spy.args[0][0].id).to.eq(1);
      expect(spy.args[0][0].name).to.eq('test');
      expect(spy.args[0][0].args).to.include.members([1, 2, 3]);
    });

    it('multipleBodyModel', async () => {
      const spy = DI.get(BodyParams).multipleBodyModel as sinon.SinonSpy;
      await req()
        .post('params/body/multipleBodyModel')
        .send({
          object1: {
            id: 1,
            name: 'test',
            args: [1, 2, 3],
          },

          object2: {
            id: 2,
            name: 'test2',
            args: [4, 5, 6],
          },
        });

      expect(spy.args[0][0].id).to.eq(1);
      expect(spy.args[0][0].name).to.eq('test');
      expect(spy.args[0][0].args).to.include.members([1, 2, 3]);

      expect(spy.args[0][1].id).to.eq(2);
      expect(spy.args[0][1].name).to.eq('test2');
      expect(spy.args[0][1].args).to.include.members([4, 5, 6]);
    });

    it('arrayOfHydratedModels', async () => {
      const spy = DI.get(BodyParams).arrayOfHydratedModels as sinon.SinonSpy;
      await req()
        .post('params/body/arrayOfHydratedModels')
        .send([
          {
            id: 1,
            name: 'test',
            args: [1, 2, 3],
          },
          {
            id: 2,
            name: 'test2',
            args: [4, 5, 6],
          },
        ]);

      expect(spy.args[0][0]).to.be.an('array');
      expect(spy.args[0][0][0].constructor.name).to.be.eq('SampleModelWithHydrator');

      expect(spy.args[0][0]).containSubset([
        {
          id: 1,
          name: 'test',
          args: [1, 2, 3],
        },
        {
          id: 2,
          name: 'test2',
          args: [4, 5, 6],
        },
      ]);
    });

    it('bodyArray', async () => {
      const spy = DI.get(BodyParams).bodyArray as sinon.SinonSpy;
      await req()
        .post('params/body/bodyArray')
        .send([
          {
            id: 1,
            name: 'test',
            args: [1, 2, 3],
          },
          {
            id: 2,
            name: 'test2',
            args: [4, 5, 6],
          },
        ]);

      expect(spy.args[0][0]).to.be.an('array');
      expect(spy.args[0][0]).containSubset([
        {
          id: 1,
          name: 'test',
          args: [1, 2, 3],
        },
        {
          id: 2,
          name: 'test2',
          args: [4, 5, 6],
        },
      ]);
    });

    it('bodyModelWithHydrator', async () => {
      const spy = DI.get(BodyParams).bodyModelWithHydrator as sinon.SinonSpy;
      await req()
        .post('params/body/bodyModelWithHydrator')
        .send({
          id: 1,
          name: 'test',
          args: [1, 2, 3],
        });

      expect(spy.args[0][0].constructor.name).to.eq('SampleModelWithHydrator');
      expect(spy.args[0][0].id).to.eq(1);
      expect(spy.args[0][0].name).to.eq('test');
      expect(spy.args[0][0].args).to.include.members([1, 2, 3]);
    });

    it('bodyModelWithSchema', async () => {
      const spy = DI.get(BodyParams).bodyModelWithSchema as sinon.SinonSpy;
      await req()
        .post('params/body/bodyModelWithSchema')
        .send({
          id: 1,
          name: 'test',
          args: [1, 2, 3],
        });

      expect(spy.args[0][0].id).to.eq(1);
      expect(spy.args[0][0].name).to.eq('test');
      expect(spy.args[0][0].args).to.include.members([1, 2, 3]);

      const result = await req()
        .post('params/body/bodyModelWithSchema')
        .send({
          id: 'hello',
          name: 'test',
        })
        .set('Accept', 'application/json');

      expect(result).to.have.status(400);
      expect(result).to.be.json;
      expect(result.body).to.be.not.null;
    });
  });

  describe('form params', function () {
    it('formField', async () => {
      const spy = FormParams.prototype.formField as sinon.SinonSpy;
      await req().post('params/forms/formField').field('name', 'test').type('form');
      expect(spy.args[0][0]).to.eq('test');
    });

    it('multipleFormField', async () => {
      const spy = FormParams.prototype.multipleFormField as sinon.SinonSpy;
      await req()
        .post('params/forms/multipleFormField')
        .field({
          name: 'test',
          name2: 'test2',
        })
        .type('form');
      expect(spy.args[0][0]).to.eq('test');
      expect(spy.args[0][1]).to.eq('test2');
    });

    it('formObject', async () => {
      const spy = FormParams.prototype.formObject as sinon.SinonSpy;
      await req()
        .post('params/forms/formObject')
        .field({
          id: 1,
          name: 'test',
        })
        .type('form');
      expect(spy.args[0][0].id).to.eq('1');
      expect(spy.args[0][0].name).to.eq('test');
    });

    it('formModel', async () => {
      const spy = FormParams.prototype.formModel as sinon.SinonSpy;
      await req()
        .post('params/forms/formModel')
        .field({
          id: 1,
          name: 'test',
          args: 1,
        })
        .type('form');
      expect(spy.args[0][0].constructor.name).to.eq('SampleModel');
      expect(spy.args[0][0].id).to.eq('1');
      expect(spy.args[0][0].name).to.eq('test');
    });

    it('formModelWithHydrator', async () => {
      const spy = FormParams.prototype.formModelWithHydrator as sinon.SinonSpy;
      await req()
        .post('params/forms/formModelWithHydrator')
        .field({
          id: 1,
          name: 'test',
          args: 1,
        })
        .type('form');

      expect(spy.args[0][0].constructor.name).to.eq('SampleModelWithHydrator3');
      expect(spy.args[0][0].id).to.eq('1');
      expect(spy.args[0][0].name).to.eq('test');
      expect(spy.args[0][0].args).to.eq(1);
    });

    it('formWithFile', async () => {
      const spy = FormParams.prototype.formWithFile as sinon.SinonSpy;
      await req()
        .post('params/forms/formWithFile')
        .field({
          id: 1,
          name: 'test',
        })
        .attach('file', fs.readFileSync(dir('./test-files') + '/test.txt'), { filename: 'test.txt' })
        .type('form');

      expect(spy.args[0][0].id).to.eq('1');
      expect(spy.args[0][0].name).to.eq('test');
      expect(spy.args[0][1].Name).to.eq('test.txt');

      const exists = await spy.args[0][1].Provider.exists(spy.args[0][1].BaseName);

      expect(exists).to.be.true;
    });

    it('fileArray', async () => {
      const spy = FormParams.prototype.fileArray as sinon.SinonSpy;
      await req()
        .post('params/forms/fileArray')
        .attach('files', fs.readFileSync(dir('./test-files') + '/test.txt'), { filename: 'test.txt' })
        .attach('files', fs.readFileSync(dir('./test-files') + '/test2.txt'), { filename: 'test2.txt' })
        .type('form');

      expect(spy.args[0][0]).to.be.an('array');
    });

    it('fileWithCustomUploader', async () => {
      const spy = FormParams.prototype.fileWithCustomUploader as sinon.SinonSpy;
      const uplSpy = CustomFileUploader.prototype.upload as sinon.SinonSpy;

      await req()
        .post('params/forms/fileWithCustomUploader')
        .attach('file', fs.readFileSync(dir('./test-files') + '/test.txt'), { filename: 'test.txt' });

      expect(spy.args[0][0].Name).to.eq('test.txt');
      expect(uplSpy.called).to.be.true;
    });

    it('fileWithCustomUploaderFs', async () => {
      const spy = FormParams.prototype.fileWithCustomUploaderFs as sinon.SinonSpy;
      const uplSpy = CustomFileUploader.prototype.upload as sinon.SinonSpy;

      await req()
        .post('params/forms/fileWithCustomUploaderFs')
        .attach('file', fs.readFileSync(dir('./test-files') + '/test.txt'), { filename: 'test.txt' });

      expect(spy.args[0][0].Name).to.eq('test.txt');
      expect(spy.args[0][0].Provider.Name).to.eq('test2');

      const tFs = DI.resolve<sFs>('__file_provider__', ['test2']);
      const exists = await tFs.exists(spy.args[0][0].BaseName);

      expect(exists).to.be.true;
      expect(uplSpy.called).to.be.true;

      await tFs.rm(spy.args[0][0].BaseName);
    });

    it('fileRequired', async () => {
      const result = await req()
        .post('params/forms/fileRequired')
        .field({
          id: 1,
          name: 'test',
        })
        .type('form');
      expect(result).to.have.status(400);
    });

    it('fileWithMaxSize', async () => {
      const spy = FormParams.prototype.fileWithMaxSize as sinon.SinonSpy;
      const response = await req()
        .post('params/forms/fileWithMaxSize')
        .attach('file', fs.readFileSync(dir('./test-files') + '/test3.txt'), { filename: 'test3.txt' });

      expect(response).to.have.status(413);

      await req()
        .post('params/forms/fileWithMaxSize')
        .attach('file', fs.readFileSync(dir('./test-files') + '/test.txt'), { filename: 'test.txt' });

      expect(spy.args[0][0].Name).to.eq('test.txt');
    });

    it('fileWithCustomTransformer', async () => {
      const spy = FormParams.prototype.fileWithCustomTransformers as sinon.SinonSpy;
      const trSpy = TestFileTransformer.prototype.beforeUpload as sinon.SinonSpy;

      await req()
        .post('params/forms/fileWithCustomTransformers')
        .attach('file', fs.readFileSync(dir('./test-files') + '/test3.txt'), { filename: 'test3.txt' });

      expect(spy.args[0][0].Name).to.eq('test3.txt');
      expect(trSpy.called).to.be.true;
    });

    it('fileWithZipTransformer', async () => {
      const spy = FormParams.prototype.fileWithZipTransformer as sinon.SinonSpy;
      await req()
        .post('params/forms/fileWithZipTransformer')
        .attach('file', fs.readFileSync(dir('./test-files') + '/test3.txt'), { filename: 'test3.txt' });

      expect(spy.args[0][0].Name).to.eq('test3.zip');
    });

    it('fileWithUnzipTransformer', async () => {
      const spy = FormParams.prototype.fileWithUnzipTransformer as sinon.SinonSpy;
      await req()
        .post('params/forms/fileWithUnzipTransformer')
        .attach('file', fs.readFileSync(dir('./test-files') + '/test3.zip'), { filename: 'test3.zip' });

      expect(spy.args[0][0]).to.be.not.undefined;
    });
  });

  describe('coockie params', function () {
    it('simple', async () => {
      const spy = CoockieParams.prototype.simple as sinon.SinonSpy;
      await req().get('params/coockie/simple').set('Cookie', 'name=hello');
      expect(spy.args[0][0]).to.eq('hello');
    });
  });

  describe('various tests', function () {
    it('inject service', async () => {
      const spy = VariousParams.prototype.di as sinon.SinonSpy;
      await req().get('params/mixed/di');

      expect(spy.args[0][0].constructor.name).to.eq('SomeService');
    });

    it('mixedArgs', async () => {
      const spy = VariousParams.prototype.mixedArgs as sinon.SinonSpy;
      await req()
        .post('params/mixed/mixedArgs/1?queryString=queryhello')
        .set('x-header', 'header')
        .send({
          model: {
            name: 'test',
          },
        });

      expect(spy.args[0][0].name).to.eq('test');
      expect(spy.args[0][1]).to.eq(1);
      expect(spy.args[0][2]).to.eq('header');
      expect(spy.args[0][3]).to.eq('queryhello');
    });
  });

  describe('from cvs file', function () {
    it('should parse csv file to objects', async () => {
      const spy = CvsFileParams.prototype.objectsFromCvs as sinon.SinonSpy;
      await req()
        .post('params/cvs/objectsFromCvs')
        .attach('objects', fs.readFileSync(dir('./test-files') + '/username.csv'), { filename: 'test.cvs' });

      expect(spy.args[0][0]).to.be.an('array');
      expect(spy.args[0][0]).containSubset([
        {
          FirstName: 'Rachel',
          Identifier: 9012,
          LastName: 'Booker',
          Username: 'booker12',
        },
      ]);
    });

    it('should parse csv file to models', async () => {
      const spy = CvsFileParams.prototype.modelsFromCvs as sinon.SinonSpy;
      await req()
        .post('params/cvs/modelsFromCvs')
        .attach('objects', fs.readFileSync(dir('./test-files') + '/username.csv'), { filename: 'test.cvs' });

      expect(spy.args[0][0]).to.be.an('array');
      expect(spy.args[0][0][0]).to.be.instanceOf(SampleCvsModel);
      expect(spy.args[0][0][0].Username).to.eq('booker12');
    });

    it('should parse csv file to objects with schema', async () => {
      const spy = CvsFileParams.prototype.modelsFromCvsWithSchema as sinon.SinonSpy;
      let res = await req()
        .post('params/cvs/modelsFromCvsWithSchema')
        .attach('objects', fs.readFileSync(dir('./test-files') + '/username.csv'), { filename: 'test.cvs' });

      expect(res.status).to.eq(200);
      expect(spy.args[0][0]).to.be.an('array');

      res = await req()
        .post('params/cvs/modelsFromCvsWithSchema')
        .attach('objects', fs.readFileSync(dir('./test-files') + '/username_invalid.csv'), { filename: 'test.cvs' });

      expect(res.status).to.eq(400);
    });

    it('should parse csv file to objectst with hydrator', async () => {
      const spy = CvsFileParams.prototype.modelsFromCvsWithHydrator as sinon.SinonSpy;
      const spy2 = CvsSampleObjectWithHydratorHydrator.prototype.hydrate as sinon.SinonSpy;
      await req()
        .post('params/cvs/modelsFromCvsWithHydrator')
        .set('Accept', 'application/json')
        .attach('objects', fs.readFileSync(dir('./test-files') + '/username.csv'), { filename: 'test.cvs' });
 
      expect(spy.args[0][0]).to.be.an('array');
      expect(spy.args[0][0][0]).to.be.instanceOf(CvsSampleObjectWithHydrator);
      expect(spy.args[0][0][0].Username).to.eq('booker12');

      expect(spy2.called).to.be.true;
    });
  });

  describe('from json files', function () {
    it('should parse json file to objects', async () => {});

    it('should parse json file to models', async () => {});

    it('should parse json file to objects with schema', async () => {});

    it('should parse json file to objectst with hydrator', async () => {});
  });
});
