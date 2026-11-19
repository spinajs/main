import 'mocha';
import { expect } from 'chai';
import { ClassInfo } from '@spinajs/di';
import { DefaultControllerCache } from '../src/cache.js';
import type { BaseController } from '../src/base-controller.js';

const noopLog = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const FILE = new URL('./support/two-controllers.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

/** `caseInsensitive` folds names the way the default Windows and macOS file systems do. */
function makeCache(caseInsensitive = false) {
  const entries = new Map<string, string>();
  const at = (key: string) => (caseInsensitive ? key.toLowerCase() : key);
  const cache = new DefaultControllerCache();
  Object.defineProperty(cache, 'Log', { value: noopLog });
  Object.defineProperty(cache, 'Hasher', { value: { hash: async () => 'deadbeef' } });
  Object.defineProperty(cache, 'CacheFS', {
    value: {
      exists: async (key: string) => entries.has(at(key)),
      write: async (key: string, data: string) => void entries.set(at(key), data),
      read: async (key: string) => Buffer.from(entries.get(at(key)) ?? '{}'),
      dirExists: async () => true,
      list: async () => [...entries.keys()],
      rm: async (key: string) => void entries.delete(at(key)),
    },
  });
  return { cache, entries };
}

function controller(name: string): ClassInfo<BaseController> {
  return Object.assign(new ClassInfo<BaseController>(), { name, file: FILE });
}

describe('DefaultControllerCache with two controllers in one file', function () {
  this.timeout(10000);

  it('binds each controller to its own parameter names', async () => {
    const { cache } = makeCache();

    const probe = await cache.getCache(controller('ProbeController'));
    const other = await cache.getCache(controller('OtherController'));

    expect(probe).to.deep.equal({ read: ['probeId'] });
    expect(other).to.deep.equal({ read: ['otherName'] });
  });

  it('documents each controller with its own JSDoc', async () => {
    const { cache } = makeCache();

    const probe = await cache.getDocumentation(controller('ProbeController'));
    const other = await cache.getDocumentation(controller('OtherController'));

    expect(probe.className).to.equal('ProbeController');
    expect(probe.classDescription).to.equal('Probes the device.');
    expect(probe.methods.read.summary).to.equal('Reads one probe');
    expect(probe.methods.read.params).to.have.keys('probeId');

    expect(other.className).to.equal('OtherController');
    expect(other.classDescription).to.equal('Something else entirely.');
    expect(other.methods.read.summary).to.equal('Reads one other thing');
    expect(other.methods.read.params).to.have.keys('otherName');
  });

  it('stores one parameter and one documentation entry per class', async () => {
    const { cache, entries } = makeCache();

    await cache.getCache(controller('ProbeController'));
    await cache.getCache(controller('OtherController'));

    expect(entries.size).to.equal(4);
  });

  it('keeps classes whose names differ only in case apart on a case-insensitive file system', async () => {
    const { cache, entries } = makeCache(true);

    const probe = await cache.getCache(controller('ProbeController'));
    const shouting = await cache.getCache(controller('PROBECONTROLLER'));

    expect(probe).to.deep.equal({ read: ['probeId'] });
    expect(shouting).to.deep.equal({});
    expect(entries.size).to.equal(4);
  });

  it('writes a name that is not an identifier as a plain entry that clear() removes', async () => {
    const { cache, entries } = makeCache();

    for (const name of ['a-b', '../escape/Probe', '', 'X'.repeat(300)]) {
      await cache.getCache(controller(name));
    }

    expect(entries.size).to.equal(8);
    for (const key of entries.keys()) {
      expect(key).to.not.match(/[\\/]/);
      expect(key.length).to.be.lessThan(100);
    }

    await cache.clear();
    expect([...entries.keys()]).to.be.empty;
  });
});
