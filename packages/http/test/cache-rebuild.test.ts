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
      list: async () => ['stale_entry', 'doc_stale_entry'],
      dirExists: async () => true,
      rm: async (...args: unknown[]) => {
        calls.push({ op: 'rm', args });
      },
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

describe('DefaultControllerCache keying', () => {
  it('does not regenerate when the entry already exists', async () => {
    const { cache, calls } = makeCache(true);
    await cache.getCache(controllerInfo());

    expect(calls.filter((c) => c.op === 'write')).to.have.lengthOf(0);
  });

  it('generates both entries when they are missing', async () => {
    const { cache, calls } = makeCache(false);
    await cache.getCache(controllerInfo());

    expect(calls.filter((c) => c.op === 'write')).to.have.lengthOf(2);
  });

  it('prefixes every key with the package version, so a new package build misses old entries', async () => {
    // The extractor's own code lives in this package, so its version is what says "the way we read
    // controllers may have changed". Without the prefix, adding `classTags` support left every
    // entry under its old key and the new extractor was handed the document written before it -
    // tags missing, nothing ever re-parsing.
    const { cache, calls } = makeCache(false);
    await cache.getCache(controllerInfo());

    const keys = calls.filter((c) => c.op === 'write').map((w) => w.args[0] as string);
    const paramKey = keys.find((k) => !k.startsWith('doc_'));

    // A real version, not the `unknown` fallback - the package must expose ./package.json for the
    // lookup to resolve, and the source half is carried untouched alongside it.
    expect(paramKey).to.match(/^\d+\.\d+\.\d+[^_]*_deadbeef$/);
    expect(keys).to.include(`doc_${paramKey}`);
  });

  it('clear() removes every entry in the cache directory', async () => {
    const { cache, calls } = makeCache(true);
    await cache.clear();

    const removed = calls.filter((c) => c.op === 'rm').map((c) => c.args[0]);
    expect(removed).to.deep.equal(['stale_entry', 'doc_stale_entry']);
  });
});
