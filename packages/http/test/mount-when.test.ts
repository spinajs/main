import 'mocha';
import { expect } from 'chai';
import { ClassInfo, DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { renderTemplate } from '@spinajs/log-common';
import { BaseController, ControllerRegistrationException, Controllers, ControllerSource, MountWhen } from '../src/index.js';

// Controllers resolve services that read the DI configuration.
class MountTestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

const FEATURES = new Map([
  ['features.reports', false],
  ['features.audit', true],
]);
// The conditions read a stub: other suites of the full run leave their own Configuration registered.
const config = { get: (path: string, fallback?: unknown) => FEATURES.get(path) ?? fallback } as unknown as Configuration;

const created: string[] = [];
let asked: { container: IContainer; config: Configuration } | null = null;
let conditionCalls = 0;

abstract class CountedController extends BaseController {
  constructor() {
    super();
    created.push(this.constructor.name);
  }

  public async resolve() {
    /* skip BaseController wiring - not needed here */
  }
}

class PlainController extends CountedController {}

@MountWhen((_, config) => config.get<boolean>('features.reports', true))
class ReportsController extends CountedController {}

@MountWhen(async (container, config) => {
  asked = { container, config };
  conditionCalls++;
  return config.get<boolean>('features.audit', false);
})
class AuditController extends CountedController {}

@MountWhen(() => 'yes' as unknown as boolean)
class SloppyController extends CountedController {}

class ReportsSubController extends ReportsController {}

@MountWhen(() => true)
class ReportsOnController extends ReportsController {}

const ALL = [PlainController, ReportsController, AuditController, SloppyController, ReportsSubController, ReportsOnController];
const OWN = new Set(ALL.map((type) => type.name));

class TestControllers extends Controllers {
  public Scanned: Array<ClassInfo<BaseController>> = [];
  private mounted: string[] = [];

  // Other suites of the full run leave their controllers registered as BaseController; only this file's count.
  public get Mounted() {
    return this.mounted.filter((name) => OWN.has(name));
  }

  public async register(controller: ClassInfo<BaseController>) {
    this.mounted.push(controller.name);
  }

  protected async getSources(): Promise<ControllerSource[]> {
    return [{ getControllers: async () => this.Scanned } as unknown as ControllerSource];
  }
}

async function loader(scanned: Array<Class<BaseController>>, infos: string[] = []) {
  const controllers = new TestControllers();
  const record = (first: unknown, template?: string) => (typeof first === 'string' ? first : renderTemplate(template ?? '', first as Record<string, unknown>));
  const noop = () => undefined;
  // @Logger installs a getter on the prototype, so the recorder goes onto the instance.
  Object.defineProperty(controllers, 'Log', {
    value: { trace: noop, debug: noop, info: (f: unknown, t?: string) => infos.push(record(f, t)), warn: noop, error: noop, fatal: noop, security: noop, success: noop },
  });
  Object.assign(controllers, {
    Server: { use: noop },
    Container: DI.RootContainer,
    Config: config,
  });
  controllers.Scanned = scanned.map((type) => Object.assign(new ClassInfo<BaseController>(), { name: type.name, type, file: `${type.name}.ts` }));
  return controllers;
}

describe('@MountWhen', () => {
  before(async () => {
    DI.register(MountTestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  after(() => {
    DI.unregister(MountTestConfiguration);
    DI.uncache(MountTestConfiguration);
  });

  beforeEach(() => {
    created.length = 0;
    asked = null;
    conditionCalls = 0;
  });

  afterEach(() => {
    // Controllers registers the types on the root container; later suites must not inherit them.
    for (const type of ALL) {
      DI.unregister(type);
      DI.uncache(type);
    }
    DI.uncache(BaseController);
  });

  it('mounts a controller without a condition', async () => {
    const controllers = await loader([PlainController]);
    await controllers.resolve();

    expect(controllers.Mounted).to.deep.equal(['PlainController']);
  });

  it('never creates, lists or mounts a scanned controller whose condition is false, and says so', async () => {
    const infos: string[] = [];
    const controllers = await loader([PlainController, ReportsController], infos);
    await controllers.resolve();

    expect(controllers.Mounted).to.deep.equal(['PlainController']);
    expect(created).to.not.include('ReportsController');
    expect((await controllers.Controllers).map((c) => c.name)).to.deep.equal(['PlainController']);
    expect(DI.getRegisteredTypes(BaseController)).to.not.include(ReportsController);
    expect(infos).to.include('Controller ReportsController is not mounted: its @MountWhen condition returned false');
  });

  it('hands the condition the container and the configuration, and awaits it', async () => {
    const controllers = await loader([AuditController]);
    await controllers.resolve();

    expect(controllers.Mounted).to.deep.equal(['AuditController']);
    expect(asked?.container).to.equal(DI.RootContainer);
    expect(asked?.config).to.equal(config);
  });

  it('asks the condition once per boot', async () => {
    const controllers = await loader([AuditController]);
    await controllers.resolve();
    await controllers.Controllers;

    expect(conditionCalls).to.equal(1);
  });

  it('refuses a condition that returns no boolean', async () => {
    const controllers = await loader([SloppyController]);

    const err = await controllers.resolve().then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).to.be.instanceOf(ControllerRegistrationException);
    expect((err as Error).message).to.equal('@MountWhen of controller SloppyController must return a boolean, got string');
  });

  it('applies the parent condition to a subclass, and lets the subclass replace it', async () => {
    const controllers = await loader([ReportsSubController, ReportsOnController]);
    await controllers.resolve();

    expect(controllers.Mounted).to.deep.equal(['ReportsOnController']);
  });

  it('leaves unmounted a controller registered as BaseController directly', async () => {
    DI.register(ReportsController).as(BaseController);

    const controllers = await loader([PlainController]);
    await controllers.resolve();

    expect(controllers.Mounted).to.deep.equal(['PlainController']);
  });

  it('add() skips a controller whose condition is false', async () => {
    const controllers = await loader([]);
    await controllers.resolve();
    await controllers.add(ReportsController);

    expect(controllers.Mounted).to.deep.equal([]);
    expect(created).to.not.include('ReportsController');
    expect(DI.getRegisteredTypes(BaseController)).to.not.include(ReportsController);
  });
});
