import 'mocha';
import http from 'node:http';
import { expect } from 'chai';
import { audit } from '@spinajs/audit';
import type { StoredAuditEvent } from '@spinajs/audit';
import { MemoryAuditStore } from '@spinajs/audit/testing';
import { DI } from '@spinajs/di';
import { BadRequest, Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, BasePolicy, Body, Del, Get, Idempotent, Middleware, Ok, Param, Policy, Post, REDACTED, RouteMiddleware } from '@spinajs/http';
import type { IMiddlewareContext, MiddlewareStage } from '@spinajs/http';
import '@spinajs/idempotency';
import { Log } from '@spinajs/log-common';
import type { TestApp } from '@spinajs/testing';

import { Audit } from '../src/index.js';
import { appPort, auditApp, bootFailure, req } from './support/app.js';

class SignedIn extends RouteMiddleware {
  public onBefore({ storage }: IMiddlewareContext): void {
    Object.assign(storage, {
      ClientIp: '203.0.113.7',
      Principal: { type: 'user', id: '42', authenticated: true, source: 'session', attributes: {}, authn: { impersonator: { type: 'user', id: '1' } } },
    });
  }
}

class Deny extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('not your account');
  }
}

class Crashes extends Deny {
  public override async execute(): Promise<void> {
    throw new Error('the policy store is down');
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
  @Policy(Deny)
  public denied() {
    return new Ok({ ok: true });
  }

  @Get()
  @Policy(Crashes)
  public crashed() {
    return new Ok({ ok: true });
  }

  @Post()
  public crashing(@Body() data: { payload: string }) {
    return new Ok(JSON.parse(data.payload));
  }

  @Post()
  public verbose() {
    throw new BadRequest('x'.repeat(500));
  }

  @Get('reset/:token/:step')
  public reset(@Param() token: string, @Param() step: string) {
    return new Ok({ token: token.length, step });
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

  @Post()
  @Middleware(Audit, { trail: 'admin', action: 'user.create' })
  public named(@Body() _data: object) {
    return new Ok({ ok: true });
  }
}

@BasePath('audited-reports')
@Middleware(Audit, { trail: 'admin', action: 'reports' })
class ReportsController extends BaseController {
  @Get()
  public list() {
    return new Ok([]);
  }
}

@BasePath('audit-plain')
class PlainController extends BaseController {
  @Get()
  public plain() {
    return new Ok({ ok: true });
  }
}

@BasePath('audit-nowhere')
class NowhereController extends BaseController {
  @Get()
  @Middleware(Audit, { trail: 'nope' })
  public lost() {
    return new Ok({ ok: true });
  }
}

const replay = { policyCalls: 0, actionCalls: 0 };

/** Stands for the authn server middlewares: the principal is known before the policy gate, which an early replay needs. */
class SignIn extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'beforePolicy';

  public onBefore({ req, storage }: IMiddlewareContext): void {
    const id = req.headers['x-user'];
    if (typeof id === 'string') Object.assign(storage, { Principal: { type: 'user', id, authenticated: true, source: 'test', attributes: {} } });
  }
}

class Counted extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    replay.policyCalls++;
    return Promise.resolve();
  }
}

@BasePath('audited-replay')
@Middleware(Audit)
@Middleware(SignIn)
class ReplayController extends BaseController {
  @Del(':id')
  @Idempotent()
  @Policy(Counted)
  public remove(@Param() id: string) {
    replay.actionCalls++;
    return new Ok({ deleted: id });
  }
}

const TRAILS = { default: { store: 'MemoryAuditStore', retry: { attempts: 1 } }, admin: { store: 'MemoryAuditStore' } };

type Match = (event: StoredAuditEvent) => boolean;

async function nextEvent(trail = 'default', match: Match = () => true): Promise<StoredAuditEvent> {
  for (let i = 0; i < 100; i++) {
    await audit().flush();
    const found = MemoryAuditStore.events(trail).find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no audit event recorded in trail ${trail}`);
}

const dataOf = (event: StoredAuditEvent) => event.data as Record<string, unknown>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('Audit route middleware', function () {
  this.timeout(20000);

  let app: TestApp;

  before(async () => {
    app = await auditApp({ audit: { trails: TRAILS }, controllers: [AuditedController, AuditedOptionsController, ReportsController] });
  });

  after(() => app.dispose());

  beforeEach(() => MemoryAuditStore.clear());

  it('records one action event per request with the route, the redacted url, query and body, the status and the time', async () => {
    const res = await req()
      .post('audited/create?apiToken=abc&page=2')
      .send({ name: 'jo', password: 'hunter2', profile: { sessionCookie: 'c', city: 'Kraków' }, payments: [{ card: '4111', last4: '1111' }] });
    expect(res.status).to.eq(200);

    const event = await nextEvent();
    const data = dataOf(event);
    expect([event.kind, event.outcome]).to.deep.eq(['action', 'ok']);
    expect(data.route).to.match(/^http:POST .*audited\/create$/);
    expect(event.action).to.eq(data.route);
    expect(data.method).to.eq('POST');
    expect(data.url).to.eq('/audited/create?apiToken=[redacted]&page=[redacted]');
    expect(data.query).to.deep.eq({ apiToken: REDACTED, page: '2' });
    expect(data.body).to.deep.eq({ name: 'jo', password: REDACTED, profile: { sessionCookie: REDACTED, city: 'Kraków' }, payments: [{ card: REDACTED, last4: '1111' }] });
    expect(data.status).to.eq(200);
    expect(data).to.not.have.property('aborted');
    expect(data).to.not.have.property('error');
    expect(data.ms).to.be.a('number').and.at.least(0);
    expect(event.at).to.be.instanceOf(Date);
    expect(event.onBehalfOf).to.eq(undefined);
    expect(JSON.stringify(event)).to.not.contain('hunter2');
    expect(MemoryAuditStore.events('default')).to.have.length(1);
  });

  it('records the error an error reply answers, as failed', async () => {
    const res = await req().post('audited/failing').send({});
    expect(res.status).to.eq(400);

    const event = await nextEvent();
    expect(event.outcome).to.eq('failed');
    expect(dataOf(event).status).to.eq(400);
    expect(dataOf(event).error).to.deep.eq({ name: 'BadRequest', message: 'name is required' });
  });

  it('records a refusal of the policy gate as denied, since it runs before it', async () => {
    const res = await req().get('audited/denied');
    expect(res.status).to.eq(403);

    const event = await nextEvent();
    expect(event.outcome).to.eq('denied');
    expect(dataOf(event).status).to.eq(403);
    expect(dataOf(event).error).to.deep.eq({ name: 'Forbidden', message: 'not your account' });
  });

  it('records a policy that crashes as failed, not denied', async () => {
    expect((await req().get('audited/crashed')).status).to.eq(500);
    expect((await nextEvent()).outcome).to.eq('failed');
  });

  it('records only the name of an error answered as a 500: its message can quote input', async () => {
    const res = await req().post('audited/crashing').send({ payload: 'hunter2-password-value' });
    expect(res.status).to.eq(500);

    const event = await nextEvent();
    expect(event.outcome).to.eq('failed');
    expect(dataOf(event).error).to.deep.eq({ name: 'SyntaxError' });
    expect(JSON.stringify(dataOf(event).error)).to.not.contain('hunter2');
  });

  it('cuts a long error message to 200 characters', async () => {
    await req().post('audited/verbose').send({});
    const event = await nextEvent();
    expect(dataOf(event).error).to.deep.eq({ name: 'BadRequest', message: `${'x'.repeat(200)}...` });
  });

  it('redacts a path segment holding a route parameter with a sensitive name', async () => {
    const res = await req().get('audited/reset/SUPERSECRETRESETTOKEN/confirm?token=SUPERSECRETRESETTOKEN');
    expect(res.status).to.eq(200);

    const event = await nextEvent();
    expect(dataOf(event).url).to.eq('/audited/reset/[redacted]/confirm?token=[redacted]');
    expect(JSON.stringify(event)).to.not.contain('SUPERSECRET');
  });

  it('records a refusal of an inner middleware as failed', async () => {
    const res = await req().get('audited/refused');
    expect(res.status).to.eq(400);

    const event = await nextEvent();
    expect(event.outcome).to.eq('failed');
    expect(dataOf(event).error).to.deep.include({ message: 'refused by an inner middleware' });
  });

  it('takes the actor, the impersonator and the client address from the request, through the audit context', async () => {
    await req().get('audited/me');
    const event = await nextEvent();
    expect(event.actor).to.eq('user:42');
    expect(event.onBehalfOf).to.eq('user:1');
    // ClientIp, set by @spinajs/authn-http, wins over the realIp of http
    expect(event.origin).to.eq('203.0.113.7');
    expect(dataOf(event)).to.not.have.property('principal');
  });

  it('leaves out an empty body and query', async () => {
    await req().get('audited/me');
    const event = await nextEvent();
    expect(dataOf(event)).to.not.have.property('body');
    expect(dataOf(event)).to.not.have.property('query');
  });

  it('records a request the client went away from once its action ended, as aborted and without a status', async () => {
    await new Promise<void>((resolve) => {
      const r = http.get(`http://localhost:${appPort()}/audited/slow`);
      r.on('error', () => resolve());
      setTimeout(() => {
        r.destroy();
        resolve();
      }, 100);
    });

    const event = await nextEvent('default', (e) => String(dataOf(e).route).endsWith('audited/slow'));
    expect(event.outcome).to.eq('ok');
    expect(dataOf(event).aborted).to.eq(true);
    expect(dataOf(event)).to.not.have.property('status');
  });

  it('adds the redact keys of a route to the configured ones', async () => {
    await req().post('audited-options/extra').send({ pin: '1234', password: 'p', name: 'x' });
    const event = await nextEvent();
    expect(dataOf(event).body).to.deep.eq({ pin: REDACTED, password: REDACTED, name: 'x' });
  });

  it('leaves the body out with includeBody: false', async () => {
    await req().post('audited-options/bodiless').send({ name: 'x' });
    const event = await nextEvent();
    expect(dataOf(event)).to.not.have.property('body');
  });

  it('leaves a body over maxBodyBytes out and records its size', async () => {
    await req().post('audited-options/small').send({ name: 'a much longer value than thirty two bytes' });
    const event = await nextEvent();
    expect(dataOf(event)).to.not.have.property('body');
    expect(dataOf(event).bodyTruncated).to.be.greaterThan(32);
  });

  it('records a text body as redacted: it has no keys to redact by', async () => {
    await req().post('audited/create').set('content-type', 'application/xml').send('<login><password>p</password></login>');
    const event = await nextEvent();
    expect(dataOf(event).body).to.eq(REDACTED);
  });

  it('skips the methods not listed in methods', async () => {
    const res = await req().get('audited-options/reads');
    expect(res.status).to.eq(200);
    await settle();
    await audit().flush();
    expect(MemoryAuditStore.events()).to.have.length(0);
  });

  it('writes to the trail and under the action its options name; an action for a whole controller is a prefix', async () => {
    await req().post('audited-options/named').send({ name: 'x' });
    await req().get('audited-reports/list');

    expect((await nextEvent('admin', (e) => e.action === 'user.create')).outcome).to.eq('ok');
    expect((await nextEvent('admin', (e) => e.action === 'reports.list')).outcome).to.eq('ok');
    expect(MemoryAuditStore.events('default')).to.have.length(0);
  });

  it('never fails the request when the event cannot be written, and logs the lost event', async () => {
    // loggers are cached by name, so this is the instance the audit service logs to
    const pipeline = DI.resolve(Log, ['audit-pipeline']);
    const logged: unknown[] = [];
    pipeline.error = (fields: unknown) => void logged.push(fields);
    MemoryAuditStore.failNext(1);

    try {
      const res = await req().post('audited/create').send({ name: 'lost' });
      expect(res.status).to.eq(200);
      await settle();
      await audit().flush();
    } finally {
      Reflect.deleteProperty(pipeline, 'error');
    }
    expect(MemoryAuditStore.events('default')).to.have.length(0);
    expect(logged).to.have.length(1);
    expect(logged[0]).to.include({ trail: 'default', count: 1 });

    await req().post('audited/create').send({ name: 'kept' });
    expect(dataOf(await nextEvent()).body).to.deep.eq({ name: 'kept' });
  });
});

describe('Audit declared globally ( http.routes.middlewares )', function () {
  this.timeout(20000);

  let app: TestApp;

  before(async () => {
    app = await auditApp({
      audit: { trails: TRAILS, http: { methods: ['get'], redact: ['secret'] } },
      http: { routes: { middlewares: ['Audit'] } },
      controllers: [PlainController],
    });
  });

  after(() => app.dispose());

  beforeEach(() => MemoryAuditStore.clear());

  it('audits a route of a controller with no @Middleware, with audit.http applied', async () => {
    const res = await req().get('audit-plain/plain?secret=s&password=p');
    expect(res.status).to.eq(200);

    const event = await nextEvent();
    expect(dataOf(event).route).to.match(/audit-plain\/plain$/);
    // audit.http.redact replaces the default list
    expect(dataOf(event).query).to.deep.eq({ secret: REDACTED, password: 'p' });
  });
});

describe('Audit and an idempotent replay', function () {
  this.timeout(20000);

  let app: TestApp;

  before(async () => {
    app = await auditApp({
      audit: { trails: TRAILS },
      sections: { idempotency: { store: 'MemoryIdempotencyStore', lease: '30s', sweepBatch: 500, sweepEvery: '5m' } },
      controllers: [ReplayController],
    });
  });

  after(() => app.dispose());

  beforeEach(() => MemoryAuditStore.clear());

  it('records a request answered from the idempotency store once, with the principal', async () => {
    const send = () => req().delete('audited-replay/a').set({ Accept: 'application/json', 'Idempotency-Key': 'del-audit-1', 'x-user': 'u1' });
    const first = await send();
    const again = await send();

    expect([first.status, again.status]).to.deep.eq([200, 200]);
    expect(again.get('idempotent-replayed')).to.eq('true');
    expect([replay.policyCalls, replay.actionCalls]).to.deep.eq([1, 1]);

    await nextEvent('default', () => MemoryAuditStore.events('default').length >= 2);
    await settle();
    await audit().flush();
    const events = MemoryAuditStore.events('default');
    expect(events).to.have.length(2);
    for (const event of events) {
      expect([event.outcome, event.actor, dataOf(event).status, dataOf(event).method]).to.deep.eq(['ok', 'user:u1', 200, 'DELETE']);
    }
  });
});

describe('Audit on a trail that cannot record', function () {
  this.timeout(20000);

  it('fails the registration of the route, so the application does not boot', async () => {
    expect(await bootFailure({ audit: { trails: TRAILS }, controllers: [NowhereController] })).to.contain('no trail named "nope"');
  });

  it('fails the boot on a misspelt key of audit.http instead of dropping it', async () => {
    const message = await bootFailure({ audit: { trails: TRAILS, http: { trial: 'admin' } }, http: { routes: { middlewares: ['Audit'] } }, controllers: [PlainController] });
    expect(message).to.contain('Invalid configuration: audit.http.trial');
  });

  it('names the store of the default trail when no package registered it (@spinajs/audit-orm is not installed)', async () => {
    const message = await bootFailure({ audit: {}, http: { routes: { middlewares: ['Audit'] } }, controllers: [PlainController] });
    expect(message).to.contain('trail "default" names the store "TableAuditStore", and no AuditStore is registered under that name');
  });
});

describe('Audit resolved in a child container', function () {
  this.timeout(20000);

  it('defers into the audit service of that container: the root flush misses the event, disposing the container writes it', async () => {
    const app = await auditApp({ scope: 'child', audit: { trails: TRAILS, deferred: { flushMs: 60000 } }, http: { routes: { middlewares: ['Audit'] } }, controllers: [PlainController] });
    MemoryAuditStore.clear();
    try {
      expect(audit(app.container)).to.not.eq(audit());
      expect((await req().get('audit-plain/plain')).status).to.eq(200);
      await settle();
      await audit().flush();
      expect(MemoryAuditStore.events()).to.have.length(0);
    } finally {
      await app.dispose();
    }
    expect(MemoryAuditStore.events()).to.have.length(1);
  });
});
