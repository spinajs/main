import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { Schema, ValidationFailed } from '@spinajs/validation';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, Body, Controllers, HttpServer, Ok, OnError, Post, Req } from '../src/index.js';
import type { Request } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

@Schema({ type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', maxLength: 8 }, secret: { type: 'string' } } })
class SecretInput {
  public name: string;
  public secret?: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

const leftOf = (r: Request) => ({ bodyKeys: Object.keys((r.body as object | undefined) ?? {}), raw: r.rawBody ? r.rawBody.toString('utf8') : null });

@BasePath('params/sensitive')
class SensitiveParams extends BaseController {
  @Post()
  @OnError(ValidationFailed, (_err, ctx) => new Ok({ refused: true, ...leftOf(ctx.req) }), { stages: ['arguments'] })
  public typed(@Body({ sensitive: ['secret'] }) input: SecretInput, @Req() r: Request) {
    return new Ok({ input, ...leftOf(r) });
  }

  @Post()
  public untyped(@Body({ sensitive: ['secret'] }) input: object, @Req() r: Request) {
    return new Ok({ input, ...leftOf(r) });
  }

  @Post()
  public plain(@Body() input: SecretInput, @Req() r: Request) {
    return new Ok({ input, ...leftOf(r) });
  }
}

describe('@Body({ sensitive })', function () {
  this.timeout(60000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(SensitiveParams).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('hands the field to the argument and takes it, with the raw bytes, off the request', async () => {
    const res = await req().post('params/sensitive/typed').send({ name: 'a', secret: 's3cret' });
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ input: { name: 'a', secret: 's3cret' }, bodyKeys: ['name'], raw: null });
  });

  it('takes it off the request when the argument fails validation too', async () => {
    const res = await req().post('params/sensitive/typed').send({ name: 'a'.repeat(9), secret: 's3cret' });
    expect(res.body).to.deep.eq({ refused: true, bodyKeys: ['name'], raw: null });
  });

  it('leaves an untyped argument, which is the body itself, its own copy', async () => {
    const res = await req().post('params/sensitive/untyped').send({ name: 'a', secret: 's3cret' });
    expect(res.body).to.deep.eq({ input: { name: 'a', secret: 's3cret' }, bodyKeys: ['name'], raw: null });
  });

  it('changes nothing without the option', async () => {
    const res = await req().post('params/sensitive/plain').send({ name: 'a', secret: 's3cret' });
    const left = res.body as { bodyKeys: string[]; raw: string | null };
    expect(left.bodyKeys).to.deep.eq(['name', 'secret']);
    expect(left.raw).to.eq(JSON.stringify({ name: 'a', secret: 's3cret' }));
  });
});
