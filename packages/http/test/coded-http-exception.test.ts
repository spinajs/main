import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import * as exceptions from '@spinajs/exceptions';
import { Forbidden, ResourceNotFound, UnexpectedServerError } from '@spinajs/exceptions';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import {
  BaseController,
  BasePath,
  CodedHttpException,
  CodedHttpExceptionResponse,
  Controllers,
  Get,
  HTTP_STATUS_CODE,
  HttpServer,
  OnError,
  answeredAsServerError,
} from '../src/index.js';

type InvoiceCode = 'invoice.locked' | 'invoice.missing' | 'storage.unavailable';

class InvoiceException extends CodedHttpException<InvoiceCode, { invoice: string }> {}

class DomainRefusal extends Error {}

@BasePath('coded')
@OnError(DomainRefusal, (err) => new CodedHttpException(422, 'invoice.refused', err.message))
class CodedController extends BaseController {
  @Get()
  public plain() {
    throw new CodedHttpException(409, 'invoice.locked', 'The invoice is locked');
  }

  @Get()
  public withDetails() {
    throw new InvoiceException(409, 'invoice.locked', 'The invoice is locked', { invoice: '2026-0042' });
  }

  @Get()
  public subclass() {
    throw new InvoiceException(404, 'invoice.missing', 'No such invoice');
  }

  @Get()
  public serverSide() {
    throw new CodedHttpException(503, 'storage.unavailable', 'Storage is unavailable', undefined, new Error('ECONNREFUSED 10.0.0.7:9000'));
  }

  @Get()
  public defaultMessage() {
    throw new CodedHttpException(400, 'input.invalid');
  }

  @Get()
  @OnError(ResourceNotFound, () => new CodedHttpException(404, 'invoice.missing', 'No such invoice'))
  public routeHandler() {
    throw new ResourceNotFound('SELECT * FROM invoices WHERE id = 42 returned nothing');
  }

  @Get()
  public classHandler() {
    throw new DomainRefusal('Paid invoices cannot be edited');
  }

  @Get()
  @OnError(Forbidden, (err) => new CodedHttpExceptionResponse(new CodedHttpException(403, 'invoice.forbidden', err.message)))
  public responseFromHandler() {
    throw new Forbidden('Only the owner can send the invoice');
  }

  @Get()
  public overriddenStatus() {
    return new CodedHttpExceptionResponse(new CodedHttpException(409, 'invoice.locked', 'The invoice is locked'), { StatusCode: HTTP_STATUS_CODE.SERVICE_UNAVAILABLE });
  }

  @Get()
  public invalidStatus() {
    throw new CodedHttpException(200, 'invoice.locked');
  }
}

class ProductionConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.configuration = { isProduction: true };
  }
}

async function startWith(configuration: typeof TestConfiguration) {
  uncacheControllers();
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
  DI.register(configuration).as(Configuration);
  DI.register(CodedController).as(BaseController);
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Intl);
  await DI.resolve(Controllers);
  await (await DI.resolve<HttpServer>(HttpServer)).start();
}

async function stop(configuration: typeof TestConfiguration) {
  await releaseHttpServer();
  DI.unregister(CodedController as Class<unknown>);
  DI.uncache(CodedController);
  DI.uncache(BaseController);
  DI.unregister(configuration);
  DI.uncache(Configuration);
}

describe('CodedHttpException', function () {
  this.timeout(15000);

  before(() => startWith(TestConfiguration));

  after(() => stop(TestConfiguration));

  it('answers { code, message } with its status and no stack outside production', async () => {
    const res = await req().get('coded/plain').set('Accept', 'application/json');

    expect(res.status).to.eq(409);
    expect(res.body).to.deep.eq({ code: 'invoice.locked', message: 'The invoice is locked' });
  });

  it('adds details when the exception carries them', async () => {
    const res = await req().get('coded/withDetails').set('Accept', 'application/json');

    expect(res.status).to.eq(409);
    expect(res.body).to.deep.eq({ code: 'invoice.locked', message: 'The invoice is locked', details: { invoice: '2026-0042' } });
  });

  it('answers a subclass through the inherited mapping', async () => {
    const res = await req().get('coded/subclass').set('Accept', 'application/json');

    expect(res.status).to.eq(404);
    expect(res.body).to.deep.eq({ code: 'invoice.missing', message: 'No such invoice' });
  });

  it('keeps a 5xx body to code and message, leaving the inner error out', async () => {
    const res = await req().get('coded/serverSide').set('Accept', 'application/json');

    expect(res.status).to.eq(503);
    expect(res.body).to.deep.eq({ code: 'storage.unavailable', message: 'Storage is unavailable' });
  });

  it('uses the code as the message when none is given', async () => {
    const res = await req().get('coded/defaultMessage').set('Accept', 'application/json');

    expect(res.status).to.eq(400);
    expect(res.body).to.deep.eq({ code: 'input.invalid', message: 'input.invalid' });
  });

  it('answers JSON to a client that asks for HTML', async () => {
    const res = await req().get('coded/plain').set('Accept', 'text/html');

    expect(res.status).to.eq(409);
    expect(res).to.be.json;
    expect(res.body).to.deep.eq({ code: 'invoice.locked', message: 'The invoice is locked' });
  });

  it('answers an exception a route @OnError handler returns in place of the original error', async () => {
    const res = await req().get('coded/routeHandler').set('Accept', 'application/json');

    expect(res.status).to.eq(404);
    expect(res.body).to.deep.eq({ code: 'invoice.missing', message: 'No such invoice' });
  });

  it('answers an exception a controller @OnError handler returns', async () => {
    const res = await req().get('coded/classHandler').set('Accept', 'application/json');

    expect(res.status).to.eq(422);
    expect(res.body).to.deep.eq({ code: 'invoice.refused', message: 'Paid invoices cannot be edited' });
  });

  it('answers the response an @OnError handler builds from an exception', async () => {
    const res = await req().get('coded/responseFromHandler').set('Accept', 'application/json');

    expect(res.status).to.eq(403);
    expect(res.body).to.deep.eq({ code: 'invoice.forbidden', message: 'Only the owner can send the invoice' });
  });

  it('takes IResponseOptions.StatusCode over the status of the exception', async () => {
    const res = await req().get('coded/overriddenStatus').set('Accept', 'application/json');

    expect(res.status).to.eq(503);
    expect(res.body).to.deep.eq({ code: 'invoice.locked', message: 'The invoice is locked' });
  });

  it('answers a constructor that refuses its status with 500: the bug is the server one, not the client one', async () => {
    const res = await req().get('coded/invalidStatus').set('Accept', 'application/json');

    expect(res.status).to.eq(500);
  });

  it('is the class of @spinajs/exceptions, re-exported', () => {
    expect(CodedHttpException).to.eq(exceptions.CodedHttpException);
  });

  it('is not answered as a server error', () => {
    expect(answeredAsServerError(new CodedHttpException(503, 'storage.unavailable'))).to.eq(false);
    expect(answeredAsServerError(new InvoiceException(409, 'invoice.locked'))).to.eq(false);
  });

  it('keeps status, code and details as own enumerable fields, and name out of them', () => {
    const err = new InvoiceException(409, 'invoice.locked', 'The invoice is locked', { invoice: '2026-0042' });

    expect({ ...err }).to.deep.eq({ status: 409, code: 'invoice.locked', details: { invoice: '2026-0042' } });
    expect(err.name).to.eq('InvoiceException');
    expect(err).to.be.instanceOf(CodedHttpException);
  });

  it('refuses a status that is not a 4xx or 5xx', () => {
    for (const status of [200, 302, 399, 600, 404.5, NaN]) {
      expect(() => new CodedHttpException(status, 'input.invalid'), String(status)).to.throw(UnexpectedServerError);
    }
  });

  it('narrows the code to the declared union', () => {
    // @ts-expect-error 'invoice.paid' is not an InvoiceCode
    const err = new InvoiceException(409, 'invoice.paid');

    expect(err.code).to.eq('invoice.paid');
  });
});

describe('CodedHttpException in production', function () {
  this.timeout(15000);

  before(() => startWith(ProductionConfiguration));

  after(() => stop(ProductionConfiguration));

  it('answers the same body, while the error map drops the stack of the exceptions it answers', async () => {
    const coded = await req().get('coded/withDetails').set('Accept', 'application/json');
    expect(coded.status).to.eq(409);
    expect(coded.body).to.deep.eq({ code: 'invoice.locked', message: 'The invoice is locked', details: { invoice: '2026-0042' } });

    const mapped = await req().get('coded/invalidStatus').set('Accept', 'application/json');
    expect(mapped.status).to.eq(500);
    expect(mapped.body).to.not.have.property('stack');
  });
});
