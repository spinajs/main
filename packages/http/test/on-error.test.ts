import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { Forbidden, InvalidArgument } from '@spinajs/exceptions';
import { Schema, ValidationFailed } from '@spinajs/validation';

import { httpApp, req, TestConfiguration } from './common.js';
import {
  BaseController,
  BasePath,
  BasePolicy,
  Body,
  Controllers,
  ErrorHandlerService,
  HttpServer,
  Middleware,
  NotFound,
  Ok,
  OnError,
  Policy,
  Post,
  RouteMiddleware,
  Unauthorized,
} from '../src/index.js';
import type { ErrorContext, ErrorStage } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

@Schema({ type: 'object', required: ['login'], additionalProperties: false, properties: { login: { type: 'string', minLength: 1, maxLength: 8 } } })
class LoginInput {
  public login: string;

  constructor(data: object) {
    Object.assign(this, data);
  }
}

class AppWideError extends Error {}

const NO_STORE = { Name: 'Cache-Control', Value: 'no-store' };
const log: string[] = [];
let seen: Partial<Record<'stage' | 'method' | 'error', string>> & { container?: boolean } = {};

class DenyPolicy extends BasePolicy {
  isEnabled() {
    return true;
  }

  async execute(): Promise<void> {
    throw new Forbidden('nope');
  }
}

class FailingMiddleware extends RouteMiddleware {
  isEnabled() {
    return true;
  }

  async onBefore(): Promise<void> {
    throw new InvalidArgument('from middleware');
  }

  async onAfter() {}

  async onResponse() {}
}

class FailingAfterMiddleware extends RouteMiddleware {
  isEnabled() {
    return true;
  }

  async onBefore() {}

  async onAfter(): Promise<void> {
    throw new Forbidden('from onAfter');
  }

  async onResponse() {}
}

class AppWideHandler extends ErrorHandlerService {
  readonly on = AppWideError;
  readonly stages: readonly ErrorStage[] = ['action'];

  handle() {
    log.push('app-wide');
    return new Ok({ handled: 'config' });
  }
}

@BasePath('errors')
@OnError(InvalidArgument, () => new Ok({ handled: 'controller' }))
class OnErrorController extends BaseController {
  @Post()
  @OnError(
    [ValidationFailed, InvalidArgument],
    async (err, ctx: ErrorContext) => {
      seen = { stage: ctx.stage, method: String(ctx.route.Method), error: err.name, container: !!ctx.container };
      await new Promise((resolve) => setTimeout(resolve, 1));
      return new Unauthorized({ error: 'uniform' }, { Headers: [NO_STORE] });
    },
    { stages: ['arguments'] },
  )
  public login(@Body() input: LoginInput) {
    if (input.login === 'boom') throw new InvalidArgument('raised in the action');
    return new Ok({ input });
  }

  @Post()
  @OnError(Forbidden, async () => {
    log.push('first');
  })
  @OnError(Forbidden, () => {
    log.push('second');
  })
  public sideEffects() {
    throw new Forbidden('kept');
  }

  @Post()
  @OnError(InvalidArgument, () => new Forbidden('replaced'))
  @OnError(Forbidden, () => new Unauthorized({ error: 'from-replaced' }))
  public replaceThenMatch() {
    throw new InvalidArgument('original');
  }

  @Post()
  @OnError(ValidationFailed, () => new Ok({}))
  public notMatching() {
    throw new Forbidden('untouched');
  }

  @Post()
  @Middleware(FailingMiddleware)
  public middleware() {
    return new Ok({});
  }

  @Post()
  @Middleware(FailingAfterMiddleware)
  @OnError(Forbidden, (_err, ctx) => new Ok({ stage: ctx.stage }))
  public after() {
    return new Ok({});
  }

  @Post()
  @Policy(DenyPolicy)
  @OnError(Forbidden, () => new NotFound({ error: 'hidden' }), { stages: ['policy'] })
  public hidden() {
    return new Ok({});
  }

  @Post()
  @OnError(Error, () => {
    throw new Error('handler bug');
  })
  public brokenHandler() {
    throw new Forbidden('original');
  }

  @Post()
  public appWide() {
    throw new AppWideError('for the config handler');
  }
}

@BasePath('plain-errors')
class PlainController extends BaseController {
  @Post()
  public plain(@Body() input: LoginInput) {
    return new Ok({ input });
  }
}

class OnErrorConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    (this.Config as { http: Record<string, unknown> }).http.errors = { handlers: [{ service: 'AppWideHandler' }] };
  }
}

describe('OnError', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      configuration: OnErrorConfiguration,
      register: (c) => {
        c.register(AppWideHandler).as(ErrorHandlerService);
        c.register(OnErrorController).as(BaseController);
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
    log.length = 0;
    seen = {};
  });

  it('swallows invalid arguments with an async handler that answers a response', async () => {
    const res = await req().post('errors/login').send({ login: 'x'.repeat(9) });
    expect(res.status).to.eq(401);
    expect(res.body).to.deep.eq({ error: 'uniform' });
    expect((res.headers as Record<string, string>)['cache-control']).to.eq('no-store');
  });

  it('passes the error and the context to the handler', async () => {
    await req().post('errors/login').send({ login: 'a', extra: 1 });
    expect(seen).to.deep.eq({ stage: 'arguments', method: 'login', error: 'ValidationFailed', container: true });
  });

  it('skips a handler outside its stages; the controller handler answers', async () => {
    const res = await req().post('errors/login').send({ login: 'boom' });
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ handled: 'controller' });
  });

  it('runs every matching handler in declaration order and keeps the error when they return nothing', async () => {
    const res = await req().post('errors/sideEffects').send({});
    expect(log).to.deep.eq(['first', 'second']);
    expect(res.status).to.eq(403);
  });

  it('matches later handlers against a replaced error', async () => {
    const res = await req().post('errors/replaceThenMatch').send({});
    expect(res.status).to.eq(401);
    expect(res.body).to.deep.eq({ error: 'from-replaced' });
  });

  it('ignores errors that are not in on', async () => {
    const res = await req().post('errors/notMatching').send({});
    expect(res.status).to.eq(403);
  });

  it('catches a route middleware error', async () => {
    const res = await req().post('errors/middleware').send({});
    expect(res.body).to.deep.eq({ handled: 'controller' });
  });

  it('marks an onAfter error with the after stage', async () => {
    const res = await req().post('errors/after').send({});
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ stage: 'after' });
  });

  it('catches a policy refusal at the policy stage', async () => {
    const res = await req().post('errors/hidden').send({});
    expect(res.status).to.eq(404);
    expect(res.body).to.deep.eq({ error: 'hidden' });
  });

  it('keeps the original error when a handler throws', async () => {
    const res = await req().post('errors/brokenHandler').send({});
    expect(res.status).to.eq(403);
  });

  it('runs the app-wide handlers from http.errors.handlers after the controller ones', async () => {
    const res = await req().post('errors/appWide').send({});
    expect(log).to.deep.eq(['app-wide']);
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ handled: 'config' });
  });

  it('changes nothing for a route without OnError', async () => {
    const res = await req().post('plain-errors/plain').send({});
    expect(res.status).to.eq(400);
    expect((res.body as { detail: string }).detail).to.eq('validation error');
  });

  it('runs the action on valid input', async () => {
    const res = await req().post('errors/login').send({ login: 'a' });
    expect(res.status).to.eq(200);
  });
});
