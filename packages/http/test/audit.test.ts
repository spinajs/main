import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import { DI } from '@spinajs/di';
import { Intl } from '@spinajs/intl';
import { Log } from '@spinajs/log';
import { BadRequest } from '@spinajs/exceptions';
import type { TestApp } from '@spinajs/testing';

import { appPort, httpApp, req, TestConfiguration } from './common.js';
import { Audit, AuditSink, BaseController, BasePath, Body, Controllers, Get, HttpServer, LogAuditSink, Middleware, Ok, Post, RouteMiddleware } from '../src/index.js';
import type { IAuditRecord, IMiddlewareContext } from '../src/index.js';
import { REDACTED, redactFields } from '../src/util/redact.js';

const DEFAULT_KEYS = ['password', 'token', 'secret', 'authorization', 'cookie', 'card'];

class MemoryAuditSink extends AuditSink {
  public static records: IAuditRecord[] = [];
  public static failWith: 'throw' | 'reject' | null = null;

  public write(record: IAuditRecord): void | Promise<void> {
    if (MemoryAuditSink.failWith === 'throw') throw new Error('sink down');
    if (MemoryAuditSink.failWith === 'reject') return Promise.reject(new Error('sink down'));
    MemoryAuditSink.records.push(record);
  }
}

class SignedIn extends RouteMiddleware {
  public onBefore({ storage }: IMiddlewareContext): void {
    Object.assign(storage, {
      Principal: { type: 'user', id: '42', authenticated: true, source: 'session', attributes: {}, authn: { impersonator: { type: 'user', id: '1' } } },
    });
  }
}

class Refuses extends RouteMiddleware {
  public onBefore(): void {
    throw new BadRequest('refused by an inner middleware');
  }
}

@BasePath('audited')
@Middleware(Audit)
class AuditedController extends BaseController {
  @Post()
  public create(@Body() data: Record<string, unknown>) {
    return new Ok({ id: 1, echo: Object.keys(data ?? {}) });
  }

  @Post()
  public failing() {
    throw new BadRequest('name is required');
  }

  @Get()
  @Middleware(SignedIn)
  public me() {
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(Refuses)
  public refused() {
    return new Ok({ ok: true });
  }

  @Get()
  public async slow() {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return new Ok({ ok: true });
  }
}

@BasePath('audited-options')
class AuditedOptionsController extends BaseController {
  @Post()
  @Middleware(Audit, { redact: ['pin'] })
  public extra(@Body() _data: object) {
    return new Ok({ ok: true });
  }

  @Post()
  @Middleware(Audit, { includeBody: false })
  public bodiless(@Body() _data: object) {
    return new Ok({ ok: true });
  }

  @Post()
  @Middleware(Audit, { maxBodyBytes: 32 })
  public small(@Body() _data: object) {
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(Audit, { methods: ['POST'] })
  public reads() {
    return new Ok({ ok: true });
  }
}

@BasePath('audit-plain')
class PlainController extends BaseController {
  @Get()
  public plain() {
    return new Ok({ ok: true });
  }
}

async function nextRecord(match: (r: IAuditRecord) => boolean = () => true): Promise<IAuditRecord> {
  for (let i = 0; i < 100; i++) {
    const found = MemoryAuditSink.records.find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('no audit record written');
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function configWith(http: Record<string, unknown>) {
  return class extends TestConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      Object.assign((this.Config as { http: Record<string, unknown> }).http, http);
    }
  };
}

describe('redactFields', () => {
  it('replaces the value of every key that contains a sensitive word, case-insensitively, at any depth', () => {
    const out = redactFields(
      {
        name: 'jo',
        Password: 'p',
        nested: { accessToken: 't', refresh_token: 'r', keep: 1, deeper: [{ clientSecret: 's', ok: true }] },
        creditCard: { number: '4111', expiry: '12/30' },
        'X-Authorization': 'Bearer x',
        list: [1, 'two', null],
      },
      DEFAULT_KEYS,
    );

    expect(out).to.deep.eq({
      name: 'jo',
      Password: REDACTED,
      nested: { accessToken: REDACTED, refresh_token: REDACTED, keep: 1, deeper: [{ clientSecret: REDACTED, ok: true }] },
      creditCard: REDACTED,
      'X-Authorization': REDACTED,
      list: [1, 'two', null],
    });
  });

  it('never changes its input', () => {
    const input = { password: 'p', inner: { token: 't' } };
    redactFields(input, DEFAULT_KEYS);
    expect(input).to.deep.eq({ password: 'p', inner: { token: 't' } });
  });

  it('marks a circular reference, keeps a shared one and stops at a depth limit', () => {
    const shared = { a: 1 };
    const cyclic: Record<string, unknown> = { shared, again: shared };
    cyclic.self = cyclic;
    expect(redactFields(cyclic, DEFAULT_KEYS)).to.deep.eq({ shared: { a: 1 }, again: { a: 1 }, self: '[circular]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100; i++) deep = { deep };
    expect(JSON.stringify(redactFields(deep, DEFAULT_KEYS))).to.contain('[too deep]');
  });

  it('keeps a __proto__ key as an own property instead of setting the prototype', () => {
    const out = redactFields(JSON.parse('{"__proto__":{"token":"t","x":1}}'), DEFAULT_KEYS) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).to.eq(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).to.deep.eq({ token: REDACTED, x: 1 });
  });

  it('writes binary data as a marker', () => {
    expect(redactFields({ file: Buffer.from('abc') }, DEFAULT_KEYS)).to.deep.eq({ file: '[binary]' });
  });
});

describe('Audit route middleware', function () {
  this.timeout(20000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => {
        c.register(MemoryAuditSink).as(AuditSink);
        c.register(AuditedController).as(BaseController);
        c.register(AuditedOptionsController).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  beforeEach(() => {
    MemoryAuditSink.records = [];
    MemoryAuditSink.failWith = null;
  });

  it('writes one record per request with the route, the redacted url, query and body, the status and the time', async () => {
    const res = await req()
      .post('audited/create?apiToken=abc&page=2')
      .send({ name: 'jo', password: 'hunter2', profile: { sessionCookie: 'c', city: 'Kraków' }, payments: [{ card: '4111', last4: '1111' }] });
    expect(res.status).to.eq(200);

    const record = await nextRecord();
    expect(record.route).to.match(/^http:POST .*audited\/create$/);
    expect(record.method).to.eq('POST');
    expect(record.url).to.eq('/audited/create?apiToken=[redacted]&page=[redacted]');
    expect(record.query).to.deep.eq({ apiToken: REDACTED, page: '2' });
    expect(record.body).to.deep.eq({ name: 'jo', password: REDACTED, profile: { sessionCookie: REDACTED, city: 'Kraków' }, payments: [{ card: REDACTED, last4: '1111' }] });
    expect(record.status).to.eq(200);
    expect(record.aborted).to.eq(false);
    expect(record.ms).to.be.a('number').and.at.least(0);
    expect(record.at).to.be.instanceOf(Date);
    expect(record.error).to.eq(undefined);
    expect(record.principal).to.eq(undefined);
    expect(JSON.stringify(record)).to.not.contain('hunter2');
    expect(MemoryAuditSink.records).to.have.length(1);
  });

  it('records the error an error reply answers', async () => {
    const res = await req().post('audited/failing').send({});
    expect(res.status).to.eq(400);

    const record = await nextRecord();
    expect(record.status).to.eq(400);
    expect(record.error).to.deep.eq({ name: 'BadRequest', message: 'name is required' });
  });

  it('records a refusal of an inner middleware, since it runs in the outer stage', async () => {
    const res = await req().get('audited/refused');
    expect(res.status).to.eq(400);

    const record = await nextRecord();
    expect(record.error?.message).to.eq('refused by an inner middleware');
  });

  it('records the principal from req.storage, with the impersonator', async () => {
    await req().get('audited/me');
    const record = await nextRecord();
    expect(record.principal).to.deep.eq({ type: 'user', id: '42', impersonator: { type: 'user', id: '1' } });
  });

  it('leaves out an empty body and query', async () => {
    await req().get('audited/me');
    const record = await nextRecord();
    expect(record).to.not.have.property('body');
    expect(record).to.not.have.property('query');
  });

  it('records a request the client went away from as aborted, without a status', async () => {
    await new Promise<void>((resolve) => {
      const r = http.get(`http://localhost:${appPort()}/audited/slow`);
      r.on('error', () => resolve());
      setTimeout(() => {
        r.destroy();
        resolve();
      }, 100);
    });

    const record = await nextRecord((r) => r.route.endsWith('audited/slow'));
    expect(record.aborted).to.eq(true);
    expect(record.status).to.eq(undefined);
  });

  it('adds the redact keys of a route to the configured ones', async () => {
    await req().post('audited-options/extra').send({ pin: '1234', password: 'p', name: 'x' });
    const record = await nextRecord();
    expect(record.body).to.deep.eq({ pin: REDACTED, password: REDACTED, name: 'x' });
  });

  it('leaves the body out with includeBody: false', async () => {
    await req().post('audited-options/bodiless').send({ name: 'x' });
    const record = await nextRecord();
    expect(record).to.not.have.property('body');
  });

  it('leaves a body over maxBodyBytes out and records its size', async () => {
    await req().post('audited-options/small').send({ name: 'a much longer value than thirty two bytes' });
    const record = await nextRecord();
    expect(record).to.not.have.property('body');
    expect(record.bodyTruncated).to.be.greaterThan(32);
  });

  it('records a text body as redacted: it has no keys to redact by', async () => {
    await req().post('audited/create').set('content-type', 'application/xml').send('<login><password>p</password></login>');
    const record = await nextRecord();
    expect(record.body).to.eq(REDACTED);
  });

  it('skips the methods not listed in methods', async () => {
    const res = await req().get('audited-options/reads');
    expect(res.status).to.eq(200);
    await settle();
    expect(MemoryAuditSink.records).to.have.length(0);
  });

  for (const failWith of ['throw', 'reject'] as const) {
    it(`logs a sink that fails (${failWith}) and never fails the request`, async () => {
      const log = DI.resolve(Log, ['http']);
      const original = log.error;
      const logged: unknown[][] = [];
      log.error = ((...args: unknown[]) => logged.push(args)) as typeof log.error;
      MemoryAuditSink.failWith = failWith;
      try {
        const res = await req().post('audited/create').send({ name: 'x' });
        expect(res.status).to.eq(200);
        for (let i = 0; i < 50 && logged.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        log.error = original;
      }

      expect(logged).to.have.length(1);
      expect(String(logged[0][1])).to.contain('audit');
      expect((logged[0][0] as Error).message).to.eq('sink down');
    });
  }
});

describe('Audit declared globally ( http.routes.middlewares )', function () {
  this.timeout(20000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      configuration: configWith({ routes: { middlewares: ['Audit'] }, audit: { methods: ['get'], redact: ['secret'] } }),
      register: (c) => {
        c.register(MemoryAuditSink).as(AuditSink);
        c.register(PlainController).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  beforeEach(() => {
    MemoryAuditSink.records = [];
    MemoryAuditSink.failWith = null;
  });

  it('audits a route of a controller with no @Middleware, with http.audit applied', async () => {
    const res = await req().get('audit-plain/plain?secret=s&password=p');
    expect(res.status).to.eq(200);

    const record = await nextRecord();
    expect(record.route).to.match(/audit-plain\/plain$/);
    // http.audit.redact replaces the default list
    expect(record.query).to.deep.eq({ secret: REDACTED, password: 'p' });
  });
});

describe('LogAuditSink', () => {
  it('writes the record as one info line on the audit logger', () => {
    const log = DI.resolve(Log, ['audit']);
    const original = log.info;
    const lines: unknown[][] = [];
    log.info = ((...args: unknown[]) => lines.push(args)) as typeof log.info;
    const record: IAuditRecord = { at: new Date(), route: 'http:POST /x', method: 'POST', url: '/x', status: 201, ms: 3, aborted: false };
    try {
      void new LogAuditSink().write(record);
    } finally {
      log.info = original;
    }

    expect(lines).to.have.length(1);
    expect(lines[0][0]).to.eq(record);
    expect(String(lines[0][1])).to.contain('${route}');
  });

  it('is the default AuditSink', () => {
    expect(DI.getRegisteredTypes(AuditSink)).to.include(LogAuditSink);
  });
});

