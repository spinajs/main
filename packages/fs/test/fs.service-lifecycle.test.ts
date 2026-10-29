import 'mocha';
import { expect } from 'chai';

import { ContainerSnapshot, DI, ResolveException } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import '@spinajs/templates-pug';
import { dir, TestConfiguration } from './common.js';
import { fs, FILE_PROVIDER_INSTANCES, FsBootstrapper, fsService, publishedFs } from '../src/index.js';

class LifecycleConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.fs = { defaultProvider: 'test', providers: [{ service: 'fsNative', name: 'test', basePath: dir('./files') }] };
  }
}

describe('fsService and the published provider map', function () {
  this.timeout(15000);
  let before: ContainerSnapshot;

  beforeEach(async () => {
    before = DI.snapshot();
    DI.resolve(FsBootstrapper).bootstrap();
    DI.uncache(Configuration);
    DI.uncache(fsService);
    DI.register(LifecycleConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    await DI.restore(before);
  });

  it('unpublishes its providers on dispose, so __file_provider__ no longer serves them', async () => {
    const service = await DI.resolve(fsService);
    expect(publishedFs('test')).to.not.be.undefined;

    DI.register({ Name: 'extra' }).asMapValue(FILE_PROVIDER_INSTANCES, 'extra');
    await service.dispose();

    expect(publishedFs('test')).to.be.undefined;
    expect(publishedFs('extra')).to.not.be.undefined;
    expect(() => DI.resolve<fs>('__file_provider__', ['test'])).to.throw(ResolveException);
  });

  it('dispose of an older fsService leaves a name a newer one published again', async () => {
    const older = await DI.resolve(fsService);
    DI.uncache(fsService);
    await DI.resolve(fsService);

    await older.dispose();

    expect(publishedFs('test')).to.not.be.undefined;
  });
});
