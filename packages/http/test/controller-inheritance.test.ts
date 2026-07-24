import 'mocha';
import { expect } from 'chai';
import { ClassInfo, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { BaseController, BasePath, Controllers, Get, Middleware, Ok, Policy, Query, CONTROLLED_DESCRIPTOR_SYMBOL } from '../src/index.js';
import { BasePolicy, RouteMiddleware } from '../src/interfaces.js';
import type { IControllerDescriptor, IRoute, IController, Response } from '../src/interfaces.js';
import { OtherFilePkgController } from './controller-inheritance-fixture.js';

class MinimalTestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

class SamplePolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean { return true; }
  public async execute(): Promise<void> { /* allow */ }
}

/** Declared only by the subclass - must never reach the parent's route. */
class ExtraPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean { return true; }
  public async execute(): Promise<void> { /* allow */ }
}

class SampleMiddleware extends RouteMiddleware {
  public isEnabled(_route: IRoute, _controller: IController): boolean { return true; }
  public async onBefore(): Promise<void> { /* noop */ }
  public async onResponse(_response: Response): Promise<void> { /* noop */ }
  public async onAfter(): Promise<void> { /* noop */ }
}

@BasePath('user')
@Policy(SamplePolicy)
@Middleware(SampleMiddleware)
class PkgUserController extends BaseController {
  @Get()
  public async refresh() { return new Ok('pkg-refresh'); }

  @Get()
  public async grants(@Query() _page?: number) { return new Ok('pkg-grants'); }

  public async resolve() { /* skip BaseController wiring - not needed here */ }
}

class AppUserController extends PkgUserController {
  // Overriding one route and changing its path, policies and arguments is the
  // most likely override shape - and the one that used to write straight into
  // the package controller's own IRoute.
  @Get('v2')
  @Policy(ExtraPolicy)
  public async refresh(@Query() _id?: number) { return new Ok('app-refresh'); }

  public async resolve() { /* see above */ }
}

class OtherFileAppController extends OtherFilePkgController {
  @Get()
  public async refresh() { return new Ok('app-refresh'); }
}

// ---------------------------------------------------------------------------
// Fixtures for the loader-level override report
// ---------------------------------------------------------------------------

/** Stands in for a controller shipped by a package. */
class LoaderPkgController extends BaseController {
  public async resolve() { /* skip BaseController wiring - not needed here */ }
}

/** The application's replacement for it. */
class LoaderAppController extends LoaderPkgController {
  public async resolve() { /* see above */ }
}

/** Unrelated to the pair above - must never appear in the report. */
class LoaderSoloController extends BaseController {
  public async resolve() { /* see above */ }
}

interface ILogCall {
  level: string;
  message: string;
}

/**
 * Controllers reads its logger through `@Logger('http')`, which installs a
 * non-configurable getter on the prototype - hence an own property on the
 * instance rather than a stub on the class. Recording locally also leaves the
 * process-wide `Log.Loggers` map alone, so no later suite inherits a logger
 * built from this file's blackhole configuration.
 */
function recordingLog(calls: ILogCall[]) {
  const record = (level: string) => (message: string) => { calls.push({ level, message: String(message) }); };
  return {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    security: record('security'),
    success: record('success'),
  };
}

/**
 * Drives the real `Controllers.resolve()`. Only the file scan, the route
 * attachment and the Express mount are faked - `fileByType` and the
 * BaseController collection, the two inputs the override report is derived
 * from, are exactly what production builds.
 */
class TestControllers extends Controllers {
  public Scanned: Array<ClassInfo<BaseController>> = [];
  public Mounted: string[] = [];

  public async register(controller: ClassInfo<BaseController>) {
    // The real one parses the controller's source file and attaches routes to
    // Express; recording the name is all these tests need.
    this.Mounted.push(controller.name);
  }
}

// `@ListFromFiles` installed a getter on Controllers.prototype - shadow it so
// the test decides what "found on disk" means.
Object.defineProperty(TestControllers.prototype, 'Controllers', {
  get(this: TestControllers) {
    return Promise.resolve(this.Scanned);
  },
});

async function runLoader(scanned: Array<Class<BaseController>>) {
  const calls: ILogCall[] = [];
  const loader = new TestControllers();

  Object.defineProperty(loader, 'Log', { value: recordingLog(calls) });
  (loader as unknown as { Server: unknown }).Server = { use: () => { /* Express mount - not under test */ } };

  loader.Scanned = scanned.map((type) =>
    Object.assign(new ClassInfo<BaseController>(), {
      name: type.name,
      type,
      file: `${type.name}.ts`,
    }),
  );

  await loader.resolve();

  return { calls, mounted: loader.Mounted };
}

// Own metadata only: `Reflect.getMetadata` walks the prototype chain and would
// report the parent's descriptor for an undecorated class, which is exactly the
// confusion these tests exist to rule out.
const descriptorOf = (c: object) => Reflect.getOwnMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, c) as IControllerDescriptor;

describe('controller descriptor inheritance', () => {
  before(() => {
    DI.register(MinimalTestConfiguration).as(Configuration);
  });

  beforeEach(async () => {
    await DI.resolve(Configuration);
  });

  it('gives the subclass its own descriptor', () => {
    expect(descriptorOf(AppUserController.prototype), 'subclass owns no descriptor of its own').to.exist;
    expect(descriptorOf(AppUserController.prototype)).to.not.equal(descriptorOf(PkgUserController.prototype));
  });

  it('leaves the parent route table untouched', () => {
    const pkg = descriptorOf(PkgUserController.prototype);
    const app = descriptorOf(AppUserController.prototype);

    expect([...pkg.Routes.keys()].sort()).to.deep.eq(['grants', 'refresh']);

    const pkgRefresh = pkg.Routes.get('refresh')!;
    const appRefresh = app.Routes.get('refresh')!;

    // Route decorators mutate the IRoute in place, so a shared entry means the
    // subclass rewrites the parent's route rather than its own.
    expect(pkgRefresh).to.not.equal(appRefresh);

    expect(pkgRefresh.Path, 'parent path rewritten by the subclass').to.be.undefined;
    expect(pkgRefresh.Policies.map((p) => p.Type), 'subclass policy leaked to the parent').to.not.include(ExtraPolicy);
    expect(pkgRefresh.Parameters.size, 'subclass argument leaked to the parent').to.eq(0);

    expect(appRefresh.Path).to.eq('v2');
    expect(appRefresh.Policies.map((p) => p.Type)).to.include(ExtraPolicy);
    expect(appRefresh.Parameters.size).to.eq(1);
  });

  it('inherits routes the subclass does not redeclare', () => {
    const app = descriptorOf(AppUserController.prototype);
    expect([...app.Routes.keys()].sort()).to.deep.eq(['grants', 'refresh']);

    const pkgGrants = descriptorOf(PkgUserController.prototype).Routes.get('grants')!;
    const appGrants = app.Routes.get('grants')!;

    // Inherited routes are copies too, down to the parameter objects: the
    // controller registration patches `Name` into them from the parsed source
    // file, which for the subclass is a different file.
    expect(appGrants).to.not.equal(pkgGrants);
    expect(appGrants.Parameters.get(0)).to.not.equal(pkgGrants.Parameters.get(0));
    expect(appGrants.Parameters.get(0)).to.deep.eq(pkgGrants.Parameters.get(0));
  });

  it('inherits BasePath, Policies and Middlewares without redeclaring them', () => {
    const app = descriptorOf(AppUserController.prototype);
    expect(app.BasePath).to.eq('user');
    expect(app.Policies.map((p) => p.Type)).to.include(SamplePolicy);
    expect(app.Middlewares.map((m) => m.Type)).to.include(SampleMiddleware);
  });

  it('keeps SourceFile pointing at each class own file', () => {
    // ControllersCache.getCache() parses SourceFile looking for the class BY
    // NAME, so an inherited path would send it to the package file where the
    // subclass is not declared.
    expect(descriptorOf(OtherFilePkgController.prototype).SourceFile).to.match(/controller-inheritance-fixture\.(ts|js)$/);
    expect(descriptorOf(OtherFileAppController.prototype).SourceFile).to.match(/controller-inheritance\.test\.(ts|js)$/);
  });

  it('resolves the subclass alone through the BaseController collection', async () => {
    // Registrations live in a child container: DI.uncache() drops cached
    // instances but not registrations, so registering on the root would leave
    // these controllers in Array.ofType(BaseController) for every later suite.
    const container = DI.child();
    container.register(PkgUserController).as(BaseController);
    container.register(AppUserController).as(BaseController);
    container.register(AppUserController).as(PkgUserController);

    const all = (await container.resolve(Array.ofType(BaseController))) as BaseController[];
    const names = all.map((c) => c.constructor.name);

    expect(names).to.include('AppUserController');
    expect(names).to.not.include('PkgUserController');
  });

  describe('override reporting from the Controllers loader', () => {
    afterEach(() => {
      // Controllers.resolve() registers the scanned types on the ROOT container
      // ( it uses the global DI, not this.Container ), so each test has to hand
      // them back or they leak into every later suite in this process.
      for (const type of [LoaderAppController, LoaderPkgController, LoaderSoloController]) {
        DI.unregister(type);
        DI.uncache(type);
      }

      // The BaseController collection is cached as a whole and is only rebuilt
      // when a registered type is missing from it - dropping a registration is
      // not enough on its own, the cached array has to go too.
      DI.uncache(BaseController);
    });

    it('reports an override at info and mounts the subclass alone', async () => {
      // The shape the whole feature exists for: the app replaces a controller
      // shipped by a package.
      DI.register(LoaderAppController).as(LoaderPkgController);

      const { calls, mounted } = await runLoader([LoaderPkgController, LoaderAppController]);

      expect(mounted).to.include('LoaderAppController');
      expect(mounted).to.not.include('LoaderPkgController');

      const info = calls.filter((c) => c.level === 'info' && c.message.includes('LoaderPkgController'));
      expect(info.map((c) => c.message), 'scanned controller dropped from the mount without a word').to.have.lengthOf(1);
      expect(info[0].message).to.contain('LoaderAppController');

      const warn = calls.filter((c) => c.level === 'warn' && c.message.includes('LoaderPkgController'));
      expect(warn.map((c) => c.message), 'a registered override is not a mistake').to.be.empty;
    });

    it('warns when a scanned controller is subclassed but no override was registered', async () => {
      const { calls, mounted } = await runLoader([LoaderPkgController, LoaderAppController]);

      // Behaviour is unchanged - both still mount, only the report is new.
      expect(mounted).to.include('LoaderPkgController');
      expect(mounted).to.include('LoaderAppController');

      const warn = calls.filter((c) => c.level === 'warn' && c.message.includes('LoaderPkgController'));
      expect(warn.map((c) => c.message), 'both mounted and nothing said so').to.have.lengthOf(1);
      expect(warn[0].message).to.contain('LoaderAppController');
      // The reader has to be told what to call, not just that something smells.
      expect(warn[0].message).to.contain('DI.register(LoaderAppController).as(LoaderPkgController)');

      const info = calls.filter((c) => c.level === 'info' && c.message.includes('overridden'));
      expect(info.map((c) => c.message), 'nothing was overridden here').to.be.empty;
    });

    it('stays quiet for controllers with no scanned base', async () => {
      // LoaderPkgController is deliberately NOT scanned - the shape of a shared
      // base living outside the controllers dir ( eg. abstract Crud in orm-api ).
      const { calls } = await runLoader([LoaderAppController, LoaderSoloController]);

      const noisy = calls.filter((c) => (c.level === 'warn' || c.level === 'info') && /Loader\w+Controller/.test(c.message));
      expect(noisy.map((c) => c.message)).to.be.empty;
    });
  });
});
