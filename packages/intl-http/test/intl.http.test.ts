import 'mocha';

import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import '@spinajs/fs';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
import sinon from 'sinon';
import { req, TestConfiguration } from './common.js';
import '../src/index.js';
import { TestResponses } from './controllers/TestResponses.js';

describe('http & controller tests', function () {
  this.timeout(25000);

  const middlewareSandbox = sinon.createSandbox();

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

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

  it('Pug resposne should be internationalized', async () => {
    let response = await req().get('responses/testPugIntl?lang=en').set('Accept', 'text/html').send();
    expect(response).to.have.status(200);
    expect(response).to.be.html;
    expect(response.text).to.eq('<html><head><title> Sample view</title></head><body>   <p>sample view</p><p>hello world</p></body></html>');

    response = await req().get('responses/testPugIntl?lang=pl').set('Accept', 'text/html').send();
    expect(response).to.have.status(200);
    expect(response).to.be.html;
    expect(response.text).to.eq('<html><head><title> Sample view</title></head><body>   <p>sample view</p><p>witaj świecie</p></body></html>');
  });

  it('Query param should be ok', async () => {
    const s = sinon.spy(TestResponses.prototype, 'testLangFromParam');

    let response = await req().get('responses/testLangFromParam?lang=en').set('Accept', 'application/json').send();
    expect(response).to.have.status(200);
    expect(s.callCount).to.eq(1);
    expect(s.args[0][0]).to.eq('en');
  });

  it('Query param should be ok with allowed languages', async () => {
    const s = sinon.spy(TestResponses.prototype, 'testLangAllowedLanguages');

    let response = await req().get('responses/testLangAllowedLanguages?lang=en').set('Accept', 'application/json').send();
    expect(response).to.have.status(200);
    expect(s.callCount).to.eq(1);
    expect(s.args[0][0]).to.eq('en');
  });

  it('Query param should not be ok with not allowed language', async () => {
    let response = await req().get('responses/testLangAllowedLanguages?lang=de').set('Accept', 'application/json').send();
    expect(response).to.have.status(400);
  });

  it('Query param faild with validation', async () => {
    let response = await req().get('responses/testLangAllowedLanguages?lang=de_dddd').set('Accept', 'application/json').send();
    expect(response).to.have.status(400);
  });
});
