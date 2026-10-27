import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';

import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, Body, Controllers, HttpServer, Ok, parseBodyLimit, Post, RawBody } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

// Served at /auth through the config key; the default path is never mounted.
@BasePath({ config: 'test.bodyLimits.authBase', default: 'not-auth' })
class LimitedAuthController extends BaseController {
  @Post()
  public login(@Body() body: object) {
    return new Ok({ size: JSON.stringify(body).length });
  }

  @Post()
  public raw(@RawBody() raw: Buffer) {
    return new Ok({ raw: raw?.length ?? 0 });
  }
}

@BasePath('authority')
class UnlimitedController extends BaseController {
  @Post()
  public login(@Body() body: object) {
    return new Ok({ size: JSON.stringify(body).length });
  }
}

class BodyLimitsConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const config = this.Config as { http: Record<string, unknown>; test?: unknown };
    config.http.bodyLimits = [
      { path: '/auth/raw', limit: '64kb' },
      { path: '/auth', limit: '16kb' },
      { path: '/auth/login', limit: '1mb' },
    ];
    config.test = { bodyLimits: { authBase: 'auth' } };
  }
}

const body = (bytes: number) => ({ pad: 'x'.repeat(bytes) });

describe('Per-path body limits', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      configuration: BodyLimitsConfiguration,
      register: (c) => {
        c.register(LimitedAuthController).as(BaseController);
        c.register(UnlimitedController).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('answers 413 for a body over the limit of the matching path, served under a config-based base path', async () => {
    const res = await req().post('auth/login').send(body(20 * 1024));
    expect(res.status).to.eq(413);
  });

  it('accepts a body within the limit', async () => {
    const res = await req().post('auth/login').send(body(10 * 1024));
    expect(res.status).to.eq(200);
  });

  it('matches the path case-insensitively', async () => {
    const res = await req().post('AUTH/login').send(body(20 * 1024));
    expect(res.status).to.eq(413);
  });

  it('keeps the default limit on another path, including one that only shares the prefix text', async () => {
    const res = await req().post('authority/login').send(body(20 * 1024));
    expect(res.status).to.eq(200);
  });

  it('lets the first matching rule win', async () => {
    expect((await req().post('auth/raw').send(body(20 * 1024))).status).to.eq(200);
    expect((await req().post('auth/raw').send(body(70 * 1024))).status).to.eq(413);
  });

  it('still captures the raw body on a limited path', async () => {
    const res = await req().post('auth/raw').send(body(10));
    expect(res.status).to.eq(200);
    expect((res.body as { raw: number }).raw).to.eq(JSON.stringify(body(10)).length);
  });

  it('applies the limit to urlencoded bodies', async () => {
    const res = await req().post('auth/login').type('form').send({ pad: 'x'.repeat(20 * 1024) });
    expect(res.status).to.eq(413);
  });

  it('applies the limit to a declared length of any content type', async () => {
    const res = await req()
      .post('auth/login')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(20 * 1024));
    expect(res.status).to.eq(413);
  });
});

describe('parseBodyLimit', () => {
  it('reads the body-parser size notation', () => {
    expect(parseBodyLimit('512')).to.eq(512);
    expect(parseBodyLimit('16kb')).to.eq(16 * 1024);
    expect(parseBodyLimit('1.5MB')).to.eq(1.5 * 1024 * 1024);
  });

  it('refuses anything else', () => {
    expect(() => parseBodyLimit('lots')).to.throw();
  });
});
