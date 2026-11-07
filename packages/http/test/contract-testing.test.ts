import 'mocha';
import { expect } from 'chai';
import type Express from 'express';
import { Intl } from '@spinajs/intl';
import { Forbidden, InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
// registers the stores the idempotency gate uses
import '@spinajs/idempotency';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { httpApp, req, TestConfiguration } from './common.js';
import {
  BaseController,
  BasePath,
  CONTRACT_VALIDATOR,
  CONTRACT_VIOLATIONS,
  Controllers,
  ForbiddenResponse,
  Get,
  guardResponseContract,
  HandleException,
  HttpServer,
  Idempotent,
  Middleware,
  NotFound,
  Ok,
  OnError,
  Post,
  ReplayedResponse,
  ResponseContractViolation,
  RouteMiddleware,
  sendReply,
  ServerMiddleware,
  toProblem,
} from '../src/index.js';
import type { ContractValidator, ContractViolation, ContractViolations, IMiddlewareContext, IReplyContext, IRouteInvocation, IRouteOutcome, MiddlewareStage } from '../src/index.js';

@HandleException(ResourceNotFound)
class ContractNotFound extends NotFound {}

const NO_ID = { name: 'no id' };

/** Entered before the route's idempotency gate, so it sees the replay, and breaks its body. */
class BreakReplay extends RouteMiddleware {
  public override readonly Stage: MiddlewareStage = 'outer';

  public async onAfter(ctx: IReplyContext): Promise<void> {
    if (ctx.response instanceof ReplayedResponse) {
      ctx.response.data = NO_ID;
    }
  }
}

class AnswerAround extends RouteMiddleware {
  public async onAround({ req, res }: IRouteInvocation, _proceed: () => Promise<IRouteOutcome>): Promise<void> {
    await sendReply(req, res, new Ok(NO_ID));
  }
}

class AnswerBefore extends RouteMiddleware {
  public async onBefore(_ctx: IMiddlewareContext) {
    return new Ok(NO_ID);
  }
}

/** Answers /contract/server-answer before routing with a problem document that has no title. */
class ServerAnswer extends ServerMiddleware {
  public Order = 1;

  public isEnabled(): boolean {
    return true;
  }

  public onBefore({ req }: IMiddlewareContext) {
    if (req.path !== '/contract/server-answer') {
      return undefined;
    }
    const problem = toProblem(new Forbidden('refused'), 403, { includeStack: false, includeFields: [], isProduction: false });
    delete (problem as { title?: string }).title;
    return new ForbiddenResponse(problem);
  }
}

@BasePath('contract')
@Middleware(BreakReplay)
class ContractController extends BaseController {
  @Get()
  public good() {
    return new Ok({ id: 1 });
  }

  @Get()
  public bad() {
    return new Ok({ name: 'no id' });
  }

  @Get()
  public unchecked() {
    return new Ok({ anything: true });
  }

  @Get()
  public missing() {
    throw new ResourceNotFound('nothing here');
  }

  @Get()
  @Middleware(AnswerBefore)
  public answered() {
    return new Ok({ id: 1 });
  }

  @Get()
  @Middleware(AnswerAround)
  public around() {
    return new Ok({ id: 1 });
  }

  @Get()
  @OnError(InvalidArgument, () => new Ok(NO_ID))
  public handled() {
    throw new InvalidArgument('bad');
  }

  @Post()
  @Idempotent()
  public replayed() {
    return new Ok({ id: 1 });
  }
}

const requiresId = (body: unknown): unknown[] | null => (typeof body === 'object' && body !== null && 'id' in body ? null : [{ message: "must have required property 'id'" }]);

class StubValidator implements ContractValidator {
  public problems: unknown[] = [];
  public responses: { handler: string; status?: number }[] = [];

  public checkResponse(route: { handler: string }, body: unknown, status?: number): unknown[] | null {
    this.responses.push({ handler: route.handler, status });
    return route.handler === 'unchecked' ? null : requiresId(body);
  }

  public checkSchema(_schema: object, body: unknown): unknown[] | null {
    this.problems.push(body);
    return (body as { title?: unknown }).title === undefined ? [{ message: 'no title' }] : null;
  }
}

class Violations implements ContractViolations {
  public list: ContractViolation[] = [];
  public get count(): number {
    return this.list.length;
  }
  public record(violation: ContractViolation): void {
    this.list.push(violation);
  }
}

class ContractConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.idempotency = { store: 'MemoryIdempotencyStore', lease: '30s', sweepBatch: 500, sweepEvery: '5m' };
  }
}

describe('response contract validation', function () {
  this.timeout(60000);

  let app: TestApp;
  let violations: Violations;
  let validator: StubValidator;

  async function boot(contractTesting: Record<string, unknown>) {
    violations = new Violations();
    validator = new StubValidator();
    app = await httpApp({
      register: (c) => {
        c.register(ContractController).as(BaseController);
        c.register(ContractNotFound).asSelf();
        c.register(validator).asValue(CONTRACT_VALIDATOR.key);
        c.register(violations).asValue(CONTRACT_VIOLATIONS.key);
        c.register(ServerAnswer).as(ServerMiddleware);
      },
      configuration: ContractConfiguration,
      resolve: [Intl, Controllers],
    });
    app.config.set('http.contractTesting', contractTesting);
    await (await app.resolve(HttpServer)).start();
  }

  afterEach(async () => {
    await app.dispose();
  });

  it('lets a body that matches its schema through and records nothing', async () => {
    await boot({ enabled: true, mode: 'throw' });
    const res = await req().get('contract/good');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ id: 1 });
    expect(violations.count).to.eq(0);
  });

  it('answers 500 and records the violation for a body missing a required property', async () => {
    await boot({ enabled: true, mode: 'throw' });
    const res = await req().get('contract/bad');
    expect(res.status).to.eq(500);
    expect(violations.count).to.eq(1);
    expect(violations.list[0]).to.deep.include({ controller: 'ContractController', handler: 'bad', kind: 'response', status: 200 });
    expect(violations.list[0].errors).to.deep.eq([{ message: "must have required property 'id'" }]);
  });

  it('only records the violation in log mode and still sends the body', async () => {
    await boot({ enabled: true, mode: 'log' });
    const res = await req().get('contract/bad');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ name: 'no id' });
    expect(violations.count).to.eq(1);
  });

  it('does not check a route without a schema', async () => {
    await boot({ enabled: true, mode: 'throw' });
    expect((await req().get('contract/unchecked')).status).to.eq(200);
    expect(violations.count).to.eq(0);
  });

  it('checks nothing while contract testing is off', async () => {
    await boot({ enabled: false, mode: 'throw' });
    expect((await req().get('contract/bad')).status).to.eq(200);
    expect(violations.count).to.eq(0);
    expect(validator.problems).to.have.length(0);
  });

  it('validates an error response as a problem document', async () => {
    await boot({ enabled: true, mode: 'throw' });
    const res = await req().get('contract/missing');
    expect(res.status).to.eq(404);
    expect(res.type).to.eq('application/problem+json');
    expect(validator.problems).to.have.length(1);
    expect(violations.count).to.eq(0);
  });

  it('validates the error response of a route that no controller answers', async () => {
    await boot({ enabled: true, mode: 'throw' });
    expect((await req().get('contract/nowhere')).status).to.eq(404);
    expect(validator.problems).to.have.length(1);
  });

  it('checks the error reply of a violation once, as a problem document', async () => {
    await boot({ enabled: true, mode: 'throw' });
    expect((await req().get('contract/bad')).status).to.eq(500);
    expect(validator.responses).to.deep.eq([{ handler: 'bad', status: 200 }]);
    expect(validator.problems).to.have.length(1);
    expect(violations.count).to.eq(1);
  });

  it('checks an error-map reply of a route only as a problem document, never against the route schema', async () => {
    await boot({ enabled: true, mode: 'throw' });
    expect((await req().get('contract/missing')).status).to.eq(404);
    expect(validator.responses).to.deep.eq([]);
  });

  it('checks an @OnError answer against the route schema', async () => {
    await boot({ enabled: true, mode: 'throw' });
    expect((await req().get('contract/handled')).status).to.eq(500);
    expect(violations.list[0]).to.deep.include({ controller: 'ContractController', handler: 'handled', kind: 'response', status: 200 });
  });

  it('checks a route onBefore answer against the route schema', async () => {
    await boot({ enabled: true, mode: 'throw' });
    expect((await req().get('contract/answered')).status).to.eq(500);
    expect(violations.list[0]).to.deep.include({ controller: 'ContractController', handler: 'answered', kind: 'response', status: 200 });
  });

  it('checks the answer an onAround sends itself with sendReply against the route schema', async () => {
    await boot({ enabled: true, mode: 'log' });
    const res = await req().get('contract/around');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq(NO_ID);
    expect(violations.list).to.have.length(1);
    expect(violations.list[0]).to.deep.include({ controller: 'ContractController', handler: 'around', kind: 'response' });
  });

  it('checks a server onBefore answer as a problem document', async () => {
    await boot({ enabled: true, mode: 'throw' });
    const res = await req().get('contract/server-answer');
    expect(res.status).to.eq(403);
    expect(validator.problems).to.have.length(1);
    expect(violations.list).to.have.length(1);
    expect(violations.list[0]).to.deep.include({ controller: '', handler: '', kind: 'problem', status: 403 });
  });

  it('checks a replay whose body an onAfter changed against the route schema', async () => {
    await boot({ enabled: true, mode: 'log' });
    const first = await req().post('contract/replayed').set('Idempotency-Key', 'contract-replay').send({});
    expect(first.status).to.eq(200);
    expect(violations.count).to.eq(0);

    const replay = await req().post('contract/replayed').set('Idempotency-Key', 'contract-replay').send({});
    expect(replay.body).to.deep.eq(NO_ID);
    expect(violations.list).to.have.length(1);
    expect(violations.list[0]).to.deep.include({ controller: 'ContractController', handler: 'replayed', kind: 'response' });
  });
});

describe('response contract guard per container', () => {
  const fakeRes = (statusCode = 200) => {
    const sent: unknown[] = [];
    const res = { statusCode, json: (body: unknown) => (sent.push(body), res) } as unknown as Express.Response;
    return { res, sent };
  };

  const apps: TestApp[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.dispose()));
  });

  const containerWith = async (settings: Record<string, unknown>, withValidator = true) => {
    const violations = new Violations();
    const app = await createTestApp({
      scope: 'child',
      bootstrap: false,
      config: { http: { contractTesting: settings } },
      register: (c) => {
        if (withValidator) {
          c.register(new StubValidator()).asValue(CONTRACT_VALIDATOR.key);
          c.register(violations).asValue(CONTRACT_VIOLATIONS.key);
        }
      },
    });
    apps.push(app);
    return { container: app.container, violations };
  };

  it('resolves validator, log and settings from the given container, not from root', async () => {
    const { container, violations } = await containerWith({ enabled: true, mode: 'throw' });
    const { res } = fakeRes();
    guardResponseContract(res, container, { controller: 'C', handler: 'bad' });
    expect(() => res.json({ name: 'no id' })).to.throw(ResponseContractViolation);
    expect(violations.count).to.eq(1);
  });

  it('checks nothing when only root has the validator and the given container does not', async () => {
    const { container } = await containerWith({ enabled: true, mode: 'throw' }, false);
    const { res, sent } = fakeRes();
    guardResponseContract(res, container, { controller: 'C', handler: 'bad' });
    res.json({ name: 'no id' });
    expect(sent).to.have.length(1);
  });

  it('records a body that cannot be serialized instead of crashing the guard', async () => {
    const { container, violations } = await containerWith({ enabled: true, mode: 'log' });
    const { res, sent } = fakeRes();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    guardResponseContract(res, container, { controller: 'C', handler: 'bad' });
    res.json(circular);
    expect(violations.count).to.eq(1);
    expect(JSON.stringify(violations.list[0].errors)).to.match(/serialized/);
    expect(sent).to.have.length(1);
  });

  it('passes the status to the validator so non-2xx bodies can be checked', async () => {
    const { container, violations } = await containerWith({ enabled: true, mode: 'log' });
    const { res } = fakeRes(409);
    guardResponseContract(res, container, { controller: 'C', handler: 'bad' });
    res.json({ name: 'no id' });
    expect(violations.list[0]).to.deep.include({ status: 409, kind: 'response' });
  });
});
