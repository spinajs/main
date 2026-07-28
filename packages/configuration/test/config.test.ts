/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { join, normalize, resolve } from 'path';
import { DI, IMappableService, Injectable } from '@spinajs/di';
import { Configuration, ConfigVar, ConfigVarProtocol } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { AutoinjectService } from './../src/decorators.js';
import { JsFileSource } from '../src/sources.js';
 

// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
chai.use(chaiAsPromised);

function cfg() {
  return DI.resolve<Configuration>(Configuration);
}

function cfgApp() {
  return DI.resolve<Configuration>(Configuration, [
    {
      app: 'testapp',
      appBaseDir: normalize(join(process.cwd(), 'test', '/mocks/apps')),
    },
  ]);
}

function cfgNoApp() {
  return DI.resolve<Configuration>(Configuration, [
    {
      cfgCustomPaths: [normalize(join(process.cwd(), 'test', '/mocks/config'))],
    },
  ]);
}

class TestConfiguration extends FrameworkConfiguration {}

@Injectable(ConfigVarProtocol)
export class TestValProtocol extends ConfigVarProtocol {
  public get Protocol() {
    return 'test://';
  }

  public getVar(_path: string, _config: any): Promise<any> {
    return Promise.resolve('sample-val-proto');
  }
}

@Injectable(ConfigVarProtocol)
export class Test2ValProtocol extends ConfigVarProtocol {
  public get Protocol() {
    return 'test2://';
  }

  public getVar(_path: string, _config: any): Promise<any> {
    return Promise.resolve(
      new ConfigVar(() => {
        return 'test2-val';
      }),
    );
  }
}

/**
 * Protocol used to verify ROOT-level ConfigVar laziness. Value / call count are
 * controllable so tests can simulate a value that is not ready yet ( null ) and
 * becomes available later ( eg. fs providers registered after configuration ).
 */
@Injectable(ConfigVarProtocol)
export class LazyRootProtocol extends ConfigVarProtocol {
  public static Calls = 0;
  public static Value: string | null = 'lazy-root-val';

  public get Protocol() {
    return 'lazyroot://';
  }

  public getVar(_path: string, _config: any): Promise<any> {
    return Promise.resolve(
      new ConfigVar(() => {
        LazyRootProtocol.Calls++;
        return LazyRootProtocol.Value;
      }),
    );
  }
}

describe('Configuration tests', () => {
  before(() => {
    DI.register(TestConfiguration).as(Configuration);
  });

  beforeEach(() => {
    DI.clearCache();
    DI.setESMModuleSupport();
  });

  it('Should load multiple nested files', async () => {
    const config = await cfgNoApp();
    const test = config.get(['test', 'value2']);
    expect(test).to.be.eq(666);
  });

  it('Should load vars from conf protocol', async () => {
    const config = await cfgNoApp();
    const test = config.get('protocol.test');
    expect(test).to.be.eq('sample-val-proto');
  });

  it('ROOT-level protocol vars stay lazy and retry until ready ( regression )', async () => {
    // simulate "value not ready during configuration bootstrap" ( eg. fs-path://
    // before fsService registered providers )
    LazyRootProtocol.Calls = 0;
    LazyRootProtocol.Value = null;

    const config = await cfgNoApp();

    // not ready yet - lazy value resolves to null, must NOT throw
    expect(config.get('rootLazy')).to.eq(null);

    // becomes available later ( ConfigVar caches only truthy values -> retried ).
    // Before the root-proxy fix the spread in load() inlined the dereferenced
    // value once and the ConfigVar was lost - this stayed null forever.
    LazyRootProtocol.Value = 'ready-now';
    expect(config.get('rootLazy')).to.eq('ready-now');
    expect(LazyRootProtocol.Calls).to.be.greaterThan(1);

    // and truthy result is cached - no further lazy calls
    const calls = LazyRootProtocol.Calls;
    expect(config.get('rootLazy')).to.eq('ready-now');
    expect(LazyRootProtocol.Calls).to.eq(calls);

    LazyRootProtocol.Value = 'lazy-root-val';
  });

  it('Should load vars from conf protocol - lazy value', async () => {
    const config = await cfgNoApp();
    const test = config.get('protocol.test2');
    expect(test).to.be.eq('test2-val');
  });

  it('Should load config files without app specified', async () => {
    const config = await cfgNoApp();
    const test = config.get(['app', 'appLoaded']);
    expect(test).to.be.undefined;
  });

  it('Should load config files', async () => {
    const config = await cfgNoApp();
    const test = config.get(['test']);
    const json = config.get(['jsonentry']);

    expect(test).to.not.be.undefined;
    expect(json).to.be.true;
  });

  it('should return default value if no config property exists', async () => {
    const config = await cfgNoApp();
    const test = config.get(['test', 'value3'], 111);

    expect(test).to.be.eq(111);
  });

  it('should merge two config files', async () => {
    const config = await cfgNoApp();
    const test = config.get('test.array');

    expect(test).to.include.members([1, 2, 3, 4]);
  });

  it('should run configuration function', async () => {
    const config = await cfgNoApp();
    const test = config.get('test.confFunc');

    expect(test).to.eq(true);
  });

  it('should get with dot notation', async () => {
    const config = await cfgNoApp();
    const test = config.get('test.value');

    expect(test).to.eq(1);
  });

  it('should merge application config', async () => {
    const config = await cfgApp();
    const test = config.get('app');

    expect(test).to.not.be.undefined;
  });

  it('should return undefined when no value', async () => {
    const config = await cfgNoApp();
    const test = config.get('app.undefinedValue');

    expect(test).to.be.undefined;
  });

  it('should merge app config with app from argv', async () => {
    const dir = normalize(join(process.cwd(), 'test', '/mocks/apps'));

    process.argv.push('--app');
    process.argv.push('testapp');

    process.argv.push('--apppath');
    process.argv.push(dir);
    const config = await cfg();

    const test = config.get('app');
    expect(test).to.not.be.undefined;

    expect(config.RunApp).to.eq('testapp');
    expect(config.AppBaseDir).to.eq(dir);
  });

  it('Should load production only config', async () => {
    process.env.NODE_ENV = 'production';

    const config = await cfgNoApp();

    expect(config.get('test.production')).to.eq(true);
    expect(config.get('test.development')).to.eq(undefined);

    expect(config.get('json-prod')).to.eq(true);
    expect(config.get('json-dev')).to.eq(undefined);
  });

  it('Should load development only config', async () => {
    process.env.NODE_ENV = 'development';

    const config = await cfgNoApp();

    expect(config.get('test.production')).to.eq(undefined);
    expect(config.get('test.development')).to.eq(true);

    expect(config.get('json-prod')).to.eq(undefined);
    expect(config.get('json-dev')).to.eq(true);
  });

  it('Set should override loaded config', async () => {
    const config = await cfgNoApp();
    const test = config.get('test.value');
    expect(test).to.eq(1);

    config.set('test.value', 555);

    const test2 = config.get('test.value');
    expect(test2).to.eq(555);
  });

  it('should merge programatically', async () => {
    const config = await cfgNoApp();

    config.merge('test.array', [333]);

    expect(config.get<number[]>('test.array')).to.include.members([1, 2, 333]);
  });

  it('Should validate config', () => {
    DI.register({
      $id: 'test',
      $configurationModule: 'test',
      type: 'object',
      properties: {
        value: { type: 'number' },
        array: { type: 'array' },
      },
      required: ['value', 'array'],
    }).asValue('__configurationSchema__');

    expect(cfgNoApp()).to.be.fulfilled;
  });

  it('Should validate subconfigs', () => {
    DI.register({
      $id: 'test',
      $configurationModule: 'test.test2',
      type: 'object',
      properties: {
        value: { type: 'number' },
        array: { type: 'array' },
      },
      required: ['value', 'array'],
    }).asValue('__configurationSchema__');

    expect(cfgNoApp()).to.be.fulfilled;
  });

  it('Should reject on validate config', () => {
    DI.register({
      $id: 'test',
      $configurationModule: 'test',
      type: 'object',
      properties: {
        value: { type: 'array' },
        array: { type: 'array' },
      },
      required: ['value', 'array'],
    }).asValue('__configurationSchema__');

    DI.register({
      $id: 'test2',
      $configurationModule: 'test2',
      type: 'object',
      properties: {
        value: { type: 'number' },
        array: { type: 'array' },
      },
      required: ['value', 'array'],
    }).asValue('__configurationSchema__');

    expect(cfgNoApp()).to.be.rejected;
  });

  it('Should resolve array from AutoinjectService', async () => {
    await cfgNoApp();

    class Base implements IMappableService {
      ServiceName: string;
    }

    class Serv1 extends Base {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(options: any) {
        super();

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.ServiceName = options.name as string;
      }
    }

    class Serv2 extends Base {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(options: any) {
        super();

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.ServiceName = options.name as string;
      }
    }

    DI.register(Serv1).as(Base);
    DI.register(Serv2).as(Base);

    class Serv3 {
      @AutoinjectService('autoinject', Base)
      public Services: Map<string, Base>;
    }

    const instance = DI.resolve(Serv3);

    expect(instance.Services).to.be.not.null;
    expect(instance.Services.get('serv1')).to.be.not.null;
    expect(instance.Services.get('serv2')).to.be.not.null;

    expect(instance.Services.get('serv1')!.constructor.name).to.eq('Serv1');
    expect(instance.Services.get('serv2')!.constructor.name).to.eq('Serv2');
  });
});

describe('config source search paths', () => {
  it('finds @spinajs package configs in a workspace root above the app package', () => {
    // npm workspaces hoist @spinajs to the repo root, so an app at
    // <root>/packages/<app> has its dependencies two levels up. Config discovery
    // must reach that without relying on WORKSPACE_ROOT_PATH being set by hand.
    const source = new JsFileSource() as unknown as { CommonDirs: string[] };
    const workspaceRoot = resolve(process.cwd(), '..', '..');
    const expectedPrefix = normalize(join(workspaceRoot, 'node_modules', '@spinajs'));

    const found = source.CommonDirs.some((d) => d.startsWith(expectedPrefix));

    expect(found, `expected a search dir under ${expectedPrefix}, got:\n${source.CommonDirs.join('\n')}`).to.equal(true);
  });
});

describe('workspace root detection', () => {
  const original = process.env.WORKSPACE_ROOT_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.WORKSPACE_ROOT_PATH;
    else process.env.WORKSPACE_ROOT_PATH = original;
  });

  it('sets WORKSPACE_ROOT_PATH to the hoisting root when it is not provided', () => {
    // 15 @spinajs package configs build their own paths from
    // `WORKSPACE_ROOT_PATH ?? process.cwd()`. In a workspace the packages are hoisted
    // to the repo root, so without this var they resolve to a path that does not
    // exist - and fsNative then CREATES it, leaving empty dirs that shadow the real
    // package and break module resolution. Detect the root instead of requiring
    // every launch script to set it by hand.
    delete process.env.WORKSPACE_ROOT_PATH;

    new JsFileSource();

    expect(process.env.WORKSPACE_ROOT_PATH).to.equal(resolve(process.cwd(), '..', '..'));
  });

  it('never overrides an explicitly provided WORKSPACE_ROOT_PATH', () => {
    process.env.WORKSPACE_ROOT_PATH = 'D:\explicit\root';

    new JsFileSource();

    expect(process.env.WORKSPACE_ROOT_PATH).to.equal('D:\explicit\root');
  });
});
