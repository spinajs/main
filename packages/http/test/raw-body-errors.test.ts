import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { LimitExceeded } from '@spinajs/exceptions';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import '@spinajs/templates-pug';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, Get, HTTP_STATUS_CODE, HttpServer, UnsupportedMediaTypeException } from '../src/index.js';

@BasePath('raw-body-errors')
class RawBodyErrorsController extends BaseController {
  @Get()
  public limit() {
    throw new LimitExceeded('stream is over 10 bytes');
  }

  @Get()
  public unsupported() {
    throw new UnsupportedMediaTypeException('this route reads a raw request body');
  }
}

describe('raw body error responses', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(RawBodyErrorsController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(RawBodyErrorsController as Class<unknown>);
    DI.uncache(RawBodyErrorsController);
    DI.uncache(BaseController);
    DI.uncache(Configuration);
  });

  it('answers 413 for a LimitExceeded', async () => {
    const res = await req().get('raw-body-errors/limit');
    expect(res).to.have.status(HTTP_STATUS_CODE.ENTITY_TOO_LARGE);
    expect((res.body as { message: string }).message).to.eq('stream is over 10 bytes');
  });

  it('answers 415 for an UnsupportedMediaTypeException', async () => {
    const res = await req().get('raw-body-errors/unsupported');
    expect(res).to.have.status(415);
    expect((res.body as { message: string }).message).to.eq('this route reads a raw request body');
  });

  it('renders the 415 page for an html client', async () => {
    const res = await req().get('raw-body-errors/unsupported').set('Accept', 'text/html');
    expect(res).to.have.status(415);
    expect(res).to.be.html;
    expect(res.text).to.contain('415 - Unsupported media type');
  });
});
