import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI, Injectable, NewInstance, ResolveException } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';
import { fs, FsBootsrapper, fsService, fsTemp, IFsTempOptions, IProviderConfiguration, MaxAgeTempCleanupStrategy, TempCleanupStrategy } from '../src/index.js';
import { sleep } from '@spinajs/threading';

// custom sweep, interval scheduling inherited from MaxAgeTempCleanupStrategy
@Injectable(TempCleanupStrategy)
@NewInstance()
class TestCleanupStrategy extends MaxAgeTempCleanupStrategy {
  public static Calls: { fs: fs; options: IFsTempOptions }[] = [];

  public async cleanup(f: fs, options: IFsTempOptions): Promise<void> {
    TestCleanupStrategy.Calls.push({ fs: f, options });
  }
}

/**
 * fsService with config injected directly - lets us test provider creation
 * failure paths without touching globally registered test configuration
 */
function service(providers: Partial<IProviderConfiguration>[]) {
  const svc = new fsService();
  Object.defineProperty(svc, 'Config', {
    value: { defaultProvider: 'test', providers },
    configurable: true,
  });
  return svc;
}

async function tmp() {
  return await DI.resolve<fs>('__file_provider__', ['fs-temp']);
}

async function backend() {
  return await DI.resolve<fs>('__file_provider__', ['fs-temp-local']);
}

describe('fs temp generic ( any backend ) tests', function () {
  this.timeout(15000);

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);

    await DI.resolve(fsService);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should create temp fs and backend regardless of config order', async () => {
    // in test config fs-temp is deliberately listed BEFORE its backend fs-temp-local
    const t = await tmp();
    const b = await backend();

    expect(t).to.be.not.null;
    expect(b).to.be.not.null;
    expect(t instanceof fsTemp).to.be.true;
  });

  it('should report temp fs name, not backend name', async () => {
    const t = await tmp();

    expect(t.Name).to.eq('fs-temp');
    expect(t.ServiceName).to.eq('fs-temp');
  });

  it('should delegate file operations to backend fs', async () => {
    const t = await tmp();
    const b = await backend();

    await t.write('generic.txt', 'hello');

    expect(await b.exists('generic.txt')).to.be.true;
    expect(await t.read('generic.txt', 'utf-8')).to.eq('hello');
    expect(t.resolvePath('generic.txt')).to.eq(b.resolvePath('generic.txt'));

    await t.append('generic.txt', ' world');
    expect(await t.read('generic.txt', 'utf-8')).to.eq('hello world');

    const stat = await t.stat('generic.txt');
    expect(stat.IsFile).to.be.true;

    const files = await t.list('/');
    expect(files).to.include('generic.txt');

    await t.rm('generic.txt');
    expect(await b.exists('generic.txt')).to.be.false;
  });

  it('should zip with temp fs as default destination', async () => {
    const t = await tmp();

    await t.write('tozip.txt', 'zip me');
    const result = await t.zip('tozip.txt');

    expect(result.fs.Name).to.eq('fs-temp');

    result.unlink();
    await t.rm('tozip.txt');
  });

  it('should fail when backend fs is not registered in DI container', async () => {
    await expect(
      DI.resolve(fsTemp, [{ name: 'bad-temp', provider: 'not-registered', cleanup: false }]),
    ).to.be.rejectedWith(ResolveException);
  });

  it('should fail when backend fs is not set', async () => {
    await expect(DI.resolve(fsTemp, [{ name: 'bad-temp-2', cleanup: false }])).to.be.rejectedWith(ResolveException);
  });

  it('should fail when cleanup strategy is not registered', async () => {
    await expect(
      DI.resolve(fsTemp, [
        { name: 'bad-strategy', provider: 'fs-temp-local', cleanup: false, cleanupStrategy: 'NoSuchStrategy' },
      ]),
    ).to.be.rejectedWith(ResolveException);
  });

  it('should fail at service level when configured backend is missing', async () => {
    await expect(service([{ service: 'fsTemp', name: 't1', provider: 'ghost' }]).resolve()).to.be.rejectedWith(
      ResolveException,
    );
  });

  it('should fail at service level on self reference', async () => {
    await expect(service([{ service: 'fsTemp', name: 't1', provider: 't1' }]).resolve()).to.be.rejectedWith(
      ResolveException,
    );
  });

  it('should fail at service level on circular reference', async () => {
    await expect(
      service([
        { service: 'fsTemp', name: 't1', provider: 't2' },
        { service: 'fsTemp', name: 't2', provider: 't1' },
      ]).resolve(),
    ).to.be.rejectedWith(ResolveException);
  });

  it('should use custom cleanup strategy from configuration', async () => {
    const t = await DI.resolve<fsTemp>(fsTemp, [
      {
        name: 'fs-temp-custom',
        provider: 'fs-temp-local',
        cleanup: true,
        cleanupInterval: 50,
        maxFileAge: 1,
        cleanupStrategy: 'TestCleanupStrategy',
      },
    ]);

    try {
      await sleep(300);

      expect(TestCleanupStrategy.Calls.length).to.be.greaterThan(0);

      // strategy operates on BACKEND fs and receives temp fs options
      expect(TestCleanupStrategy.Calls[0].fs.Name).to.eq('fs-temp-local');
      expect(TestCleanupStrategy.Calls[0].options.name).to.eq('fs-temp-custom');
    } finally {
      await t.dispose();
    }
  });

  it('should stop cleanup scheduling on dispose', async () => {
    const t = await DI.resolve<fsTemp>(fsTemp, [
      {
        name: 'fs-temp-stop-on-dispose',
        provider: 'fs-temp-local',
        cleanup: true,
        cleanupInterval: 50,
        cleanupStrategy: 'TestCleanupStrategy',
      },
    ]);

    await sleep(300);
    await t.dispose();

    const countAfterDispose = TestCleanupStrategy.Calls.length;
    await sleep(300);

    expect(countAfterDispose).to.be.greaterThan(0);
    expect(TestCleanupStrategy.Calls.length).to.eq(countAfterDispose);
  });

  it('should not start cleanup scheduling when cleanup is disabled', async () => {
    const start = sinon.spy(MaxAgeTempCleanupStrategy.prototype, 'start');

    const t = await DI.resolve<fsTemp>(fsTemp, [
      { name: 'fs-temp-no-cleanup', provider: 'fs-temp-local', cleanup: false, cleanupInterval: 50 },
    ]);

    try {
      expect(start.called).to.be.false;
    } finally {
      await t.dispose();
    }
  });

  it('should give each temp fs its own cleanup strategy instance', async () => {
    const t1 = await DI.resolve<fsTemp>(fsTemp, [
      { name: 'fs-temp-own-strategy-1', provider: 'fs-temp-local', cleanup: false },
    ]);
    const t2 = await DI.resolve<fsTemp>(fsTemp, [
      { name: 'fs-temp-own-strategy-2', provider: 'fs-temp-local', cleanup: false },
    ]);

    try {
      const s1 = (t1 as any).CleanupStrategy as TempCleanupStrategy;
      const s2 = (t2 as any).CleanupStrategy as TempCleanupStrategy;

      expect(s1).to.be.instanceOf(TempCleanupStrategy);
      expect(s1).to.not.eq(s2);
    } finally {
      await t1.dispose();
      await t2.dispose();
    }
  });

  it('should not dispose backend fs when temp fs is disposed', async () => {
    const b = await backend();
    const t = await DI.resolve<fsTemp>(fsTemp, [
      { name: 'fs-temp-disposable', provider: 'fs-temp-local', cleanup: true, cleanupInterval: 10000, maxFileAge: 5 },
    ]);

    const spy = sinon.spy(b, 'dispose');

    await t.dispose();

    expect(spy.called).to.be.false;

    // backend still operational after wrapper disposal
    await b.write('after-dispose.txt', 'still alive');
    expect(await b.exists('after-dispose.txt')).to.be.true;
    await b.rm('after-dispose.txt');
  });
});
