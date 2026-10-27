import 'mocha';
import { expect } from 'chai';
import { LimitExceeded } from '@spinajs/exceptions';
import { Intl } from '@spinajs/intl';
import '@spinajs/templates-pug';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, Controllers, Get, HTTP_STATUS_CODE, HttpServer, UnsupportedMediaTypeException } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

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

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(RawBodyErrorsController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('answers 413 for a LimitExceeded', async () => {
    const res = await req().get('raw-body-errors/limit');
    expect(res).to.have.status(HTTP_STATUS_CODE.ENTITY_TOO_LARGE);
    expect((res.body as { detail: string }).detail).to.eq('stream is over 10 bytes');
  });

  it('answers 415 for an UnsupportedMediaTypeException', async () => {
    const res = await req().get('raw-body-errors/unsupported');
    expect(res).to.have.status(415);
    expect((res.body as { detail: string }).detail).to.eq('this route reads a raw request body');
  });

  it('renders the 415 page for an html client', async () => {
    const res = await req().get('raw-body-errors/unsupported').set('Accept', 'text/html');
    expect(res).to.have.status(415);
    expect(res).to.be.html;
    expect(res.text).to.contain('415 - Unsupported media type');
  });
});
