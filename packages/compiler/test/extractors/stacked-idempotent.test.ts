import 'mocha';
import { expect } from 'chai';
import type { ControllerEntry } from '@spinajs/manifest';
import { createContext, createProgramFromTsconfig, declarationOf, extractControllers, routeOverridesOf } from '../../src/index.js';

describe('stacked @Idempotent', () => {
  const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
  const controllers = extractControllers(ctx, unit.sourceFiles.find((f) => f.fileName.endsWith('stacked-idempotent.ts'))!);
  const entry = (className: string): ControllerEntry => controllers.find((c) => c.className === className)!;
  const middlewares = (className: string, handler: string): ControllerEntry['middlewares'] => entry(className).routes.find((r) => r.handler === handler)!.middlewares;
  const hand = (ttl: string) => ({ type: 'IdempotencyMiddleware', options: [{ ttl }] });
  const idempotent = (ttl: string) => ({ type: 'IdempotencyMiddleware', decoratorArgs: [{ ttl }] });

  // The runtime mounts [IdempotencyMiddleware (ttl 2h), Second, First] (http/test/idempotent-decorator.test.ts);
  // the manifest lists a method's middlewares in source order, the reverse.
  it('records one gate, with the arguments of the top decorator, at the place of the bottom one', () => {
    expect(middlewares('StackedIdemController', 'mixed')).to.deep.equal([
      { type: 'First', options: [] },
      { type: 'Second', options: [] },
      { type: 'IdempotencyMiddleware', decoratorArgs: [{ ttl: '2h' }] },
    ]);
  });

  // `@Middleware(IdempotencyMiddleware, ...)` pushes a gate of its own; only `@Idempotent` replaces one.
  it('keeps a hand-mounted gate above @Idempotent apart from it', () => {
    expect(middlewares('StackedIdemController', 'handAbove')).to.deep.equal([hand('5m'), { type: 'First', options: [] }, idempotent('1h')]);
  });

  it('keeps every hand-mounted gate of a method or a class', () => {
    expect(middlewares('StackedIdemController', 'twoHand')).to.deep.equal([hand('5m'), hand('10m')]);
    expect(entry('HandGatedController').middlewares).to.deep.equal([hand('5m'), hand('10m')]);
  });

  it('keeps a hand-mounted gate above the own @Idempotent of a redeclared route', () => {
    const sub = entry('IdemSubController');
    const [override] = routeOverridesOf(declarationOf(sub)!, entry('IdemBaseController'), 'idem-sub', ctx);
    expect(override.middlewares).to.deep.equal([hand('5m'), idempotent('1h')]);
  });
});
