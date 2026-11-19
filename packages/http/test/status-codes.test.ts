import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, Get, HTTP_STATUS_CODE, HttpServer, Json } from '../src/index.js';

@BasePath('status-codes')
class StatusCodesController extends BaseController {
  @Get()
  public literal() {
    return new Json({ field: 'name' }, { StatusCode: 422 });
  }

  @Get()
  public member() {
    return new Json({ field: 'name' }, { StatusCode: HTTP_STATUS_CODE.UNPROCESSABLE_CONTENT });
  }

  @Get()
  public gone() {
    return new Json(null, { StatusCode: HTTP_STATUS_CODE.GONE });
  }
}

describe('HTTP_STATUS_CODE', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(StatusCodesController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(StatusCodesController);
    DI.uncache(StatusCodesController);
    DI.uncache(BaseController);
  });

  it('answers 422 given as a number literal', async () => {
    const res = await req().get('status-codes/literal');
    expect(res.status).to.eq(422);
    expect(res.body).to.deep.eq({ field: 'name' });
  });

  it('answers 422 given as the enum member', async () => {
    const res = await req().get('status-codes/member');
    expect(res.status).to.eq(422);
  });

  it('answers 410 Gone', async () => {
    const res = await req().get('status-codes/gone');
    expect(res.status).to.eq(410);
  });

  it('has the standard 2xx to 5xx codes and keeps the existing members', () => {
    expect({
      MULTI_STATUS: HTTP_STATUS_CODE.MULTI_STATUS,
      MULTIPLE_CHOICES: HTTP_STATUS_CODE.MULTIPLE_CHOICES,
      PAYMENT_REQUIRED: HTTP_STATUS_CODE.PAYMENT_REQUIRED,
      GONE: HTTP_STATUS_CODE.GONE,
      PRECONDITION_FAILED: HTTP_STATUS_CODE.PRECONDITION_FAILED,
      UNPROCESSABLE_CONTENT: HTTP_STATUS_CODE.UNPROCESSABLE_CONTENT,
      PRECONDITION_REQUIRED: HTTP_STATUS_CODE.PRECONDITION_REQUIRED,
      BAD_GATEWAY: HTTP_STATUS_CODE.BAD_GATEWAY,
      GATEWAY_TIMEOUT: HTTP_STATUS_CODE.GATEWAY_TIMEOUT,
      NOT_ALLOWED: HTTP_STATUS_CODE.NOT_ALLOWED,
      ENTITY_TOO_LARGE: HTTP_STATUS_CODE.ENTITY_TOO_LARGE,
      INTERNAL_ERROR: HTTP_STATUS_CODE.INTERNAL_ERROR,
    }).to.deep.eq({
      MULTI_STATUS: 207,
      MULTIPLE_CHOICES: 300,
      PAYMENT_REQUIRED: 402,
      GONE: 410,
      PRECONDITION_FAILED: 412,
      UNPROCESSABLE_CONTENT: 422,
      PRECONDITION_REQUIRED: 428,
      BAD_GATEWAY: 502,
      GATEWAY_TIMEOUT: 504,
      NOT_ALLOWED: 405,
      ENTITY_TOO_LARGE: 413,
      INTERNAL_ERROR: 500,
    });
  });
});
