import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { BaseController, BasePath, Get, Ok, Policy, CONTROLLED_DESCRIPTOR_SYMBOL } from '../src/index.js';
import { BasePolicy } from '../src/interfaces.js';
import type { IControllerDescriptor, IRoute, IController } from '../src/interfaces.js';
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

@BasePath('user')
@Policy(SamplePolicy)
class PkgUserController extends BaseController {
  @Get()
  public async refresh() { return new Ok('pkg-refresh'); }

  @Get()
  public async grants() { return new Ok('pkg-grants'); }

  public async resolve() { /* skip BaseController wiring - not needed here */ }
}

class AppUserController extends PkgUserController {
  @Get()
  public async refresh() { return new Ok('app-refresh'); }

  public async resolve() { /* see above */ }
}

class OtherFileAppController extends OtherFilePkgController {
  @Get()
  public async refresh() { return new Ok('app-refresh'); }
}

const descriptorOf = (c: object) => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, c) as IControllerDescriptor;

describe('controller descriptor inheritance', () => {
  before(() => {
    DI.register(MinimalTestConfiguration).as(Configuration);
  });

  beforeEach(async () => {
    await DI.resolve(Configuration);
  });

  afterEach(() => {
    DI.uncache(BaseController);
  });

  it('gives the subclass its own descriptor', () => {
    expect(descriptorOf(AppUserController.prototype)).to.not.equal(descriptorOf(PkgUserController.prototype));
  });

  it('leaves the parent route table untouched', () => {
    const pkg = descriptorOf(PkgUserController.prototype);
    expect([...pkg.Routes.keys()].sort()).to.deep.eq(['grants', 'refresh']);
    // the parent's own handler must still be its own
    expect(pkg.Routes.get('refresh')!.Method).to.not.be.undefined;
  });

  it('inherits routes the subclass does not redeclare', () => {
    const app = descriptorOf(AppUserController.prototype);
    expect([...app.Routes.keys()].sort()).to.deep.eq(['grants', 'refresh']);
  });

  it('inherits BasePath and Policies without redeclaring them', () => {
    const app = descriptorOf(AppUserController.prototype);
    expect(app.BasePath).to.eq('user');
    expect(app.Policies.map((p) => p.Type)).to.include(SamplePolicy);
  });

  it('keeps SourceFile pointing at each class own file', () => {
    // ControllersCache.getCache() parses SourceFile looking for the class BY
    // NAME, so an inherited path would send it to the package file where the
    // subclass is not declared.
    expect(descriptorOf(OtherFilePkgController.prototype).SourceFile).to.match(/controller-inheritance-fixture\.(ts|js)$/);
    expect(descriptorOf(OtherFileAppController.prototype).SourceFile).to.match(/controller-inheritance\.test\.(ts|js)$/);
  });

  it('resolves the subclass alone through the BaseController collection', async () => {
    DI.register(PkgUserController).as(BaseController);
    DI.register(AppUserController).as(BaseController);
    DI.register(AppUserController).as(PkgUserController);

    const all = (await DI.resolve(Array.ofType(BaseController))) as BaseController[];
    const names = all.map((c) => c.constructor.name);

    expect(names).to.include('AppUserController');
    expect(names).to.not.include('PkgUserController');
  });
});
