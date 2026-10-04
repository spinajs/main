import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import '@spinajs/templates-pug';
import { dir, TestConfiguration } from './common.js';
import { FileSystem } from '../src/decorators.js';
import {
  fs,
  FsBootsrapper,
  FsDecorator,
  fsService,
  getFs,
  IProviderConfiguration,
  URI,
} from '../src/index.js';

type Decorated = fs & { decoratedBy?: number[] };

const calls: { order: number; name: string }[] = [];
const received = new Map<string, fs>();

function wrap(instance: fs, order: number): fs {
  const wrapper = Object.create(instance) as Decorated;
  wrapper.decoratedBy = [...((instance as Decorated).decoratedBy ?? []), order];
  return wrapper;
}

class LateDecorator extends FsDecorator {
  readonly order = 200;
  decorate(instance: fs, config: IProviderConfiguration): fs {
    calls.push({ order: this.order, name: config.name });
    return wrap(instance, this.order);
  }
}

class EarlyDecorator extends FsDecorator {
  readonly order = 10;
  decorate(instance: fs, config: IProviderConfiguration): fs {
    calls.push({ order: this.order, name: config.name });
    received.set(config.name, instance);
    return wrap(instance, this.order);
  }
}

const plain = () => ({ service: 'fsNative', name: 'dec-plain', basePath: dir('./temp-nc') });
const local = () => ({ service: 'fsNative', name: 'dec-local', basePath: dir('./temp-nc') });
const tempBackend = () => ({ service: 'fsNative', name: 'dec-temp-local', basePath: dir('./temp-nc') });

// fsTemp listed before its backend, as in common.ts
const decoratedProviders = () => [
  local(),
  { service: 'fsTemp', name: 'dec-temp', provider: 'dec-temp-local', cleanup: false, maxFileAge: 5 },
  tempBackend(),
];

const OWN_NAMES = ['dec-plain', 'dec-local', 'dec-temp', 'dec-temp-local'];

// A plain class instance, not a wrapper created over one. The class itself is not
// compared: the registry may hold the built package's class instead of src's.
function isRaw(instance: fs) {
  return Object.getPrototypeOf(instance) === instance.constructor.prototype;
}

/**
 * fsService with its providers injected directly, so the shared test configuration
 * and the providers other suites use stay untouched
 */
function service(providers: Partial<IProviderConfiguration>[]) {
  const svc = new fsService();
  Object.defineProperty(svc, 'Config', {
    value: { defaultProvider: 'test', providers },
    configurable: true,
  });
  return svc;
}

describe('fs decorators', function () {
  this.timeout(15000);

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  after(async () => {
    const map = DI.get<Map<string, fs>>('__file_provider_instance__')!;
    await (map.get('dec-temp') as fs | undefined)?.dispose();
    OWN_NAMES.forEach((n) => map.delete(n));
  });

  describe('without a decorator', () => {
    it('getFs returns the raw provider', async () => {
      await service([plain()]).resolve();

      const f = getFs('dec-plain') as Decorated;

      expect(f.Name).to.equal('dec-plain');
      expect(isRaw(f)).to.be.true;
      expect(f.decoratedBy).to.be.undefined;
    });
  });

  describe('with decorators', () => {
    before(async () => {
      // registered out of order on purpose
      DI.register(LateDecorator).as(FsDecorator);
      DI.register(EarlyDecorator).as(FsDecorator);

      await service(decoratedProviders()).resolve();
    });

    after(() => {
      DI.unregister(LateDecorator);
      DI.unregister(EarlyDecorator);
      DI.uncache(Array.ofType(FsDecorator));
      DI.uncache(LateDecorator);
      DI.uncache(EarlyDecorator);
    });

    it('applies every decorator to every provider in ascending order', () => {
      for (const name of ['dec-local', 'dec-temp', 'dec-temp-local']) {
        expect((getFs(name) as Decorated).decoratedBy, name).to.deep.equal([10, 200]);
        expect(
          calls.filter((c) => c.name === name).map((c) => c.order),
          name,
        ).to.deep.equal([10, 200]);
      }
    });

    it('passes the raw provider and its config to the first decorator', () => {
      const raw = received.get('dec-local')!;
      const decorated = getFs('dec-local');

      expect(raw.Name).to.equal('dec-local');
      expect(isRaw(raw)).to.be.true;
      expect(Object.getPrototypeOf(Object.getPrototypeOf(decorated))).to.equal(raw);
    });

    it('returns the decorated instance from getFs, URI and @FileSystem', () => {
      class DecoratedFsHolder {
        @FileSystem('dec-local')
        public Local: fs;
      }

      const decorated = getFs('dec-local');
      const holder = new DecoratedFsHolder();

      expect((decorated as Decorated).decoratedBy).to.deep.equal([10, 200]);
      expect(DI.resolve<fs>('__file_provider__', ['dec-local'])).to.equal(decorated);
      expect(new URI('fs://dec-local/a.txt').Fs).to.equal(decorated);
      expect(holder.Local).to.equal(decorated);
    });

    it('wires fsTemp to the raw backend, not the decorated one', () => {
      const temp = received.get('dec-temp') as unknown as { Provider: fs };

      expect(temp.constructor.name).to.equal('fsTemp');
      expect(isRaw(temp.Provider)).to.be.true;
      expect(temp.Provider).to.equal(received.get('dec-temp-local'));
      expect(temp.Provider).to.not.equal(getFs('dec-temp-local'));
    });
  });
});
