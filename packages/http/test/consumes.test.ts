import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { InvalidArgument } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, Consumes, Controllers, Get, HttpServer, Ok, Post, Req } from '../src/index.js';
import type * as express from 'express';

@BasePath('consumes')
@Consumes('application/json')
class ConsumesController extends BaseController {
  @Post()
  public json(@Req() request: express.Request) {
    return new Ok({ got: request.body as unknown });
  }

  @Post()
  @Consumes('text/*', 'application/x-www-form-urlencoded')
  public textOrForm() {
    return new Ok({ ok: true });
  }

  @Get()
  public read() {
    return new Ok({ ok: true });
  }
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('@Consumes ( ConsumesMiddleware )', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(ConsumesController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('lets a body of a listed type through', async () => {
    const res = await req().post('consumes/json').set('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify({ a: 1 }));
    expect(res).to.have.status(200);
    expect(res.body).to.deep.eq({ got: { a: 1 } });
  });

  it('answers 415 with a problem document to a body of another type', async () => {
    const res = await req().post('consumes/json').set('Content-Type', 'text/plain').send('a=1');
    expect(res).to.have.status(415);
    expect((res.body as { detail: string }).detail).to.eq('the request body must be application/json');
  });

  it('lets a request without a body through', async () => {
    const res = await req().post('consumes/json');
    expect(res).to.have.status(200);
  });

  it('matches wildcards, and the route declaration wins over the controller one', async () => {
    const text = await req().post('consumes/textOrForm').set('Content-Type', 'text/csv').send('a,b');
    expect(text).to.have.status(200);

    const form = await req().post('consumes/textOrForm').type('form').send({ a: '1' });
    expect(form).to.have.status(200);

    const json = await req().post('consumes/textOrForm').set('Content-Type', 'application/json').send('{}');
    expect(json).to.have.status(415);
  });

  it('answers 415 to a body without a Content-Type', async () => {
    const res = await req().post('consumes/json').set('Content-Type', '').send(Buffer.from('raw'));
    expect(res).to.have.status(415);
  });

  it('leaves a body-less GET alone', async () => {
    const res = await req().get('consumes/read');
    expect(res).to.have.status(200);
  });

  it('refuses a declaration without types', () => {
    expect(thrownBy(() => Consumes())).to.be.instanceOf(InvalidArgument);
    expect(thrownBy(() => Consumes(''))).to.be.instanceOf(InvalidArgument);
  });
});
