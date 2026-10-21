import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';

import { BaseController, BasePath, Get, Ok, RouteRegistrationException, CONTROLLED_DESCRIPTOR_SYMBOL } from '../src/index.js';
import type { IControllerDescriptor } from '../src/index.js';

const noopLog = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, security: () => {}, success: () => {} };

@BasePath({ config: 'x.base', default: 'a/b' })
class ConfiguredController extends BaseController {
  @Get()
  public async ping() {
    return new Ok('ping');
  }
}

@BasePath('own')
class PlainOverrideController extends ConfiguredController {}

@BasePath({ config: 'y.base', default: 'c' })
class OtherKeyController extends ConfiguredController {}

class InheritingController extends ConfiguredController {}

class UndecoratedController extends BaseController {
  @Get()
  public async ping() {
    return new Ok('ping');
  }
}

function build<T extends BaseController>(type: new () => T, values: Record<string, unknown> = {}): T {
  const controller = new type();
  const cfg = { get: (path: string, fallback?: unknown) => (path in values ? values[path] : fallback) };
  for (const [name, value] of Object.entries({ _cfg: cfg, _log: noopLog, _container: DI, _actionLocalStorage: new AsyncLocalStorage() })) {
    Object.defineProperty(controller, name, { value });
  }
  return controller;
}

async function mounted(type: new () => BaseController, values: Record<string, unknown> = {}): Promise<string[]> {
  const controller = build(type, values);
  await controller.resolve();
  return (controller.Router as unknown as { stack: { route: { path: string } }[] }).stack.map((l) => l.route.path);
}

describe('@BasePath with a config key', () => {
  it('serves the default path while the key is unset', async () => {
    expect(await mounted(ConfiguredController)).to.deep.eq(['/a/b/ping']);
  });

  it('serves the configured path once the key is set', async () => {
    expect(await mounted(ConfiguredController, { 'x.base': 'admin/b' })).to.deep.eq(['/admin/b/ping']);
  });

  it('applies the global route prefix first', async () => {
    expect(await mounted(ConfiguredController, { 'http.controllers.route.prefix': 'api' })).to.deep.eq(['/api/a/b/ping']);
    expect(await mounted(ConfiguredController, { 'http.controllers.route.prefix': 'api', 'x.base': 'admin/b' })).to.deep.eq(['/api/admin/b/ping']);
  });

  it('exposes the resolved path as BasePath and keeps the default in the descriptor', () => {
    const controller = build(ConfiguredController, { 'x.base': 'admin/b' });
    expect(controller.BasePath).to.eq('admin/b');
    expect((Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller) as IControllerDescriptor).BasePath).to.eq('a/b');
  });

  it('ignores surrounding slashes of the configured value', async () => {
    expect(await mounted(ConfiguredController, { 'x.base': '/admin/b/' })).to.deep.eq(['/admin/b/ping']);
  });

  it('refuses a configured value that is not a non-empty string', () => {
    for (const bad of ['', '  ', 42, {}]) {
      expect(() => build(ConfiguredController, { 'x.base': bad }).BasePath, JSON.stringify(bad)).to.throw(RouteRegistrationException, 'x.base');
    }
  });

  it('leaves a plain string @BasePath static', async () => {
    expect(await mounted(PlainOverrideController, { 'x.base': 'admin/b' })).to.deep.eq(['/own/ping']);
  });

  it('lets a subclass bind another key', async () => {
    expect(await mounted(OtherKeyController, { 'x.base': 'admin/b' })).to.deep.eq(['/c/ping']);
    expect(await mounted(OtherKeyController, { 'y.base': 'moved' })).to.deep.eq(['/moved/ping']);
  });

  it('inherits the key without redeclaring it', async () => {
    expect(await mounted(InheritingController, { 'x.base': 'admin/b' })).to.deep.eq(['/admin/b/ping']);
  });

  it('keeps the class name fallback for an undecorated controller', async () => {
    expect(await mounted(UndecoratedController)).to.deep.eq(['/undecoratedcontroller/ping']);
  });
});
