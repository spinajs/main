import 'mocha';
import { expect } from 'chai';
import type { ControllerEntry } from '@spinajs/manifest';
import { createContext, createProgramFromTsconfig, extractControllerBases, extractControllers, FACTORY_MIDDLEWARES, globalRouteMiddlewaresOf } from '../../src/index.js';

describe('middlewares mounted by factory decorators', () => {
  const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
  const file = unit.sourceFiles.find((f) => f.fileName.endsWith('factory-middlewares.ts'))!;
  const [controller] = extractControllers(ctx, file);
  const middlewares = (handler: string): ControllerEntry['middlewares'] => controller.routes.find((r) => r.handler === handler)!.middlewares;

  it('records the middleware class a framework decorator mounts, with the arguments it forwards, in declaration order', () => {
    expect(controller.middlewares).to.deep.equal([{ type: 'BotCheckMiddleware', options: ['signup'] }]);
    expect(middlewares('accepts')).to.deep.equal([
      { type: 'Audit', options: [1] },
      { type: 'AcceptsMiddleware', options: [1] },
    ]);
    expect(middlewares('idempotent')).to.deep.equal([{ type: 'IdempotencyMiddleware', options: [{ ttl: '1h' }] }]);
    expect(middlewares('unscoped')).to.deep.equal([{ type: 'UnscopedMiddleware', options: ['reports span every tenant'] }]);
  });

  it('follows an import alias to the decorator it names', () => {
    expect(middlewares('aliased')).to.deep.equal([{ type: 'AcceptsMiddleware', options: [2] }]);
  });

  it('ignores a same-named decorator that is not the framework one', () => {
    expect(middlewares('lookalike')).to.deep.equal([]);
  });

  it('keeps an abstract controller that has only a factory decorator as a base', () => {
    expect(extractControllerBases(ctx, file).map((c) => [c.className, c.middlewares])).to.deep.equal([['GuardedBase', [{ type: 'BotCheckMiddleware', options: ['signup'] }]]]);
  });

  it('maps the catalog decorators to their middleware classes and owning packages', () => {
    expect(Object.fromEntries(Object.entries(FACTORY_MIDDLEWARES).map(([name, m]) => [name, `${m.package}:${m.type}`]))).to.deep.equal({
      Accepts: '@spinajs/http:AcceptsMiddleware',
      BotCheck: '@spinajs/http:BotCheckMiddleware',
      Idempotent: '@spinajs/http:IdempotencyMiddleware',
      Deprecated: '@spinajs/http:DeprecationMiddleware',
      Consumes: '@spinajs/http:ConsumesMiddleware',
      NoCompression: '@spinajs/http:NoCompressionMiddleware',
      RateLimit: '@spinajs/http:RateLimitMiddleware',
      Deadline: '@spinajs/http:DeadlineMiddleware',
      SlowThreshold: '@spinajs/http:SlowThresholdMiddleware',
      Unscoped: '@spinajs/authz-http:UnscopedMiddleware',
      IpThrottle: '@spinajs/authn-http:AuthnIpThrottleMiddleware',
    });
    expect(FACTORY_MIDDLEWARES.IpThrottle.args).to.deep.equal([0, 2]);
  });
});

describe('globalRouteMiddlewaresOf', () => {
  it('names each http.routes.middlewares entry by its type, in config order, with its options', () => {
    class RouteTiming {}
    expect(globalRouteMiddlewaresOf(['Audit', { service: 'CacheControl', options: [60] }, RouteTiming, { service: RouteTiming }])).to.deep.equal([
      { type: 'Audit' },
      { type: 'CacheControl', options: [60] },
      { type: 'RouteTiming' },
      { type: 'RouteTiming' },
    ]);
  });

  it('leaves out what the runtime refuses, and anything that is not a list', () => {
    expect(globalRouteMiddlewaresOf([7, null, { options: [] }, { service: 'X', options: 'bad' }, () => undefined])).to.deep.equal([]);
    expect(globalRouteMiddlewaresOf({ controllers: ['lib'] })).to.deep.equal([]);
    expect(globalRouteMiddlewaresOf(undefined)).to.deep.equal([]);
  });
});
