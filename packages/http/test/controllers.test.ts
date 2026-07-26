import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import '@spinajs/templates-pug';

import { Controllers, HttpServer } from '../src/index.js';
import { SampleMiddleware2 } from './middlewares/SampleMiddleware2.js';
import { SamplePolicy2 } from './policies/SamplePolicy2.js';
import { req, TestConfiguration } from './common.js';
import { DataTransformer } from './../src/interfaces.js';
import { TestTransformer } from './transformers/TestTransformer.js';
import { SamplePolicy } from './policies/SamplePolicy.js';
import { SampleMiddleware } from './middlewares/SampleMiddleware.js';

import { TestMethods2 } from './controllers2/TestMethods2.js';

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

    DI.setESMModuleSupport();

    DI.register(TestConfiguration).as(Configuration);
    DI.register(TestTransformer).as(DataTransformer);

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
  });

  after(async () => {
    const server = await DI.resolve(HttpServer);
    server.stop();

    middlewareSandbox.restore();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should manual register controller', async () => {
    const c = await ctr();
    await c?.add(TestMethods2);

    const server = await DI.resolve(HttpServer);
    server.start();

    let response = await req().get('testmethods2/testGet2');
    expect(response).to.have.status(200);
  });

  it('should load controllers from dir', async () => {
    const controllers = await ctr()?.Controllers;
    expect(controllers?.length).to.eq(19);
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

  it('Multiple policy should allow if one ok', async () => {
    let response = await req().get('testpolicypath/testMultiplePolicies');
    expect(response).to.have.status(200);
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

  it('Response with promise should work', async () => {
    let response = await req().get('responses/fromPromise').set('Accept', 'application/json').send();
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
        message: 'sample error message',
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
    expect(response.header['content-type']).to.eq('text/plain; charset=utf-8');
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

  it('@Ip returns client ip', async () => {
    const response = await req().get('extra/ip').set('Accept', 'application/json').set('X-Forwarded-For', '203.0.113.7, 10.0.0.1').send();
    expect(response).to.have.status(200);
    expect(response.body.ip).to.eq('203.0.113.7');
  });

  it('@RequestId returns the per-request id matching the response header', async () => {
    const response = await req().get('extra/rid').set('Accept', 'application/json').send();
    expect(response).to.have.status(200);
    expect(response.body.rid).to.be.a('string').and.not.empty;
    // x-request-id / x-response-time headers must actually reach the client on
    // a normal matched route (regression guard: after() middleware never runs).
    expect(response.header['x-request-id']).to.eq(response.body.rid);
    expect(response.header['x-response-time']).to.match(/^\d+$/);
  });

  it('@UserAgent returns the user-agent header', async () => {
    const response = await req().get('extra/ua').set('Accept', 'application/json').set('User-Agent', 'spinajs-test/1').send();
    expect(response).to.have.status(200);
    expect(response.body.ua).to.eq('spinajs-test/1');
  });

  it('@Referer accepts referer/referrer spelling', async () => {
    const response = await req().get('extra/ref').set('Accept', 'application/json').set('Referer', 'https://example.com/p').send();
    expect(response).to.have.status(200);
    expect(response.body.ref).to.eq('https://example.com/p');
  });

  it('@RawBody exposes the exact request bytes', async () => {
    const payload = JSON.stringify({ a: 1, b: 'x' });
    const response = await req().post('extra/raw').set('Content-Type', 'application/json').set('Accept', 'application/json').send(payload);
    expect(response).to.have.status(200);
    expect(response.body.isBuffer).to.eq(true);
    expect(response.body.len).to.eq(Buffer.byteLength(payload));
  });

  it('@FromXml parses an XML body', async () => {
    const response = await req().post('extra/xml').set('Content-Type', 'application/xml').set('Accept', 'application/json').send('<envelope><body><id>7</id></body></envelope>');
    expect(response).to.have.status(200);
    expect(response.body).to.deep.include({ envelope: { body: { id: 7 } } });
  });

  it('@FromXml rejects malformed XML with 400', async () => {
    const response = await req().post('extra/xml').set('Content-Type', 'application/xml').set('Accept', 'application/json').send('<envelope><body></envelope>');
    expect(response).to.have.status(400);
  });

  it('required query param rejects when absent (400)', async () => {
    const response = await req().get('extra/required').set('Accept', 'application/json').send();
    expect(response).to.have.status(400);
  });

  it('required query param passes when present', async () => {
    const response = await req().get('extra/required?term=hello').set('Accept', 'application/json').send();
    expect(response).to.have.status(200);
    expect(response.body.term).to.eq('hello');
  });

  it('@Form parses arrays and nested objects', async () => {
    const response = await req()
      .post('extra/form')
      .set('Accept', 'application/json')
      .field('name', 'alice')
      .field('tags[]', 'a')
      .field('tags[]', 'b')
      .field('addr[city]', 'NYC')
      .field('addr[zip]', '10001');
    expect(response).to.have.status(200);
    expect(response.body).to.deep.equal({
      name: 'alice',
      tags: ['a', 'b'],
      addr: { city: 'NYC', zip: '10001' },
    });
  });

  it('typed-array body rejects non-array JSON with 400', async () => {
    const response = await req().post('extra/typedarr').set('Content-Type', 'application/json').set('Accept', 'application/json').send({ a: 1 });
    expect(response).to.have.status(400);
  });

  it('typed-array body accepts a JSON array', async () => {
    const response = await req().post('extra/typedarr').set('Content-Type', 'application/json').set('Accept', 'application/json').send([{ id: 1 }, { id: 2 }]);
    expect(response).to.have.status(200);
    expect(response.body.count).to.eq(2);
  });

  it('Ok(0) sends the numeric body, not empty', async () => {
    const response = await req().get('extra/zero').set('Accept', 'application/json').send();
    expect(response).to.have.status(200);
    expect(response.text).to.eq('0');
  });

  it('Ok(false) sends the boolean body, not empty', async () => {
    const response = await req().get('extra/bool').set('Accept', 'application/json').send();
    expect(response).to.have.status(200);
    expect(response.text).to.eq('false');
  });

  it('response honors an explicit StatusCode option', async () => {
    const response = await req().get('extra/status').set('Accept', 'application/json').send();
    expect(response).to.have.status(202);
    expect(response.body).to.deep.equal({ ok: true });
  });

  it('new Xml() sends an XML body', async () => {
    const response = await req().get('extra/xmlout').set('Accept', 'application/xml').buffer(true).send();
    expect(response).to.have.status(200);
    expect(response.header['content-type']).to.contain('application/xml');
    const body = response.text ?? (response.body instanceof Buffer ? response.body.toString() : '');
    expect(body).to.contain('<user><id>7</id></user>');
  });

  it('Redirect honors the status code', async () => {
    const response = await req().get('extra/goredirect').redirects(0).send();
    expect(response).to.have.status(301);
    expect(response.header['location']).to.eq('/extra/ip');
  });

  it('unsupported Accept returns 406 Not Acceptable', async () => {
    const response = await req().get('extra/ip').set('Accept', 'image/png').send();
    expect(response).to.have.status(406);
  });

  it('wildcard/absent Accept defaults to JSON', async () => {
    const response = await req().get('extra/ip').send();
    expect(response).to.have.status(200);
    expect(response.header['content-type']).to.contain('application/json');
  });
});
