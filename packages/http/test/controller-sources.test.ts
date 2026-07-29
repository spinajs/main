import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { BaseController } from '../src/base-controller.js';
import { DiRegistryControllerSource, FilesystemControllerSource, ControllerSource } from '../src/controller-sources.js';

class RegistrySampleController extends BaseController {
  public async resolve() {
    /* skip BaseController wiring - not needed here */
  }
}

describe('controller sources', () => {
  afterEach(() => {
    DI.unregister(RegistrySampleController);
    DI.uncache(RegistrySampleController);
    DI.uncache(BaseController);
  });

  it('DiRegistryControllerSource lists types registered as BaseController', async () => {
    DI.register(RegistrySampleController).as(BaseController);

    const source = new DiRegistryControllerSource();
    const list = await source.getControllers();

    const entry = list.find((c) => c.name === 'RegistrySampleController');
    expect(entry).to.exist;
    expect(entry!.type).to.eq(RegistrySampleController);
    // No route decorators ran on the fixture, so no SourceFile was captured.
    expect(entry!.file).to.eq('<di>');
  });

  it('DiRegistryControllerSource returns empty list when nothing is registered', async () => {
    const source = new DiRegistryControllerSource();
    const list = await source.getControllers();
    expect(list.find((c) => c.name === 'RegistrySampleController')).to.not.exist;
  });

  it('both built-in sources are registered as ControllerSource in DI', () => {
    const types = DI.getRegisteredTypes(ControllerSource) ?? [];
    expect(types).to.include(FilesystemControllerSource);
    expect(types).to.include(DiRegistryControllerSource);
  });
});
