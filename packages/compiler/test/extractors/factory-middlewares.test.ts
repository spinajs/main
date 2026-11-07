import 'mocha';
import { expect } from 'chai';
import { hashManifest, type ControllerEntry } from '@spinajs/manifest';
import { createContext, createProgramFromTsconfig, extractControllerBases, extractControllers, FACTORY_MIDDLEWARES, globalRouteMiddlewaresOf } from '../../src/index.js';
import { fixture } from '../doctor/fixture.js';

describe('middlewares mounted by factory decorators', () => {
  const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
  const file = unit.sourceFiles.find((f) => f.fileName.endsWith('factory-middlewares.ts'))!;
  const [controller] = extractControllers(ctx, file);
  const middlewares = (handler: string): ControllerEntry['middlewares'] => controller.routes.find((r) => r.handler === handler)!.middlewares;

  it('records the middleware class a framework decorator mounts, with the decorator arguments, in source order', () => {
    expect(controller.middlewares).to.deep.equal([{ type: 'BotCheckMiddleware', decoratorArgs: ['signup'] }]);
    expect(middlewares('accepts')).to.deep.equal([
      { type: 'Audit', options: [1] },
      { type: 'AcceptsMiddleware', decoratorArgs: [1] },
    ]);
    expect(middlewares('idempotent')).to.deep.equal([{ type: 'IdempotencyMiddleware', decoratorArgs: [{ ttl: '1h' }] }]);
    expect(middlewares('unscoped')).to.deep.equal([{ type: 'UnscopedMiddleware', decoratorArgs: ['reports span every tenant'] }]);
  });

  it('leaves out arguments that are not plain JSON literals', () => {
    expect(middlewares('computed')).to.deep.equal([{ type: 'Audit' }, { type: 'BotCheckMiddleware' }]);
  });

  it('follows an import alias to the decorator it names', () => {
    expect(middlewares('aliased')).to.deep.equal([{ type: 'AcceptsMiddleware', decoratorArgs: [2] }]);
  });

  it('ignores a same-named decorator that is not the framework one', () => {
    expect(middlewares('lookalike')).to.deep.equal([]);
  });

  it('keeps an abstract controller that has only a factory decorator as a base', () => {
    expect(extractControllerBases(ctx, file).map((c) => [c.className, c.middlewares])).to.deep.equal([['GuardedBase', [{ type: 'BotCheckMiddleware', decoratorArgs: ['signup'] }]]]);
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
  it('records each http.routes.middlewares entry by its type only, in config order, marking class entries', () => {
    class RouteTiming {}
    expect(globalRouteMiddlewaresOf(['Audit', { service: 'CacheControl', options: [60] }, RouteTiming, { service: RouteTiming, options: [] }])).to.deep.equal([
      { type: 'Audit' },
      { type: 'CacheControl' },
      { type: 'RouteTiming', fromClass: true },
      { type: 'RouteTiming', fromClass: true },
    ]);
  });

  it('never copies config options into the manifest: a self-referencing or secret-bearing value is not serialized', () => {
    const store: Record<string, unknown> = { url: 'redis://user:secret@cache' };
    store.self = store;
    const globalRouteMiddlewares = globalRouteMiddlewaresOf([{ service: 'Audit', options: [store] }]);
    expect(globalRouteMiddlewares).to.deep.equal([{ type: 'Audit' }]);
    expect(() => hashManifest(fixture({ globalRouteMiddlewares }))).to.not.throw();
  });

  it('leaves out what the runtime refuses, and anything that is not a list', () => {
    expect(globalRouteMiddlewaresOf([7, null, { options: [] }, { service: 'X', options: 'bad' }, () => undefined])).to.deep.equal([]);
    expect(globalRouteMiddlewaresOf({ controllers: ['lib'] })).to.deep.equal([]);
    expect(globalRouteMiddlewaresOf(undefined)).to.deep.equal([]);
  });
});
