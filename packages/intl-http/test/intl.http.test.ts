import 'mocha';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
import sinon from 'sinon';
import { req, TestConfiguration } from './common.js';
import '../src/index.js';

describe('http & controller tests', function () {
  this.timeout(25000);

  const middlewareSandbox = sinon.createSandbox();

  before(async () => {
    DI.register(TestConfiguration).as(Configuration);

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
});
