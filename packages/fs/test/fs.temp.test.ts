import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import '@spinajs/templates-pug';
import { TestConfiguration } from './common.js';
import { fs, FsBootsrapper, fsService } from '../src/index.js';
import { sleep } from '@spinajs/threading';

async function tmp() {
  return await DI.resolve<fs>('__file_provider__', ['fs-temp']);
}

describe('fs temp tests', function () {
  this.timeout(30000);

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);

    await DI.resolve(fsService);

  });

  after(async () => {
    const t = await tmp();
    await t.dispose();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should NOT arm cleanup timer when cleanup is disabled', async () => {
    const withCleanup = await tmp();
    const noCleanup = await DI.resolve<fs>('__file_provider__', ['fs-temp-nc']);

    // white-box: strategy timer handle is only armed when cleanup is enabled
    expect((withCleanup as any).CleanupStrategy.cleanupTimer).to.not.be.null;
    expect((noCleanup as any).CleanupStrategy.cleanupTimer).to.be.null;
  });

  it('should create temporary file', async () => {
    const t = await tmp();
    await t.write('tmp.txt', 'hello temp');

    const tmpPath = t.resolvePath('tmp.txt');
    const exists = await t.exists('tmp.txt');
    expect(exists).to.true;
    expect(tmpPath.endsWith('packages\\fs\\test\\temp\\tmp.txt')).to.true;
  });

  it('should cleanup old temp file', async () => {
    await sleep(20 * 1000);

    const t = await tmp();
    const files = await t.list('/');

    expect(files.length).to.be.eq(0);
  });
});
