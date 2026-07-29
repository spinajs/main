import 'mocha';
import { expect } from 'chai';
import { ClassInfo } from '@spinajs/di';
import { DefaultControllerCache } from '../src/cache.js';
import type { BaseController } from '../src/base-controller.js';

const noopLog = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  security: () => {},
  success: () => {},
};

interface IFakeFsCall {
  op: string;
  args: unknown[];
}

function makeCache(existing: boolean) {
  const calls: IFakeFsCall[] = [];
  const cache = new DefaultControllerCache();

  Object.defineProperty(cache, 'Log', { value: noopLog });
  Object.defineProperty(cache, 'Hasher', { value: { hash: async () => 'deadbeef' } });
  Object.defineProperty(cache, 'CacheFS', {
    value: {
      exists: async (...args: unknown[]) => {
        calls.push({ op: 'exists', args });
        return existing;
      },
      write: async (...args: unknown[]) => {
        calls.push({ op: 'write', args });
      },
      read: async () => Buffer.from('{}'),
      resolvePath: () => '',
    },
  });

  return { cache, calls };
}

function controllerInfo(): ClassInfo<BaseController> {
  // Real on-disk source so extractAll has something to parse; class name does
  // not need to match — extraction then yields empty maps, which is fine for
  // exercising the write logic.
  return Object.assign(new ClassInfo<BaseController>(), {
    name: 'SomeController',
    file: new URL('./cache-rebuild.test.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
  });
}

describe('DefaultControllerCache rebuild option', () => {
  it('does not regenerate when cache exists and rebuild not requested', async () => {
    const { cache, calls } = makeCache(true);
    await cache.getCache(controllerInfo());

    expect(calls.filter((c) => c.op === 'write')).to.have.lengthOf(0);
  });

  it('regenerates and overwrites when rebuild requested even if cache exists', async () => {
    const { cache, calls } = makeCache(true);
    await cache.getCache(controllerInfo(), { rebuild: true });

    // Both the parameter cache and the doc cache entries must be rewritten.
    const writes = calls.filter((c) => c.op === 'write');
    expect(writes).to.have.lengthOf(2);
    expect(writes.map((w) => w.args[0])).to.include.members(['deadbeef', 'doc_deadbeef']);
  });

  it('generates when cache missing regardless of rebuild flag', async () => {
    const { cache, calls } = makeCache(false);
    await cache.getCache(controllerInfo());

    expect(calls.filter((c) => c.op === 'write')).to.have.lengthOf(2);
  });
});
