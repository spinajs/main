import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import { FsBootsrapper } from '@spinajs/fs';
import '@spinajs/templates-pug';

import { Controllers, HttpServer } from '../src/index.js';
import { SampleMiddleware2 } from './middlewares/SampleMiddleware2.js';
import { SamplePolicy2 } from './policies/SamplePolicy2.js';
import { req, TestConfiguration } from './common.js';
import { DataTransformer } from './../src/interfaces.js';
import { TestTransformer } from './transformers/TestTransformer.js';
import { SamplePolicy } from './policies/SamplePolicy.js';
import { SampleMiddleware } from './middlewares/SampleMiddleware.js';

function ctr() {
  return DI.get(Controllers);
}

describe('http & controller tests', function () {
  this.timeout(85000);

  const middlewareSandbox = sinon.createSandbox();
  let middlewareOnBeforeSpy: sinon.SinonSpy<any, any>;
  let middlewareOnAfterSpy: sinon.SinonSpy<any, any>;
  let middlewareOnResponseSpy: sinon.SinonSpy<any, any>;

  let middleware2OnBeforeSpy: sinon.SinonSpy<any, any>;
  let middleware2OnAfterSpy: sinon.SinonSpy<any, any>;
  let middleware2OnResponseSpy: sinon.SinonSpy<any, any>;

  let samplePolicyExecuteSpy: sinon.SinonSpy<any, any>;
  let samplePolicy2ExecuteSpy: sinon.SinonSpy<any, any>;

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    middlewareOnAfterSpy = middlewareSandbox.spy(SampleMiddleware.prototype, 'onAfter');
    middlewareOnBeforeSpy = middlewareSandbox.spy(SampleMiddleware.prototype, 'onBefore');
    middlewareOnResponseSpy = middlewareSandbox.spy(SampleMiddleware.prototype, 'onResponse');

    middleware2OnAfterSpy = middlewareSandbox.spy(SampleMiddleware2.prototype, 'onAfter');
    middleware2OnBeforeSpy = middlewareSandbox.spy(SampleMiddleware2.prototype, 'onBefore');
    middleware2OnResponseSpy = middlewareSandbox.spy(SampleMiddleware2.prototype, 'onResponse');

    samplePolicyExecuteSpy = middlewareSandbox.spy(SamplePolicy.prototype, 'execute');
    samplePolicy2ExecuteSpy = middlewareSandbox.spy(SamplePolicy2.prototype, 'execute');

    DI.register(TestConfiguration).as(Configuration);
    DI.register(TestTransformer).as(DataTransformer);

    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    const server = await DI.resolve(HttpServer);

    server.start();
  });

  after(async () => {
    const server = await DI.resolve(HttpServer);
    server.stop();

    middlewareSandbox.restore();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should load controllers from dir', async () => {
    const controllers = await ctr()?.Controllers;
    expect(controllers?.length).to.eq(18);
  });

  it('should server static files', async () => {
    const response = await req().get('public/index.html');
    expect(response).to.have.status(200);
  });

  it('non existing static file should return 404', async () => {
    const response = await req().get('public/non-exists.html');
    expect(response).to.have.status(404);
  });

  it('should add routes', async () => {
    let response = await req().get('testmethods/testGet');
    expect(response).to.have.status(200);

    response = await req().post('testmethods/testPost');
    expect(response).to.have.status(200);

    response = await req().head('testmethods/testHead');
    expect(response).to.have.status(200);

    response = await req().patch('testmethods/testPatch');
    expect(response).to.have.status(200);

    response = await req().del('testmethods/testDel');
    expect(response).to.have.status(200);

    response = await req().put('testmethods/testPut');
    expect(response).to.have.status(200);
  });

  it('should add routes with base path', async () => {
    let response = await req().get('test-base-path/testGet');
    expect(response).to.have.status(200);

    response = await req().post('test-base-path/testPost');
    expect(response).to.have.status(200);

    response = await req().head('test-base-path/testHead');
    expect(response).to.have.status(200);

    response = await req().patch('test-base-path/testPatch');
    expect(response).to.have.status(200);

    response = await req().del('test-base-path/testDel');
    expect(response).to.have.status(200);

    response = await req().put('test-base-path/testPut');
    expect(response).to.have.status(200);
  });

  it('middleware should run on controller', async () => {
    let response = await req().get('testmiddleware/testGet');
    expect(response).to.have.status(200);

    expect(middlewareOnAfterSpy.calledOnce).to.be.true;
    expect(middlewareOnBeforeSpy.calledOnce).to.be.true;
    expect(middlewareOnResponseSpy.calledOnce).to.be.true;

    response = await req().get('testmiddleware/testGet2');
    expect(response).to.have.status(200);

    expect(middlewareOnAfterSpy.calledTwice).to.be.true;
    expect(middlewareOnBeforeSpy.calledTwice).to.be.true;
    expect(middlewareOnResponseSpy.calledTwice).to.be.true;
  });

  it('middleware should run on specific path', async () => {
    let response = await req().get('testmiddlewarepath/testGet2');
    expect(response).to.have.status(200);
    expect(middleware2OnAfterSpy.calledOnce).to.be.false;
    expect(middleware2OnBeforeSpy.calledOnce).to.be.false;
    expect(middleware2OnResponseSpy.calledOnce).to.be.false;

    response = await req().get('testmiddlewarepath/testGet');
    expect(response).to.have.status(200);

    expect(middleware2OnAfterSpy.calledOnce).to.be.true;
    expect(middleware2OnBeforeSpy.calledOnce).to.be.true;
    expect(middleware2OnResponseSpy.calledTwice).to.be.false;
  });

  it('policy should run on controller', async () => {
    let response = await req().get('testpolicy/testGet');
    expect(response).to.have.status(200);
    expect(samplePolicyExecuteSpy.calledOnce).to.be.true;

    response = await req().get('testpolicy/testGet2');
    expect(response).to.have.status(200);
    expect(samplePolicyExecuteSpy.calledTwice).to.be.true;
  });

  it('policy should run on specific path', async () => {
    let response = await req().get('testpolicypath/testGet2');
    expect(response).to.have.status(200);
    expect(samplePolicy2ExecuteSpy.called).to.be.false;

    response = await req().get('testpolicypath/testGet');
    expect(response).to.have.status(200);

    expect(samplePolicy2ExecuteSpy.called).to.be.true;
  });

  it('Policy should forbidden specific path', async () => {
    let response = await req().get('testpolicypath/testGet3');
    expect(response).to.have.status(403);
  });

  it('html response should work', async () => {
    const response = await req().get('responses/data').set('Accept', 'text/html').send();
    expect(response).to.have.status(200);
    expect(response).to.be.html;
    expect(response.text).to.eq('<html><head><link rel="icon" type="image/x-icon" href="/_static/favicon.png"/><title> All ok</title><link href="/_static/style.css" rel="stylesheet"/></head><body>   <div class="container"><div class="item"><div class="entry"><h1>200 - All ok</h1></div></div></div></body></html>');
  });

  it('json response should work', async () => {
    const response = await req().get('responses/data').set('Accept', 'application/json').send();
    expect(response).to.have.status(200);
    expect(response).to.be.json;
    expect(response.body).to.be.not.null;
    expect(response.body).to.include({
      message: 'hello world',
    });
  });

  it('Pug resposne should work', async () => {
    const response = await req().get('responses/testPug').set('Accept', 'text/html').send();
    expect(response).to.have.status(200);
    expect(response).to.be.html;
    expect(response.text).to.eq('<html><head><title> Sample view</title></head><body>   <p>sample view</p><p>hello world</p></body></html>');
  });

  it('Pug resposne should fail on request as non text/html', async () => {
    const response = await req().get('responses/testPug').set('Accept', 'application/json').send();
    expect(response).to.have.status(400);
    expect(response).to.be.json;
    expect(response.body).to.be.not.null;
    expect(response.body).to.deep.equal({
      error: {
        code: 400,
        message: 'invalid request content type',
      },
    });
  });

  it('Should return error 500', async () => {
    const response = await req().get('responses/testError').set('Accept', 'application/json').send();
    expect(response).to.have.status(500);
    expect(response).to.be.json;
    expect(response.body).to.be.not.null;
    expect(response.body).to.deep.equal({
      error: {
        message: 'sample error message',
      },
    });
  });

  it('Should transform data', async () => {
    const response = await req().get('responses/testDataTransformer').set('Accept', 'application/json').set('x-data-transform', 'test-transform').send();
    expect(response).to.have.status(200);
    expect(response).to.be.json;
    expect(response.body).to.be.not.null;
    expect(response.body).to.deep.equal({
      message: 'hello world transformed',
    });
  });

  it('Should get file', async () => {
    const response = await req().get('files/file').send();

    expect(response).to.have.status(200);
    expect(response.header['content-length']).to.be.not.null;
    expect(response.header['content-type']).to.eq('text/plain; charset=UTF-8');
  });

  it('Should get zip', async () => {
    const response = await req().get('files/zippedFile').send();
    expect(response).to.have.status(200);
    expect(response.header['content-length']).to.be.not.null;
    expect(response.header['content-type']).to.eq('application/zip');
  });

  it('Should get json file', async () => {
    const response = await req().get('files/jsonFile').send();
    expect(response).to.have.status(200);
    expect(response.header['content-length']).to.be.not.null;
  });
});
