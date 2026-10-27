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

  async function twoPublishers(): Promise<[fsService, fsService]> {
    const older = await DI.resolve(fsService);
    DI.uncache(fsService);
    const newer = await DI.resolve(fsService);
    return [older, newer];
  }

  it('dispose of an older fsService leaves a name a newer one published again, the newer one unpublishes it', async () => {
    const [older, newer] = await twoPublishers();

    await older.dispose();
    expect(publishedFs('test')).to.not.be.undefined;

    await newer.dispose();
    expect(publishedFs('test')).to.be.undefined;
  });

  it('dispose of the newer fsService unpublishes the name, and the older one leaves a provider published under it since', async () => {
    const [older, newer] = await twoPublishers();

    await newer.dispose();
    expect(publishedFs('test')).to.be.undefined;

    const other = { Name: 'test' } as unknown as fs;
    DI.register(other).asMapValue(FILE_PROVIDER_INSTANCES, 'test');
    await older.dispose();
    expect(publishedFs('test')).to.equal(other);
  });

  it('an fsService from before a snapshot still unpublishes its name after a restore disposed a newer publisher', async () => {
    const older = await DI.resolve(fsService);
    const inner = DI.snapshot();
    DI.uncache(fsService);
    await DI.resolve(fsService);
    await DI.restore(inner);
    expect(publishedFs('test')).to.not.be.undefined;

    await older.dispose();

    expect(publishedFs('test')).to.be.undefined;
  });

  it('dispose leaves a name alone when another provider was published under it since', async () => {
    const service = await DI.resolve(fsService);
    const other = { Name: 'test' } as unknown as fs;
    DI.register(other).asMapValue(FILE_PROVIDER_INSTANCES, 'test');

    await service.dispose();

    expect(publishedFs('test')).to.equal(other);
  });
});
