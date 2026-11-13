import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Forbidden } from '@spinajs/exceptions';
import { Intl } from '@spinajs/intl';
import { FrameworkLogger } from '@spinajs/log';
import type { TestApp } from '@spinajs/testing';

import { appPort, httpApp, req, TestConfiguration } from './common.js';
import {
  BaseController,
  BasePath,
  BodyLimits,
  configuredCookieParser,
  Controllers,
  CookieParserMiddleware,
  defaultMiddlewares,
  HttpServer,
  JsonBodyParser,
  limitsBeforeMiddlewares,
  Ok,
  parsersHeldBy,
  Post,
  Req,
  ServerMiddleware,
  TextBodyParser,
  UrlencodedBodyParser,
} from '../src/index.js';
import type { IFinishContext, IMiddlewareContext, Request } from '../src/index.js';

const PARTNER = 'https://partner.example.test';
const SECRET = 'test-cookie-secret';

const seen: Record<string, unknown> = {};
const finished: Array<{ path: string; status: number }> = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms`);
    await sleep(5);
  }
}

const header = (res: { header: unknown }, name: string) => (res.header as Record<string, string | undefined>)[name];

interface IEcho {
  body: unknown;
  raw: number | null;
  cookies: Record<string, string> | null;
  signed: Record<string, string> | null;
}

const echo = (res: { body: unknown }) => res.body as IEcho;

/** A POST sent with Transfer-Encoding: chunked, so no Content-Length tells the size up front. */
function chunked(path: string, type: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: 'localhost', port: appPort(), path, method: 'POST', headers: { 'Content-Type': type, 'Transfer-Encoding': 'chunked', Accept: 'application/json' } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.write(body.slice(0, 10));
    request.end(body.slice(10));
  });
}

const BIG_JSON = JSON.stringify({ pad: 'x'.repeat(2048) });

class CookieProbe extends ServerMiddleware {
  public Order = 0.75;

  public onBefore({ req }: IMiddlewareContext): void {
    seen.cookiesAt075 = (req as Request).cookies;
  }
}

class BodyProbeBefore extends ServerMiddleware {
  public Order = 3;

  public onBefore({ req }: IMiddlewareContext): void {
    seen.bodyAt3 = (req as Request).body;
  }
}

class BodyProbeAfter extends ServerMiddleware {
  public Order = 4;

  public onBefore({ req }: IMiddlewareContext): void {
    seen.bodyAt4 = (req as Request).body;
  }
}

/** Reads the body below BodyLimits (3.4) when asked to, as a misplaced app parser would. */
class EarlyReader extends ServerMiddleware {
  public Order = 3.1;

  public handler(): express.RequestHandler {
    const read = express.text({ type: '*/*' });
    return (req, res, next) => (req.headers['x-read-early'] ? read(req, res, next) : next());
  }
}

/** Entered before the parsers: its onFinish sees every reply, the parser failures included. */
class FinishCounter extends ServerMiddleware {
  public Order = 2.5;

  public onFinish({ req, res }: IFinishContext): void {
    finished.push({ path: req.path, status: res.statusCode });
  }
}

@BasePath('parsers')
class ParsersController extends BaseController {
  @Post()
  public echo(@Req() request: Request) {
    const r = request as Request & { rawBody?: Buffer };
    return new Ok({ body: r.body ?? null, raw: r.rawBody?.length ?? null, cookies: r.cookies ?? null, signed: r.signedCookies ?? null });
  }

  @Post('echo/roomy')
  public roomy(@Req() request: Request) {
    return this.echo(request);
  }

  @Post()
  public limited(@Req() request: Request) {
    const r = request as Request & { rawBody?: Buffer };
    return new Ok({ raw: r.rawBody?.length ?? null });
  }
}

function configuration(http: Record<string, unknown>) {
  return class extends TestConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      Object.assign((this.Config as { http: Record<string, unknown> }).http, http);
    }
  };
}

async function boot(http: Record<string, unknown>, extra: Array<new () => ServerMiddleware> = []): Promise<TestApp> {
  const app = await httpApp({
    configuration: configuration(http),
    register: (c) => {
      c.register(ParsersController).as(BaseController);
      for (const type of extra) c.register(type).as(ServerMiddleware);
    },
    resolve: [Intl, Controllers],
  });
  await (await app.resolve(HttpServer)).start();
  return app;
}

const mounted = async (app: TestApp) => ((await app.resolve(HttpServer)) as unknown as { Middlewares: ServerMiddleware[] }).Middlewares;

describe('Body and cookie parsers as server middlewares', function () {
  this.timeout(15000);

  let app: TestApp;
  let accessInfo: sinon.SinonSpy;

  before(async () => {
    accessInfo = sinon.spy(FrameworkLogger.prototype, 'info');
    app = await boot(
      {
        middlewares: defaultMiddlewares(),
        cors: { origins: [PARTNER] },
        bodyLimits: [
          { path: '/parsers/limited', limit: '8b' },
          { path: '/parsers/echo/roomy', limit: '512b' },
        ],
        bodyParsers: {
          json: {
            limit: '1kb',
            verify: (request: Request) => {
              if (request.headers['x-forbid-body']) throw new Forbidden('webhook signature mismatch');
            },
          },
          text: { type: ['application/xml', 'text/plain'] },
        },
      },
      [CookieProbe, BodyProbeBefore, BodyProbeAfter, FinishCounter, EarlyReader],
    );
  });

  after(async () => {
    sinon.restore();
    await app.dispose();
  });

  beforeEach(() => {
    for (const key of Object.keys(seen)) delete seen[key];
    finished.length = 0;
    accessInfo.resetHistory();
  });

  const accessLogged = (status: number, path: string) =>
    accessInfo.getCalls().some((c) => {
      const fields = c.args[0] as { status?: number; path?: string } | undefined;
      return fields?.status === status && fields?.path === path;
    });

  it('mounts BodyLimits at Order 3.4, the body parsers at 3.5 and the cookie parser at 0.5', async () => {
    const orders = Object.fromEntries((await mounted(app)).map((m) => [m.constructor.name, m.Order]));

    expect(orders.BodyLimits).to.eq(3.4);
    expect(orders.JsonBodyParser).to.eq(3.5);
    expect(orders.UrlencodedBodyParser).to.eq(3.5);
    expect(orders.TextBodyParser).to.eq(3.5);
    expect(orders.CookieParserMiddleware).to.eq(0.5);
  });

  it('keeps only helmet in defaultMiddlewares()', () => {
    expect(defaultMiddlewares()).to.have.length(1);
  });

  it('parses a JSON body and keeps its raw bytes', async () => {
    const res = await req().post('parsers/echo').set('Accept', 'application/json').send({ a: 1 });

    expect(res.status).to.eq(200);
    expect(echo(res).body).to.deep.eq({ a: 1 });
    expect(echo(res).raw).to.eq(JSON.stringify({ a: 1 }).length);
  });

  it('parses form and XML text bodies', async () => {
    const form = await req().post('parsers/echo').set('Accept', 'application/json').type('form').send({ name: 'x' });
    expect(echo(form).body).to.deep.eq({ name: 'x' });

    const xml = await req().post('parsers/echo').set('Accept', 'application/json').set('Content-Type', 'application/xml').send('<a>1</a>');
    expect(echo(xml).body).to.eq('<a>1</a>');
  });

  it('parses cookies, signed ones with http.cookie.secret', async () => {
    const signed = `s:dark.${createHmac('sha256', SECRET).update('dark').digest('base64').replace(/=+$/, '')}`;
    const res = await req()
      .post('parsers/echo')
      .set('Accept', 'application/json')
      .set('Cookie', `plain=1; theme=${encodeURIComponent(signed)}`);

    expect(echo(res).cookies).to.deep.include({ plain: '1' });
    expect(echo(res).signed).to.deep.eq({ theme: 'dark' });
  });

  it('parses cookies before Order 1, where IntlHttpMiddleware reads the language cookie', async () => {
    await req().post('parsers/echo').set('Accept', 'application/json').set('Cookie', 'lang=en');

    expect(seen.cookiesAt075).to.deep.include({ lang: 'en' });
  });

  it('parses the body after the server middlewares before Order 3.5', async () => {
    await req().post('parsers/echo').set('Accept', 'application/json').send({ a: 1 });

    expect(seen.bodyAt3).to.eq(undefined);
    expect(seen.bodyAt4).to.deep.eq({ a: 1 });
  });

  it('answers a malformed JSON body 400 with x-request-id and CORS headers, access-logged and seen by entered onFinish', async () => {
    const res = await req().post('parsers/echo').set('Origin', PARTNER).set('Content-Type', 'application/json').set('Accept', 'application/json').send('{"broken": ');

    expect(res.status).to.eq(400);
    expect(header(res, 'x-request-id')).to.be.a('string').and.not.empty;
    expect(header(res, 'access-control-allow-origin')).to.eq(PARTNER);
    await until(() => finished.length > 0 && accessLogged(400, '/parsers/echo'));
    expect(finished).to.deep.eq([{ path: '/parsers/echo', status: 400 }]);
  });

  it('answers a body over its http.bodyLimits limit 413 with x-request-id and CORS headers, access-logged', async () => {
    const res = await req().post('parsers/limited').set('Origin', PARTNER).set('Accept', 'application/json').send({ much: 'more than eight bytes' });

    expect(res.status).to.eq(413);
    expect(header(res, 'x-request-id')).to.be.a('string').and.not.empty;
    expect(header(res, 'access-control-allow-origin')).to.eq(PARTNER);
    await until(() => finished.length > 0 && accessLogged(413, '/parsers/limited'));
    expect(finished).to.deep.eq([{ path: '/parsers/limited', status: 413 }]);
  });

  it('answers a chunked body over its http.bodyLimits limit 413', async () => {
    expect(await chunked('/parsers/limited', 'application/json', BIG_JSON)).to.eq(413);
  });

  it('limits every type http.bodyParsers parses, a wider text type included', async () => {
    expect(await chunked('/parsers/echo/roomy', 'text/plain', 'y'.repeat(4096))).to.eq(413);

    const small = await req().post('parsers/echo/roomy').set('Accept', 'application/json').set('Content-Type', 'text/plain').send('hello');
    expect(small.status).to.eq(200);
    expect(echo(small).body).to.eq('hello');
  });

  it('runs the http.bodyParsers.json verify under a limited path, and keeps the raw bytes', async () => {
    const refused = await req().post('parsers/echo/roomy').set('Accept', 'application/json').set('x-forbid-body', '1').send({ a: 1 });
    expect(refused.status).to.eq(403);

    const ok = await req().post('parsers/echo/roomy').set('Accept', 'application/json').send({ a: 1 });
    expect(echo(ok).body).to.deep.eq({ a: 1 });
    expect(echo(ok).raw).to.eq(JSON.stringify({ a: 1 }).length);
  });

  it('refuses 413 a body under a limited path that a server middleware read before the limit, warning once', async () => {
    const warn = sinon.spy(FrameworkLogger.prototype, 'warn');
    try {
      const first = await req().post('parsers/limited').set('x-read-early', '1').set('Content-Type', 'text/plain').send('abc');
      const second = await req().post('parsers/limited').set('x-read-early', '1').set('Content-Type', 'text/plain').send('abc');

      expect(first.status).to.eq(413);
      expect(second.status).to.eq(413);
      expect(warn.getCalls().filter((c) => /before http\.bodyLimits/.test(JSON.stringify(c.args)))).to.have.length(1);
    } finally {
      warn.restore();
    }
  });

  it('answers a JSON body over http.bodyParsers.json.limit 413', async () => {
    const res = await req().post('parsers/echo').set('Origin', PARTNER).set('Accept', 'application/json').send({ pad: 'x'.repeat(2048) });

    expect(res.status).to.eq(413);
    expect(header(res, 'x-request-id')).to.be.a('string').and.not.empty;
    expect(header(res, 'access-control-allow-origin')).to.eq(PARTNER);
  });
});

describe('Body and cookie parsers: switched off in http.bodyParsers', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await boot({ middlewares: defaultMiddlewares(), bodyParsers: { json: { enabled: false }, cookies: { enabled: false } } });
  });

  after(async () => {
    await app.dispose();
  });

  it('mounts no parser whose enabled is false', async () => {
    const types = (await mounted(app)).map((m) => m.constructor.name);
    const on = (await mounted(app)).filter((m) => m.isEnabled()).map((m) => m.constructor.name);

    expect(types).to.include.members(['JsonBodyParser', 'CookieParserMiddleware']);
    expect(on).to.not.include.members(['JsonBodyParser']);
    expect(on).to.not.include.members(['CookieParserMiddleware']);
    expect(on).to.include.members(['UrlencodedBodyParser', 'TextBodyParser']);
  });

  it('leaves a JSON body and the cookies unparsed', async () => {
    const res = await req().post('parsers/echo').set('Accept', 'application/json').set('Cookie', 'plain=1').send({ a: 1 });

    expect(res.status).to.eq(200);
    expect(echo(res).body).to.eq(null);
    expect(echo(res).cookies).to.eq(null);
  });
});

describe('Body and cookie parsers: a 3.x http.middlewares list that still holds parsers', function () {
  this.timeout(15000);

  let app: TestApp;
  let warn: sinon.SinonSpy;

  before(async () => {
    warn = sinon.spy(FrameworkLogger.prototype, 'warn');
    app = await boot({
      middlewares: [...defaultMiddlewares(), express.json(), cookieParser(SECRET)],
      bodyLimits: [{ path: '/parsers/limited', limit: '1kb' }],
    });
  });

  after(async () => {
    sinon.restore();
    await app.dispose();
  });

  const stepAside = () => warn.getCalls().filter((c) => c.args.some((a) => /http\.bodyParsers/.test(typeof a === 'string' ? a : JSON.stringify(a))));

  it('steps the matching built-ins aside with one warning each; the others stay', async () => {
    expect(stepAside()).to.have.length(2);
    const text = JSON.stringify(stepAside().map((c): unknown[] => c.args));
    expect(text).to.contain('jsonParser');
    expect(text).to.contain('cookieParser');

    const all = await mounted(app);
    const enabled = (type: new () => ServerMiddleware) => all.find((m) => m instanceof type)!.isEnabled();
    expect(enabled(JsonBodyParser)).to.eq(false);
    expect(enabled(CookieParserMiddleware)).to.eq(false);
    expect(enabled(BodyLimits)).to.eq(false);
    expect(enabled(UrlencodedBodyParser)).to.eq(true);
    expect(enabled(TextBodyParser)).to.eq(true);
  });

  it('still parses the body and cookies with the app handlers', async () => {
    const res = await req().post('parsers/echo').set('Accept', 'application/json').set('Cookie', 'plain=1').send({ a: 1 });

    expect(echo(res).body).to.deep.eq({ a: 1 });
    expect(echo(res).cookies).to.deep.include({ plain: '1' });
  });

  it('applies http.bodyLimits before the app parsers, as in 3.x', async () => {
    const ok = await req().post('parsers/limited').set('Accept', 'application/json').send({ a: 1 });
    // only the limit parser keeps the raw bytes: the app's express.json() has no verify
    expect(echo(ok).raw).to.eq(JSON.stringify({ a: 1 }).length);

    const big = await req().post('parsers/limited').set('Accept', 'application/json').send({ pad: 'x'.repeat(2048) });
    expect(big.status).to.eq(413);
  });
});

describe('Body and cookie parsers: http.middlewares handlers the name check cannot see', function () {
  this.timeout(15000);

  let app: TestApp;
  let warn: sinon.SinonSpy;

  before(async () => {
    warn = sinon.spy(FrameworkLogger.prototype, 'warn');
    const json = express.json();
    const wrapped: express.RequestHandler = (request, res, next) => json(request, res, next);
    app = await boot({
      middlewares: [...defaultMiddlewares(), wrapped, [express.urlencoded({ extended: true })]],
      bodyLimits: [{ path: '/parsers/limited', limit: '64b' }],
    });
  });

  after(async () => {
    sinon.restore();
    await app.dispose();
  });

  it('mounts http.bodyLimits before a list holding a handler it did not ship: a chunked body over a rule answers 413', async () => {
    expect(await chunked('/parsers/limited', 'application/json', BIG_JSON)).to.eq(413);
  });

  it('recognises a parser inside a nested array, not a wrapped one', async () => {
    const all = await mounted(app);
    const enabled = (type: new () => ServerMiddleware) => all.find((m) => m instanceof type)!.isEnabled();

    expect(enabled(UrlencodedBodyParser)).to.eq(false);
    expect(enabled(JsonBodyParser)).to.eq(true);
    expect(enabled(BodyLimits)).to.eq(false);
  });

  it('warns once per built-in that steps aside, however often isEnabled() is asked', async () => {
    const all = await mounted(app);
    all.forEach((m) => m.isEnabled());

    expect(warn.getCalls().filter((c) => /http\.bodyParsers/.test(JSON.stringify(c.args)))).to.have.length(1);
  });
});

describe('Body and cookie parsers: http.middlewares detection', () => {
  const mine: express.RequestHandler = (_req, _res, next) => next();

  it('does not take an app function named cookieParser for the cookie parser', () => {
    function cookieParser(_req: unknown, _res: unknown, next: () => void) {
      next();
    }
    expect([...parsersHeldBy([cookieParser]).keys()]).to.deep.eq([]);
  });

  it('recognises express, cookie-parser and the 3.x configuredCookieParser handlers', () => {
    expect([...parsersHeldBy([express.json(), express.urlencoded(), express.text(), configuredCookieParser]).keys()]).to.deep.eq(['json', 'urlencoded', 'text', 'cookies']);
  });

  it('puts the limits before http.middlewares only for a handler the package did not ship', () => {
    expect(limitsBeforeMiddlewares(defaultMiddlewares())).to.eq(false);
    expect(limitsBeforeMiddlewares([...defaultMiddlewares(), configuredCookieParser])).to.eq(false);
    expect(limitsBeforeMiddlewares([...defaultMiddlewares(), mine])).to.eq(true);
    expect(limitsBeforeMiddlewares([[mine]])).to.eq(true);
  });
});
