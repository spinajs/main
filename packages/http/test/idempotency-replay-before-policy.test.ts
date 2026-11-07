import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { IdempotencyService } from '@spinajs/idempotency';
import { Intl } from '@spinajs/intl';
import { Log } from '@spinajs/log';
import type { TestApp } from '@spinajs/testing';
import { httpApp, req, TestConfiguration } from './common.js';
import { Audit, AuditSink, BaseController, BasePath, BasePolicy, Controllers, Del, HttpServer, Idempotent, Middleware, Ok, Param, Policy, ReplayedResponse, RouteMiddleware } from '../src/index.js';
import type { IAuditRecord, IMiddlewareContext, IReplyContext, MiddlewareStage, Request } from '../src/index.js';

const state = {
  rows: new Set<string>(),
  actionCalls: 0,
  policyCalls: 0,
  hold: undefined as Promise<void> | undefined,
  beforePolicyAfter: [] as Array<{ status: number; replay: boolean }>,
  outerAfter: [] as number[],
};

class ReplayAuditSink extends AuditSink {
  public static records: IAuditRecord[] = [];

  public write(record: IAuditRecord): void {
    ReplayAuditSink.records.push(record);
  }
}

/** Stands for the Authn/Principal server middlewares: the principal is known before the policy gate. */
class SignIn extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'beforePolicy';

  public onBefore({ req, storage }: IMiddlewareContext): Ok | undefined {
    const id = req.headers['x-user'];
    if (typeof id === 'string') {
      Object.assign(storage, { Principal: { type: 'user', id, authenticated: true, source: 'test', attributes: {} } });
    }
    return req.headers['x-maintenance'] ? new Ok({ maintenance: true }) : undefined;
  }

  public onAfter({ response }: IReplyContext): void {
    state.beforePolicyAfter.push({ status: response.statusCode, replay: response instanceof ReplayedResponse });
  }
}

class OuterProbe extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  public onAfter({ response }: IReplyContext): void {
    state.outerAfter.push(response.statusCode);
  }
}

/** Judges the current state: once the row is deleted, a resend is refused. */
class RowExists extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    state.policyCalls++;
    if (!state.rows.has(String(req.params.id))) {
      throw new Forbidden('no such item');
    }
  }
}

@BasePath('replay-items')
@Middleware(Audit)
@Middleware(SignIn)
@Middleware(OuterProbe)
class ReplayItemsController extends BaseController {
  @Del(':id')
  @Idempotent()
  @Policy(RowExists)
  public async remove(@Param() id: string) {
    state.actionCalls++;
    if (state.hold) {
      await state.hold;
    }
    state.rows.delete(id);
    return new Ok({ deleted: id, call: state.actionCalls });
  }
}

class ReplayConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.idempotency = { store: 'MemoryIdempotencyStore', lease: '30s', sweepBatch: 500, sweepEvery: '5m' };
  }
}

const remove = (id: string, key?: string, user?: string, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { Accept: 'application/json', ...extra };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  if (user !== undefined) headers['x-user'] = user;
  return req().delete(`replay-items/${id}`).set(headers);
};

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Idempotency-Key replay before the policy gate', function () {
  this.timeout(20_000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      configuration: ReplayConfiguration,
      register: (c) => {
        c.register(ReplayAuditSink).as(AuditSink);
        c.register(ReplayItemsController).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(() => app.dispose());

  beforeEach(() => {
    state.rows = new Set(['a', 'b', 'c']);
    state.actionCalls = 0;
    state.policyCalls = 0;
    state.hold = undefined;
    state.beforePolicyAfter = [];
    state.outerAfter = [];
    ReplayAuditSink.records = [];
  });

  afterEach(() => sinon.restore());

  it('replays a completed key of the same principal although the policy now refuses, without the policy or the action', async () => {
    const first = await remove('a', 'del-1', 'u1');
    const again = await remove('a', 'del-1', 'u1');

    expect(first.status).to.eq(200);
    expect(first.body).to.deep.eq({ deleted: 'a', call: 1 });
    expect(again.status).to.eq(200);
    expect(again.text).to.eq(first.text);
    expect(again.headers['idempotent-replayed']).to.eq('true');
    expect(state.actionCalls).to.eq(1);
    expect(state.policyCalls).to.eq(1);
  });

  it('judges the resend of an anonymous caller by the policies: anonymous callers share one scope', async () => {
    const first = await remove('a', 'del-anon-1');
    const again = await remove('a', 'del-anon-1');

    expect(first.status).to.eq(200);
    expect(again.status).to.eq(403);
    expect(again.headers['idempotent-replayed']).to.eq(undefined);
    expect(state.actionCalls).to.eq(1);
    expect(state.policyCalls).to.eq(2);
  });

  it("judges another principal's request with the same key by the policies", async () => {
    await remove('a', 'del-other-1', 'u1');
    const other = await remove('a', 'del-other-1', 'u2');

    expect(other.status).to.eq(403);
    expect(state.policyCalls).to.eq(2);
  });

  it('runs the policies when the key has no record', async () => {
    const missing = await remove('zz', 'del-none-1', 'u1');
    const first = await remove('b', 'del-none-2', 'u1');

    expect(missing.status).to.eq(403);
    expect(first.status).to.eq(200);
    expect(first.headers['idempotent-replayed']).to.eq(undefined);
    expect(state.policyCalls).to.eq(2);
    expect(state.actionCalls).to.eq(1);
  });

  it('leaves a key in flight to the policies and the claim: 409 while the row still exists', async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));

    const first = remove('a', 'del-race-1', 'u1').then((res) => res);
    await waitFor(() => state.actionCalls === 1);

    const second = await remove('a', 'del-race-1', 'u1');
    expect(second.status).to.eq(409);
    expect(second.body.code).to.eq('idempotency.in-flight');
    expect(state.policyCalls).to.eq(2);

    release();
    expect((await first).status).to.eq(200);
    const third = await remove('a', 'del-race-1', 'u1');
    expect(third.status).to.eq(200);
    expect(third.headers['idempotent-replayed']).to.eq('true');
    expect(state.policyCalls).to.eq(2);
    expect(state.actionCalls).to.eq(1);
  });

  it('refuses the key on another request with 422 after the policies, never replays it', async () => {
    await remove('a', 'del-reuse-1', 'u1');
    const reuse = await remove('b', 'del-reuse-1', 'u1');

    expect(reuse.status).to.eq(422);
    expect(reuse.body.code).to.eq('idempotency.key-reuse');
    expect(state.policyCalls).to.eq(2);
    expect(state.rows.has('b')).to.eq(true);
  });

  it("sends the replay through the reply pipeline: the 'beforePolicy' middlewares see it, Audit records it, the outer ones are not entered", async () => {
    await remove('a', 'del-audit-1', 'u1');
    const again = await remove('a', 'del-audit-1', 'u1');

    expect(again.status).to.eq(200);
    expect(state.beforePolicyAfter).to.deep.eq([
      { status: 200, replay: false },
      { status: 200, replay: true },
    ]);
    expect(state.outerAfter).to.deep.eq([200]);

    await waitFor(() => ReplayAuditSink.records.length === 2);
    const [, replayed] = ReplayAuditSink.records;
    expect(replayed.status).to.eq(200);
    expect(replayed.method).to.eq('DELETE');
    expect(replayed.principal).to.include({ type: 'user', id: 'u1' });
  });

  it("judges an answer of a 'beforePolicy' middleware by the policies instead of replaying", async () => {
    await remove('a', 'del-maint-1', 'u1');
    const answered = await remove('a', 'del-maint-1', 'u1', { 'x-maintenance': '1' });

    expect(answered.status).to.eq(403);
    expect(state.policyCalls).to.eq(2);
  });

  it('runs the policies and the claim when the store fails on the replay check, and logs it', async () => {
    await remove('a', 'del-store-1', 'u1');

    const service = await app.resolve(IdempotencyService);
    sinon.stub(service, 'peek').rejects(new Error('store down'));
    const warn = sinon.spy(DI.resolve(Log, ['http']), 'warn');

    const again = await remove('a', 'del-store-1', 'u1');
    expect(again.status).to.eq(403);
    expect(state.policyCalls).to.eq(2);
    expect(state.actionCalls).to.eq(1);
    expect(warn.args.some(([, message]) => String(message).includes('reading its key before the policies failed'))).to.eq(true);
  });
});
