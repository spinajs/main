import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, CONTROLLED_DESCRIPTOR_SYMBOL, Idempotent, Ok, Post, parseIdempotencyKey } from '../src/index.js';
import type { IControllerDescriptor } from '../src/interfaces.js';
import { IdempotencyMiddleware } from '../src/idempotency/middleware.js';
import { resolveIdempotentOptions } from '../src/idempotency/options.js';
import type { IRouteInvocation, IRouteOutcome } from '../src/interfaces.js';

class IdemOrdersController extends BaseController {
  @Post()
  @Idempotent()
  public create() {
    return new Ok();
  }

  @Post()
  @Idempotent({ required: true, ttl: '1h', fingerprint: 'none', maxReplyBytes: 10 })
  public pay() {
    return new Ok();
  }

  @Post()
  public plain() {
    return new Ok();
  }
}

class IdemStackedController extends BaseController {
  // decorators apply bottom-up: the top one is applied last and wins
  @Post()
  @Idempotent({ ttl: '2h' })
  @Idempotent({ ttl: '1h' })
  public stacked() {
    return new Ok();
  }
}

class IdemParentController extends BaseController {
  @Post()
  @Idempotent()
  public create() {
    return new Ok();
  }
}

class IdemChildController extends IdemParentController {
  @Post()
  @Idempotent({ ttl: '1h' })
  public create() {
    return new Ok();
  }
}

const routeIn = (type: typeof BaseController, name: string) => (Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, type.prototype) as IControllerDescriptor).Routes.get(name)!;
const routeOf = (name: string) => routeIn(IdemOrdersController, name);
const gates = (route: ReturnType<typeof routeOf>) => route.Middlewares.filter((m) => m.Type === IdempotencyMiddleware);

describe('@Idempotent', () => {
  it('records the defaults on the route', () => {
    expect(routeOf('create').Idempotency).to.deep.equal({ required: false, ttl: '24h', fingerprint: 'body', maxReplyBytes: 1_048_576 });
  });

  it('records the given options over the defaults', () => {
    expect(routeOf('pay').Idempotency).to.deep.equal({ required: true, ttl: '1h', fingerprint: 'none', maxReplyBytes: 10 });
  });

  it('leaves a route without it unmarked', () => {
    expect(routeOf('plain').Idempotency).to.equal(undefined);
  });

  it('refuses options it cannot honour when the class is declared', () => {
    for (const options of [{ maxReplyBytes: 0 }, { maxReplyBytes: 1.5 }, { ttl: '' }, { fingerprint: 'url' }, { required: 'yes' }, { ttl: '1h', retries: 3 }, null, 'body', ['body']]) {
      expect(() => Idempotent(options as never), JSON.stringify(options)).to.throw(InvalidArgument);
    }
  });

  it('keeps one gate when stacked, with the options of the decorator applied last', () => {
    const route = routeIn(IdemStackedController, 'stacked');

    expect(gates(route)).to.have.length(1);
    expect(gates(route)[0].Options).to.deep.equal([route.Idempotency]);
    expect(route.Idempotency!.ttl).to.equal('2h');
  });

  it('replaces an inherited gate when the subclass re-decorates the route', () => {
    const route = routeIn(IdemChildController, 'create');

    expect(gates(route)).to.have.length(1);
    expect((gates(route)[0].Options[0] as { ttl: string }).ttl).to.equal('1h');
    expect(route.Idempotency!.ttl).to.equal('1h');
    expect(gates(routeIn(IdemParentController, 'create'))).to.have.length(1);
    expect(routeIn(IdemParentController, 'create').Idempotency!.ttl).to.equal('24h');
  });

  it('refuses a controller class', () => {
    class IdemWholeController extends BaseController {}

    expect(() => (Idempotent() as unknown as ClassDecorator)(IdemWholeController)).to.throw(InvalidArgument, 'route method');
  });
});

describe('parseIdempotencyKey', () => {
  it('takes 1 to 255 visible ASCII characters', () => {
    for (const key of ['a', 'k-1_2.3~!', 'x'.repeat(255), '550e8400-e29b-41d4-a716-446655440000']) {
      expect(parseIdempotencyKey(key)).to.equal(key);
    }
  });

  it('refuses a missing, empty, long, spaced, non-ASCII or repeated header', () => {
    // 'a, b': Node joins a repeated header with ', ', so a string[] never reaches the gate
    for (const header of [undefined, '', 'x'.repeat(256), 'a b', 'tab\t', 'zażółć', 'a, b', 'a,b', 'a;p=1']) {
      expect(parseIdempotencyKey(header), JSON.stringify(header)).to.equal(undefined);
    }
  });

  it('takes the quoted string form, which gives the same key as the bare one', () => {
    const cases: Array<[string, string]> = [
      ['"k-1"', 'k-1'],
      ['"a b"', 'a b'],
      ['"say \\"hi\\" \\\\ bye"', 'say "hi" \\ bye'],
      [`"${'x'.repeat(255)}"`, 'x'.repeat(255)],
    ];
    for (const [header, key] of cases) {
      expect(parseIdempotencyKey(header), header).to.equal(key);
    }
    expect(parseIdempotencyKey('"k-1"')).to.equal(parseIdempotencyKey('k-1'));
  });

  it('refuses a quoted key that is empty, too long, unterminated, badly escaped or has parameters', () => {
    for (const header of ['""', `"${'x'.repeat(256)}"`, '"abc', '"a\\nb"', '"a"b"', '"a";p=1', '"a"x', '"tab\t"', '"zażółć"']) {
      expect(parseIdempotencyKey(header), JSON.stringify(header)).to.equal(undefined);
    }
  });
});

describe('IdempotencyMiddleware', () => {
  class Refused extends Error {
    public retryAfterMs = 1000;
  }

  const build = (options?: Parameters<typeof resolveIdempotentOptions>[0]) => new IdempotencyMiddleware(resolveIdempotentOptions(options));
  const invocation = (headers: Record<string, string>, res: Record<string, unknown>) => ({ req: { headers }, res }) as unknown as IRouteInvocation;
  const neverProceed = (): Promise<IRouteOutcome> => Promise.reject(new Error('proceed must not be called'));

  it('refuses to be mounted by @Middleware() without options', async () => {
    const middleware = new IdempotencyMiddleware(undefined as never);

    let error: unknown;
    try {
      await middleware.onRegister({ Type: 'post' } as never, '/x');
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(InvalidArgument);
    expect((error as Error).message).to.include('mounted by @Idempotent()');
  });

  it('returns instead of throwing a key error when the client is already gone', async () => {
    const gone = { destroyed: true, closed: true };

    await build({ required: true }).onAround(invocation({}, gone), neverProceed);
    await build().onAround(invocation({ 'idempotency-key': 'a b' }, gone), neverProceed);
  });

  it('still throws a key error to a client that is there', async () => {
    const here = { destroyed: false, closed: false };

    for (const [middleware, headers] of [[build({ required: true }), {}], [build(), { 'idempotency-key': 'a b' }]] as const) {
      let error: unknown;
      try {
        await middleware.onAround(invocation(headers, here), neverProceed);
      } catch (err) {
        error = err;
      }
      expect(error, JSON.stringify(headers)).to.not.equal(undefined);
    }
  });

  it('returns instead of throwing a refused claim when the client went away during the claim', async () => {
    const claimWith = async (leaves: boolean) => {
      const res: Record<string, unknown> = { destroyed: false, closed: false, headersSent: false, setHeader: () => undefined };
      const middleware = build();
      (middleware as unknown as { gate: unknown }).gate = {
        namespace: 'http:POST /x',
        ttlMs: 1000,
        inFlight: Refused,
        keyReuse: class extends Error {},
        claimConflict: class extends Error {},
        outcomeUnknown: class extends Error {},
        fingerprint: () => 'fp',
        service: {
          run: () => {
            res.destroyed = leaves;
            return Promise.reject(new Refused('in flight'));
          },
        },
      };
      await middleware.onAround(invocation({ 'idempotency-key': 'k' }, res), neverProceed);
    };

    await claimWith(true);

    let error: unknown;
    try {
      await claimWith(false);
    } catch (err) {
      error = err;
    }
    expect((error as { status?: number }).status ?? (error as { StatusCode?: number }).StatusCode).to.equal(409);
  });
});
