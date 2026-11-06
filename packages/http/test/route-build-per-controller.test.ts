import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';

import { BaseController, BasePath, Get, Post, Ok } from '../src/index.js';

const noopLog = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, security: () => {}, success: () => {} };

@BasePath({ config: 'x.base', default: 'many' })
class ManyRoutesController extends BaseController {
  @Get()
  public async a() {
    return new Ok('a');
  }

  @Get('b/:id')
  public async b() {
    return new Ok('b');
  }

  @Post()
  public async c() {
    return new Ok('c');
  }
}

interface Layer {
  handle: unknown;
  route: { path: string; stack: Layer[] };
}

async function resolved(values: Record<string, unknown> = {}) {
  const reads: string[] = [];
  const controller = new ManyRoutesController();
  const cfg = {
    get: (path: string, fallback?: unknown) => {
      reads.push(path);
      return path in values ? values[path] : fallback;
    },
  };
  for (const [name, value] of Object.entries({ _cfg: cfg, _log: noopLog, _container: DI, _actionLocalStorage: new AsyncLocalStorage() })) {
    Object.defineProperty(controller, name, { value });
  }
  await controller.resolve();
  const layers = (controller.Router as unknown as { stack: Layer[] }).stack;
  return { reads, layers };
}

describe('route building of one controller', () => {
  it('mounts every route', async () => {
    const { layers } = await resolved({ 'http.controllers.route.prefix': 'api', 'x.base': 'admin' });
    expect(layers.map((l) => l.route.path)).to.deep.eq(['/api/admin/a', '/api/admin/b/:id', '/api/admin/c']);
  });

  it('reads the mount path and the route prefix once, not once per route', async () => {
    const { reads } = await resolved({ 'x.base': 'admin' });
    expect(reads.filter((path) => path === 'x.base')).to.have.length(1);
    expect(reads.filter((path) => path === 'http.controllers.route.prefix')).to.have.length(1);
  });

  it('builds one error handler for all its routes', async () => {
    const { layers } = await resolved();
    const errorHandlers = new Set(layers.map((l) => l.route.stack.at(-1)!.handle));
    expect(errorHandlers.size).to.eq(1);
  });
});
