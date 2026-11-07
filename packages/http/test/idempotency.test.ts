import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { NewInstance } from '@spinajs/di';
// registers the stores and the idempotency schema before the boot
import { IdempotencyClaimConflict, IdempotencyService } from '@spinajs/idempotency';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';
import { httpApp, req, TestConfiguration } from './common.js';
import { BaseController, BasePath, BasePolicy, Body, CodedHttpException, Controllers, Created, HttpServer, Idempotent, Middleware, Ok, Param, Policy, Post, ReplayedResponse, RouteMiddleware } from '../src/index.js';
import type { IMiddlewareContext, IReplyContext, MiddlewareStage, Request } from '../src/interfaces.js';

const state = { calls: 0, afterCalls: 0, perRequest: 0, sawReplay: [] as boolean[], outerAfter: [] as string[], closed: false, inPolicy: false, hold: undefined as Promise<void> | undefined, policyHold: undefined as Promise<void> | undefined };

/** Counts onAfter (the inner middlewares are not entered for a replay, so it runs for the first answer only) and sees the connection close. */
class AfterProbe extends RouteMiddleware {
  public isEnabled(): boolean {
    return true;
  }

  public async onBefore({ res }: IMiddlewareContext): Promise<void> {
    res.once('close', () => (state.closed = true));
  }

  public async onAfter(): Promise<void> {
    state.afterCalls++;
  }
}

/** Declared on the controller, so it is entered before the route's idempotency gate: it sees replays too. */
class OuterAfterProbe extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  public async onAfter({ response, res }: IReplyContext): Promise<void> {
    state.outerAfter.push(String(response.statusCode));
    res.setHeader('X-Outer-After', String(state.outerAfter.length));
  }
}

/** Wraps the reply data; with `guarded`, it leaves a replay alone, whose stored body it already wrapped. */
@NewInstance()
class Envelope extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  constructor(protected readonly guarded: boolean) {
    super();
  }

  public async onAfter(ctx: IReplyContext): Promise<void> {
    state.sawReplay.push(ctx.response instanceof ReplayedResponse);
    if (ctx.error !== undefined || (this.guarded && ctx.response instanceof ReplayedResponse)) return;
    ctx.response.data = { envelope: await ctx.response.data };
  }
}

/** A header of this one request: a replay, which never enters this inner middleware, must not restore it. */
class PerRequestHeader extends RouteMiddleware {
  public async onAfter({ res }: IReplyContext): Promise<void> {
    res.setHeader('X-Per-Request', String(++state.perRequest));
  }
}

/** Signs the caller in as the user named by x-user, as authz-http's PrincipalMiddleware would. */
class IdemTestPrincipal extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    const id = req.headers['x-user'];
    if (typeof id === 'string') {
      (req.storage as unknown as Record<string, unknown>).Principal = { type: 'user', id, authenticated: true, source: 'test', attributes: {} };
    }
    if (req.headers['x-hold-policy'] && state.policyHold) {
      req.res?.once('close', () => (state.closed = true));
      state.inPolicy = true;
      await state.policyHold;
    }
  }
}

@BasePath('idem')
@Policy(IdemTestPrincipal)
@Middleware(AfterProbe)
@Middleware(OuterAfterProbe)
class IdemController extends BaseController {
  @Post()
  @Idempotent()
  public async create(@Body() body: { n: number }) {
    state.calls++;
    if (state.hold) {
      await state.hold;
    }
    return new Created(
      { n: body?.n, call: state.calls },
      {
        Headers: [
          { Name: 'Location', Value: `/idem/${state.calls}` },
          { Name: 'X-Order-Version', Value: String(state.calls) },
        ],
      },
    );
  }

  @Post()
  @Idempotent({ required: true })
  public async required() {
    state.calls++;
    return new Ok({ call: state.calls });
  }

  @Post()
  @Idempotent()
  public async boom() {
    state.calls++;
    throw new Error('exploded');
  }

  @Post()
  @Idempotent()
  public async crash() {
    state.calls++;
    throw Object.assign(new Error('the process died'), { crash: true });
  }

  @Post()
  @Idempotent()
  public async refuse() {
    state.calls++;
    throw new CodedHttpException(404, 'idem.missing', `nothing for call ${state.calls}`);
  }

  @Post()
  @Idempotent()
  public async refusedWith(@Body() body: { status: number }) {
    state.calls++;
    throw new CodedHttpException(body.status, 'idem.later', 'try again later');
  }

  @Post()
  @Idempotent({ maxReplyBytes: 16 })
  public async big() {
    state.calls++;
    return new Ok({ call: state.calls, padding: 'x'.repeat(64) });
  }

  // written below @Idempotent, so entered before the gate: it runs on replays too
  @Post()
  @Idempotent()
  @Middleware(Envelope, true)
  public async enveloped() {
    state.calls++;
    return new Ok({ call: state.calls });
  }

  @Post()
  @Idempotent()
  @Middleware(Envelope, false)
  public async envelopedTwice() {
    state.calls++;
    return new Ok({ call: state.calls });
  }

  @Post()
  @Idempotent()
  @Middleware(PerRequestHeader)
  public async perRequest() {
    state.calls++;
    return new Ok({ call: state.calls });
  }

  @Post(':id/pay')
  @Idempotent()
  public async pay(@Param() id: string) {
    state.calls++;
    return new Ok({ id, call: state.calls });
  }
}

class IdemConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.idempotency = { store: 'MemoryIdempotencyStore', lease: '30s', sweepBatch: 500, sweepEvery: '5m' };
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Answer {
  headers: unknown;
  body: unknown;
}

const headersOf = (res: Answer) => res.headers as Record<string, string | undefined>;

const bodyOf = (res: Answer) => res.body as { code?: string; id?: string; call?: number };

const post = (path: string, key?: string, user?: string) => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  if (user !== undefined) headers['x-user'] = user;
  return req().post(`idem/${path}`).set(headers);
};

describe('Idempotency-Key', function () {
  this.timeout(20_000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({ configuration: IdemConfiguration, register: (c) => c.register(IdemController).as(BaseController), resolve: [Intl, Controllers] });
    await (await app.resolve(HttpServer)).start();
  });

  after(() => app.dispose());

  beforeEach(() => {
    state.calls = 0;
    state.afterCalls = 0;
    state.outerAfter = [];
    state.perRequest = 0;
    state.sawReplay = [];
    state.closed = false;
    state.inPolicy = false;
    state.hold = undefined;
    state.policyHold = undefined;
  });

  afterEach(() => sinon.restore());

  it('replays an identical response and runs the route once', async () => {
    const first = await post('create', 'replay-1', 'u1').send({ n: 1 });
    const again = await post('create', 'replay-1', 'u1').send({ n: 1 });

    expect(first.status).to.eq(201);
    expect(again.status).to.eq(201);
    expect(again.text).to.equal(first.text);
    expect(headersOf(again)['content-type']).to.equal(headersOf(first)['content-type']);
    expect(headersOf(again).location).to.equal('/idem/1');
    expect(headersOf(again)['x-order-version']).to.equal('1');
    expect(headersOf(again).etag).to.equal(headersOf(first).etag);
    expect(headersOf(first)['idempotent-replayed']).to.equal(undefined);
    expect(headersOf(again)['idempotent-replayed']).to.equal('true');
    expect(state.calls).to.equal(1);
    // the inner middlewares were not entered for the replay
    expect(state.afterCalls).to.equal(1);
  });

  it('sends a replay through the reply pipeline: a middleware entered before the gate sees it in onAfter', async () => {
    const first = await post('create', 'replay-outer-1', 'u1').send({ n: 1 });
    const again = await post('create', 'replay-outer-1', 'u1').send({ n: 1 });

    expect(headersOf(again)['idempotent-replayed']).to.equal('true');
    expect(state.outerAfter).to.deep.equal(['201', '201']);
    expect(headersOf(first)['x-outer-after']).to.equal('1');
    expect(headersOf(again)['x-outer-after']).to.equal('2');
  });

  it('gives onAfter the stored body as data on a replay, so a hook that tells a replay apart sends it unchanged', async () => {
    const first = await post('enveloped', 'envelope-1', 'u1').send({});
    const again = await post('enveloped', 'envelope-1', 'u1').send({});

    expect(first.status).to.eq(200);
    expect(first.body).to.deep.eq({ envelope: { call: 1 } });
    expect(again.status).to.eq(200);
    expect(again.text).to.eq(first.text);
    expect(headersOf(again).etag).to.eq(headersOf(first).etag);
    expect(headersOf(again)['idempotent-replayed']).to.eq('true');
    expect(state.sawReplay).to.deep.eq([false, true]);
    expect(state.calls).to.eq(1);
  });

  it('sends a data change an onAfter made on a replay, and never fails the retry', async () => {
    const first = await post('envelopedTwice', 'envelope-2', 'u1').send({});
    const again = await post('envelopedTwice', 'envelope-2', 'u1').send({});
    const third = await post('envelopedTwice', 'envelope-2', 'u1').send({});

    expect(first.body).to.deep.eq({ envelope: { call: 1 } });
    expect(again.status).to.eq(200);
    expect(again.body).to.deep.eq({ envelope: { envelope: { call: 1 } } });
    expect(third.body).to.deep.eq(again.body);
    expect(headersOf(again)['content-type']).to.match(/json/);
    // the stored ETag names the stored body, not the changed one
    expect(headersOf(first).etag).to.be.a('string');
    expect(headersOf(again).etag).to.not.eq(headersOf(first).etag);
    expect(state.calls).to.eq(1);
  });

  it('does not replay a header an onAfter hook added for the first answer', async () => {
    const first = await post('perRequest', 'per-request-1', 'u1').send({});
    const again = await post('perRequest', 'per-request-1', 'u1').send({});

    expect(headersOf(first)['x-per-request']).to.eq('1');
    expect(headersOf(again)['idempotent-replayed']).to.eq('true');
    expect(headersOf(again)['x-per-request']).to.eq(undefined);
    expect(state.perRequest).to.eq(1);
  });

  it('takes the quoted form of a key as the same key', async () => {
    await post('create', '"quoted-1"', 'u1').send({ n: 1 });
    const again = await post('create', 'quoted-1', 'u1').send({ n: 1 });

    expect(headersOf(again)['idempotent-replayed']).to.equal('true');
    expect(state.calls).to.equal(1);
  });

  it('answers a concurrent request with the same key 409 and Retry-After', async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));

    const first = post('create', 'race-1', 'u1')
      .send({ n: 1 })
      .then((res) => res);
    await waitFor(() => state.calls === 1);

    const second = await post('create', 'race-1', 'u1').send({ n: 1 });
    expect(second.status).to.eq(409);
    expect(second.type).to.eq('application/problem+json');
    expect(bodyOf(second).code).to.equal('idempotency.in-flight');
    expect(headersOf(second)['retry-after']).to.match(/^\d+$/);

    release();
    expect((await first).status).to.eq(201);
    expect(state.calls).to.equal(1);
  });

  it('refuses a concurrent request with the same key and a different body with 422, not 409', async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));

    const first = post('create', 'race-2', 'u1')
      .send({ n: 1 })
      .then((res) => res);
    await waitFor(() => state.calls === 1);

    const other = await post('create', 'race-2', 'u1').send({ n: 2 });
    expect(other.status).to.eq(422);
    expect(bodyOf(other).code).to.equal('idempotency.key-reuse');

    release();
    expect((await first).status).to.eq(201);
    expect(state.calls).to.equal(1);
  });

  it('keeps the claim of a request whose client went away, so a retry is told to wait', async () => {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => (release = resolve));

    const gone = post('create', 'gone-1', 'u1').send({ n: 1 });
    const failed = gone.then(
      () => null,
      (err: unknown) => err,
    );
    await waitFor(() => state.calls === 1);
    // superagent destroys the socket: the server sees close without finish
    gone.abort();
    expect(await failed).to.not.equal(null);
    // the server has to see the close before the handler answers, or the reply finishes into the closed socket
    await waitFor(() => state.closed);

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retry = await post('create', 'gone-1', 'u1').send({ n: 1 });

    expect(retry.status).to.eq(409);
    expect(bodyOf(retry).code).to.equal('idempotency.in-flight');
    expect(state.calls).to.equal(1);
  });

  it('refuses the same key with a different body with 422', async () => {
    await post('create', 'body-1', 'u1').send({ n: 1 });
    const other = await post('create', 'body-1', 'u1').send({ n: 2 });

    expect(other.status).to.eq(422);
    expect(other.type).to.eq('application/problem+json');
    expect(bodyOf(other).code).to.equal('idempotency.key-reuse');
    expect(state.calls).to.equal(1);
  });

  it('refuses the same key and body on another resource of the same route with 422', async () => {
    const first = await post('1/pay', 'target-1', 'u1').send({});
    const other = await post('2/pay', 'target-1', 'u1').send({});

    expect(first.status).to.eq(200);
    expect(bodyOf(first).id).to.equal('1');
    expect(other.status).to.eq(422);
    expect(bodyOf(other).code).to.equal('idempotency.key-reuse');
    expect(state.calls).to.equal(1);
  });

  it('does not keep a 500, so a retry runs again', async () => {
    expect((await post('boom', 'boom-1', 'u1').send({})).status).to.eq(500);
    expect((await post('boom', 'boom-1', 'u1').send({})).status).to.eq(500);
    expect(state.calls).to.equal(2);
  });

  it('neither stores nor releases the key of a route that crashed', async () => {
    expect((await post('crash', 'crash-1', 'u1').send({})).status).to.eq(500);
    const retry = await post('crash', 'crash-1', 'u1').send({});

    expect(retry.status).to.eq(409);
    expect(bodyOf(retry).code).to.equal('idempotency.in-flight');
    expect(state.calls).to.equal(1);
  });

  it('keeps a 4xx answer and replays it', async () => {
    const first = await post('refuse', 'refuse-1', 'u1').send({});
    const again = await post('refuse', 'refuse-1', 'u1').send({});

    expect(first.status).to.eq(404);
    expect(again.status).to.eq(404);
    expect(again.text).to.equal(first.text);
    expect(headersOf(again)['idempotent-replayed']).to.equal('true');
    expect(state.calls).to.equal(1);
  });

  it('does not keep a 401, 403, 408, 425 or 429, so a retry runs again', async () => {
    for (const status of [401, 403, 408, 425, 429]) {
      expect((await post('refusedWith', `later-${status}`, 'u1').send({ status })).status).to.eq(status);
      const again = await post('refusedWith', `later-${status}`, 'u1').send({ status });

      expect(again.status).to.eq(status);
      expect(headersOf(again)['idempotent-replayed']).to.equal(undefined);
    }
    expect(state.calls).to.equal(10);
  });

  it('neither claims nor runs the route for a client that left before the claim', async () => {
    let release!: () => void;
    state.policyHold = new Promise<void>((resolve) => (release = resolve));

    const gone = post('create', 'early-1', 'u1').set('x-hold-policy', '1').send({ n: 1 });
    const failed = gone.then(
      () => null,
      (err: unknown) => err,
    );
    await waitFor(() => state.inPolicy);
    gone.abort();
    expect(await failed).to.not.equal(null);
    await waitFor(() => state.closed);

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retry = await post('create', 'early-1', 'u1').send({ n: 1 });

    expect(retry.status).to.eq(201);
    expect(headersOf(retry)['idempotent-replayed']).to.equal(undefined);
    expect(state.calls).to.equal(1);
  });

  it('compares a body no parser read by its media type and length', async () => {
    const upload = (value: string) => post('create', 'upload-1', 'u1').field('note', value);

    await upload('a');
    const same = await upload('b');
    const other = await upload('bb');

    expect(headersOf(same)['idempotent-replayed']).to.equal('true');
    expect(other.status).to.eq(422);
    expect(state.calls).to.equal(1);
  });

  it('answers 400 to a required route without the header and to a malformed key', async () => {
    const missing = await post('required', undefined, 'u1').send({});
    const malformed = await post('required', 'x'.repeat(256), 'u1').send({});

    expect(missing.status).to.eq(400);
    expect(bodyOf(missing).code).to.equal('idempotency.key-required');
    expect(malformed.status).to.eq(400);
    expect(bodyOf(malformed).code).to.equal('idempotency.key-malformed');
    expect(state.calls).to.equal(0);
  });

  it('runs an optional route without the header as usual', async () => {
    await post('create', undefined, 'u1').send({ n: 1 });
    const again = await post('create', undefined, 'u1').send({ n: 1 });

    expect(headersOf(again)['idempotent-replayed']).to.equal(undefined);
    expect(state.calls).to.equal(2);
  });

  it('keeps principals apart: the same key from two users runs twice', async () => {
    await post('create', 'shared-1', 'alice').send({ n: 1 });
    await post('create', 'shared-1', 'bob').send({ n: 1 });
    const replay = await post('create', 'shared-1', 'alice').send({ n: 1 });

    expect(state.calls).to.equal(2);
    expect(headersOf(replay)['idempotent-replayed']).to.equal('true');
    expect(bodyOf(replay).call).to.equal(1);
  });

  it('does not store a reply above maxReplyBytes', async () => {
    await post('big', 'big-1', 'u1').send({});
    const again = await post('big', 'big-1', 'u1').send({});

    expect(headersOf(again)['idempotent-replayed']).to.equal(undefined);
    expect(state.calls).to.equal(2);
  });

  it('answers a claim that lost a transaction conflict 409 with Retry-After', async () => {
    const service = await app.resolve(IdempotencyService);
    sinon.stub(service, 'run').rejects(new IdempotencyClaimConflict('k', new Error('deadlock')));

    const res = await post('create', 'conflict-1', 'u1').send({ n: 1 });

    expect(res.status).to.eq(409);
    expect(bodyOf(res).code).to.equal('idempotency.claim-conflict');
    expect(headersOf(res)['retry-after']).to.equal('1');
    expect(state.calls).to.equal(0);
  });
});

// registered alone: the loader reports a subclass as the override of its parent
class IdemRedecoratedController extends IdemController {
  @Post()
  @Idempotent({ ttl: '1h' })
  public async create(@Body() body: { n: number }) {
    return super.create(body);
  }
}

describe('Idempotency-Key on a re-decorated inherited route', function () {
  this.timeout(20_000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({ configuration: IdemConfiguration, register: (c) => c.register(IdemRedecoratedController).as(BaseController), resolve: [Intl, Controllers] });
    await (await app.resolve(HttpServer)).start();
  });

  after(() => app.dispose());

  it('runs the first keyed request instead of answering it 409 from a nested gate', async () => {
    state.calls = 0;
    const first = await post('create', 'redecorated-1', 'u1').send({ n: 1 });
    const again = await post('create', 'redecorated-1', 'u1').send({ n: 1 });

    expect(first.status).to.eq(201);
    expect(headersOf(again)['idempotent-replayed']).to.equal('true');
    expect(state.calls).to.equal(1);
  });
});
