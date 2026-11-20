import 'mocha';
import { expect } from 'chai';
import { AuditConfigError, AuditStore, audit } from '@spinajs/audit';
import type { AuditAppend, StoredAuditEvent } from '@spinajs/audit';
import { MemoryAuditStore } from '@spinajs/audit/testing';
import { DI, Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, BasePolicy, Body, Del, Get, Middleware, Ok, Param, Policy, Post, REDACTED, RouteMiddleware } from '@spinajs/http';
import type { IMiddlewareContext, MiddlewareStage } from '@spinajs/http';
import { Log } from '@spinajs/log-common';
import type { TestApp } from '@spinajs/testing';

import { Audit } from '../src/index.js';
import { auditApp, bootFailure, req } from './support/app.js';

const seen = { ran: 0, policy: 0, beforeAction: [] as string[] };

class Sealed extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('sealed');
  }
}

class Counted extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    seen.policy++;
    return Promise.resolve();
  }
}

/** Stands for the authn server middlewares: the principal is known before Audit's onBefore. */
class SignIn extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'beforePolicy';

  public onBefore({ storage }: IMiddlewareContext): void {
    Object.assign(storage, { Principal: { type: 'user', id: 'u7', authenticated: true, source: 'test', attributes: {} } });
  }
}

@Injectable(AuditStore)
class MisconfiguredAuditStore extends MemoryAuditStore {
  public override append(): Promise<void> {
    return Promise.reject(new AuditConfigError('audit: table audit_event does not exist'));
  }
}

@Injectable(AuditStore)
class OutcomeLosingAuditStore extends MemoryAuditStore {
  public override append(write: AuditAppend): Promise<void> {
    return write.events.every((e) => e.outcome === 'attempt') ? super.append(write) : Promise.reject(new Error('the store went away'));
  }
}

@BasePath('vault')
@Middleware(SignIn)
class VaultController extends BaseController {
  @Post()
  @Middleware(Audit, { trail: 'restricted', action: 'vault.open' })
  public open(@Body() _data: object) {
    seen.ran++;
    seen.beforeAction = MemoryAuditStore.events('restricted').map((e) => e.outcome);
    return new Ok({ ok: true });
  }

  @Post()
  @Policy(Counted)
  @Middleware(Audit, { trail: 'restricted', action: 'vault.guarded' })
  public guarded() {
    seen.ran++;
    return new Ok({ ok: true });
  }

  @Get()
  @Middleware(Audit, { trail: 'restricted', action: 'vault.peek', methods: ['GET'] })
  public peek() {
    seen.ran++;
    return new Ok({ ok: true });
  }

  @Post()
  @Middleware(Audit, { trail: 'lossy', action: 'vault.lossy' })
  public lossy() {
    return new Ok({ ok: true });
  }

  @Post()
  @Middleware(Audit, { trail: 'misconfigured' })
  public misconfigured() {
    seen.ran++;
    return new Ok({ ok: true });
  }

  @Get()
  @Policy(Sealed)
  @Middleware(Audit, { trail: 'restricted', action: 'vault.sealed' })
  public sealed() {
    seen.ran++;
    return new Ok({ ok: true });
  }
}

@BasePath('admin')
class RuleAdminController extends BaseController {
  @Del('users/:id')
  public remove(@Param() id: string) {
    return new Ok({ id });
  }
}

@BasePath('reports')
class RuleReportsController extends BaseController {
  @Get()
  public list() {
    return new Ok([]);
  }
}

const TRAILS = {
  default: { store: 'MemoryAuditStore' },
  reports: { store: 'MemoryAuditStore' },
  restricted: { store: 'MemoryAuditStore', onFailure: 'reject', retry: { attempts: 2, delay: '1ms' } },
  misconfigured: { store: MisconfiguredAuditStore.name, onFailure: 'reject', retry: { attempts: 1 } },
  lossy: { store: OutcomeLosingAuditStore.name, onFailure: 'reject', retry: { attempts: 1 } },
};

const dataOf = (event: StoredAuditEvent) => event.data as Record<string, unknown>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function eventsOf(trail: string, count: number): Promise<readonly StoredAuditEvent[]> {
  for (let i = 0; i < 100; i++) {
    await audit().flush();
    const found = MemoryAuditStore.events(trail);
    if (found.length >= count) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`trail ${trail} never held ${count} events`);
}

describe('Audit on a reject trail', function () {
  this.timeout(20000);

  let app: TestApp;

  before(async () => {
    app = await auditApp({ audit: { trails: TRAILS }, controllers: [VaultController] });
  });

  after(() => app.dispose());

  beforeEach(() => {
    MemoryAuditStore.clear();
    seen.ran = 0;
    seen.policy = 0;
    seen.beforeAction = [];
  });

  it('confirms an attempt before the action runs, then records the outcome under the same invocation', async () => {
    const res = await req().post('vault/open').send({ code: 'c', password: 'p' });
    expect(res.status).to.eq(200);
    expect(seen.beforeAction).to.deep.eq(['attempt']);

    const [attempt, outcome] = await eventsOf('restricted', 2);
    expect([attempt.action, attempt.outcome]).to.deep.eq(['vault.open', 'attempt']);
    expect([outcome.action, outcome.outcome]).to.deep.eq(['vault.open', 'ok']);
    expect(dataOf(attempt).invocation).to.be.a('string').and.eq(dataOf(outcome).invocation);
    expect(dataOf(attempt).body).to.deep.eq({ code: 'c', password: REDACTED });
    expect(dataOf(attempt)).to.not.have.property('status');
    expect(dataOf(outcome).status).to.eq(200);
    // onBefore runs outside the request's context; the attempt is still stamped from it
    expect([attempt.actor, outcome.actor]).to.deep.eq(['user:u7', 'user:u7']);
  });

  it('answers 503 and runs neither the policy nor the action when the attempt cannot be recorded', async () => {
    MemoryAuditStore.failNext(2);

    const res = await req().post('vault/guarded').send({ code: 'c' });

    expect(res.status).to.eq(503);
    expect([seen.policy, seen.ran]).to.deep.eq([0, 0]);
    await settle();
    await audit().flush();
    expect(MemoryAuditStore.events('restricted')).to.have.length(0);
  });

  it('answers 500, not 503, when the trail refuses the attempt as misconfigured: no retry helps', async () => {
    const res = await req().post('vault/misconfigured').send({});

    expect(res.status).to.eq(500);
    expect(seen.ran).to.eq(0);
    await settle();
    await audit().flush();
    expect(MemoryAuditStore.events()).to.have.length(0);
  });

  it('keeps the attempt and logs the loss when the outcome cannot be written; the response is unchanged', async () => {
    // loggers are cached by name, so this is the instance the audit service logs to
    const pipeline = DI.resolve(Log, ['audit-pipeline']);
    const logged: unknown[] = [];
    pipeline.error = (fields: unknown) => void logged.push(fields);

    try {
      expect((await req().post('vault/lossy').send({})).status).to.eq(200);
      for (let i = 0; i < 100 && logged.length === 0; i++) await settle();
    } finally {
      Reflect.deleteProperty(pipeline, 'error');
    }
    expect(MemoryAuditStore.events('lossy').map((e) => e.outcome)).to.deep.eq(['attempt']);
    expect(logged).to.have.length(1);
    expect(logged[0]).to.include({ trail: 'lossy', count: 1 });
  });

  it('audits a HEAD request to an audited GET route: it runs the GET action', async () => {
    expect((await req().head('vault/peek')).status).to.eq(200);
    expect(seen.ran).to.eq(1);

    const events = await eventsOf('restricted', 2);
    expect(events.map((e) => [e.outcome, dataOf(e).method])).to.deep.eq([
      ['attempt', 'HEAD'],
      ['ok', 'HEAD'],
    ]);
  });

  it('records a policy refusal as an attempt and a denial', async () => {
    const res = await req().get('vault/sealed');
    expect(res.status).to.eq(403);
    expect(seen.ran).to.eq(0);

    const events = await eventsOf('restricted', 2);
    expect(events.map((e) => e.outcome)).to.deep.eq(['attempt', 'denied']);
  });
});

describe('audit.http.rules', function () {
  this.timeout(20000);

  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.dispose();
    app = undefined;
  });

  beforeEach(() => MemoryAuditStore.clear());

  it('give matching routes their action and trail; every other mounted route keeps the defaults', async () => {
    app = await auditApp({
      audit: {
        trails: TRAILS,
        http: {
          rules: [
            { match: 'DELETE /admin/**', action: 'admin.delete', trail: 'restricted' },
            { match: '* /reports/*', trail: 'reports' },
          ],
        },
      },
      http: { routes: { middlewares: ['Audit'] } },
      controllers: [RuleAdminController, RuleReportsController, VaultController],
    });

    await req().delete('admin/users/7');
    await req().get('reports/list');

    const restricted = await eventsOf('restricted', 2);
    expect(restricted.map((e) => [e.action, e.outcome])).to.deep.eq([
      ['admin.delete', 'attempt'],
      ['admin.delete', 'ok'],
    ]);
    const [report] = await eventsOf('reports', 1);
    expect(report.action).to.eq(dataOf(report).route);
    expect(MemoryAuditStore.events('default')).to.have.length(0);
  });

  it('a rule the middleware cannot read fails the boot', async () => {
    const message = await bootFailure({ audit: { trails: TRAILS, http: { rules: [{ match: 'DELETE' }] } }, http: { routes: { middlewares: ['Audit'] } }, controllers: [RuleReportsController] });
    expect(message).to.contain('audit.http.rules[0]: match must be');
  });

  it('a misspelt key of a rule fails the boot instead of being dropped', async () => {
    const message = await bootFailure({ audit: { trails: TRAILS, http: { rules: [{ match: 'DELETE /admin/**', trial: 'restricted' }] } }, http: { routes: { middlewares: ['Audit'] } }, controllers: [RuleAdminController] });
    expect(message).to.contain('Invalid configuration: audit.http.rules');
  });

  it('a rule that sets neither action nor trail fails the boot', async () => {
    const message = await bootFailure({ audit: { trails: TRAILS, http: { rules: [{ match: 'DELETE /admin/**' }] } }, http: { routes: { middlewares: ['Audit'] } }, controllers: [RuleAdminController] });
    expect(message).to.contain('audit.http.rules[0]: a rule sets action, trail or both');
  });

  it('a rule naming an unknown trail fails the registration of the route', async () => {
    const message = await bootFailure({ audit: { trails: TRAILS, http: { rules: [{ match: '* /admin/**', trail: 'nope' }] } }, http: { routes: { middlewares: ['Audit'] } }, controllers: [RuleAdminController] });
    expect(message).to.contain('no trail named "nope"');
  });

  it('a rule matching a route where Audit is not mounted records nothing', async () => {
    app = await auditApp({ audit: { trails: TRAILS, http: { rules: [{ match: '* /admin/**', trail: 'restricted' }] } }, controllers: [RuleAdminController] });

    expect((await req().delete('admin/users/7')).status).to.eq(200);
    await settle();
    await audit().flush();
    expect(MemoryAuditStore.events()).to.have.length(0);
  });
});
