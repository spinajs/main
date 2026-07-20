import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import '@spinajs/templates-pug';
import { cp } from 'fs/promises';
import { join } from 'path';
import { fs, FsBootsrapper, fsService } from '../src/index.js';
import { dir, TestConfiguration } from './common.js';

import { FsDescribeCommand } from '../src/cli/fs.js';
import { FsLsCommand } from '../src/cli/ls.js';
import { FsStatCommand } from '../src/cli/stat.js';
import { FsRmCommand } from '../src/cli/rm.js';
import { FsCatCommand } from '../src/cli/cat.js';
import { FsExistsCommand } from '../src/cli/exists.js';
import { FsCpCommand } from '../src/cli/cp.js';
import { FsMvCommand } from '../src/cli/mv.js';
import { FsMkdirCommand } from '../src/cli/mkdir.js';
import { FsHashCommand } from '../src/cli/hash.js';
import { FsInfoCommand } from '../src/cli/info.js';
import { FsZipCommand } from '../src/cli/zip.js';
import { FsUnzipCommand } from '../src/cli/unzip.js';
import { FsDownloadCommand } from '../src/cli/download.js';
import { FsUploadCommand } from '../src/cli/upload.js';
import { FsWriteCommand } from '../src/cli/write.js';

async function testFs() {
  return DI.resolve<fs>('__file_provider__', ['test']);
}
async function tempFs() {
  return DI.resolve<fs>('__file_provider__', ['fs-temp']);
}

// spy on the exact Log instance a resolved command uses
function spyLog(cmd: object) {
  const log = (cmd as any).Log;
  return {
    info: sinon.spy(log, 'info'),
    success: sinon.spy(log, 'success'),
    error: sinon.spy(log, 'error'),
  };
}

function loggedWith(spy: sinon.SinonSpy, needle: string) {
  return spy.getCalls().some((c) => String(c.args[0]).includes(needle));
}

describe('fs cli commands', function () {
  this.timeout(15000);

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
  });

  beforeEach(async () => {
    const t = await testFs();
    await t.mkdir('cli');
    await t.write('cli/hello.txt', 'hello world', 'utf-8');
    // fixture zip ( contains zipped.txt )
    await cp(join(dir('files_restore'), 'zipped.zip'), t.resolvePath('cli/zipped.zip'), { force: true });
  });

  afterEach(async () => {
    sinon.restore();
    const t = await testFs();
    await t.rm('cli');
  });

  it('fs-describe lists registered filesystems', async () => {
    const cmd = await DI.resolve(FsDescribeCommand);
    const spy = spyLog(cmd);
    await cmd.execute();

    expect(spy.error.called).to.be.false;
    expect(loggedWith(spy.info, "'test'")).to.be.true;
  });

  it('fs-ls lists directory content', async () => {
    const cmd = await DI.resolve(FsLsCommand);
    const spy = spyLog(cmd);
    await cmd.execute('test', 'cli');

    expect(spy.error.called).to.be.false;
    expect(loggedWith(spy.info, 'hello.txt')).to.be.true;
  });

  it('fs-stat prints statistics', async () => {
    const cmd = await DI.resolve(FsStatCommand);
    const spy = spyLog(cmd);
    await cmd.execute('test', 'cli/hello.txt');

    expect(spy.error.called).to.be.false;
    expect(loggedWith(spy.info, 'file')).to.be.true;
  });

  it('fs-cat prints file content', async () => {
    const cmd = await DI.resolve(FsCatCommand);
    const spy = spyLog(cmd);
    await cmd.execute('test', 'cli/hello.txt', { encoding: 'utf-8' });

    expect(spy.error.called).to.be.false;
    expect(loggedWith(spy.info, 'hello world')).to.be.true;
  });

  it('fs-exists reports existence', async () => {
    const cmd = await DI.resolve(FsExistsCommand);
    const spy = spyLog(cmd);

    await cmd.execute('test', 'cli/hello.txt');
    expect(loggedWith(spy.info, 'exists')).to.be.true;

    await cmd.execute('test', 'cli/nope.txt');
    expect(loggedWith(spy.info, 'does not exist')).to.be.true;
  });

  it('fs-hash prints a hash', async () => {
    const cmd = await DI.resolve(FsHashCommand);
    const spy = spyLog(cmd);
    await cmd.execute('test', 'cli/hello.txt', {});

    expect(spy.error.called).to.be.false;
    expect(loggedWith(spy.info, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')).to.be.true;
  });

  it('fs-info prints metadata', async () => {
    const t = await testFs();
    sinon.stub(t, 'metadata').resolves({ FileSize: 11 } as any);

    const cmd = await DI.resolve(FsInfoCommand);
    const spy = spyLog(cmd);
    await cmd.execute('test', 'cli/hello.txt');

    expect(spy.error.called).to.be.false;
    expect(loggedWith(spy.info, 'FileSize')).to.be.true;
  });

  it('fs-mkdir creates a directory', async () => {
    const cmd = await DI.resolve(FsMkdirCommand);
    await cmd.execute('test', 'cli/newdir');

    const t = await testFs();
    expect(await t.dirExists('cli/newdir')).to.be.true;
  });

  it('fs-write writes inline content', async () => {
    const cmd = await DI.resolve(FsWriteCommand);
    await cmd.execute('test', 'cli/written.txt', { content: 'written by cli', encoding: 'utf-8' });

    const t = await testFs();
    expect(await t.read('cli/written.txt', 'utf-8')).to.eq('written by cli');
  });

  it('fs-write writes from a local file', async () => {
    const cmd = await DI.resolve(FsWriteCommand);
    await cmd.execute('test', 'cli/fromfile.txt', { fromFile: dir('sample-files/test.txt'), encoding: 'utf-8' });

    const t = await testFs();
    expect(await t.read('cli/fromfile.txt', 'utf-8')).to.eq('hello world');
  });

  it('fs-rm removes a file', async () => {
    const t = await testFs();
    expect(await t.exists('cli/hello.txt')).to.be.true;

    const cmd = await DI.resolve(FsRmCommand);
    await cmd.execute('test', 'cli/hello.txt');

    expect(await t.exists('cli/hello.txt')).to.be.false;
  });

  it('fs-cp copies within a filesystem', async () => {
    const cmd = await DI.resolve(FsCpCommand);
    await cmd.execute('test', 'cli/hello.txt', 'cli/copy.txt', {});

    const t = await testFs();
    expect(await t.exists('cli/copy.txt')).to.be.true;
  });

  it('fs-mv moves within a filesystem', async () => {
    const cmd = await DI.resolve(FsMvCommand);
    await cmd.execute('test', 'cli/hello.txt', 'cli/moved.txt', {});

    const t = await testFs();
    expect(await t.exists('cli/hello.txt')).to.be.false;
    expect(await t.exists('cli/moved.txt')).to.be.true;
  });

  it('fs-upload uploads a local file', async () => {
    const cmd = await DI.resolve(FsUploadCommand);
    await cmd.execute('test', dir('sample-files/test.txt'), 'cli/uploaded.txt');

    const t = await testFs();
    expect(await t.read('cli/uploaded.txt', 'utf-8')).to.eq('hello world');
  });

  it('fs-download logs the local path', async () => {
    const cmd = await DI.resolve(FsDownloadCommand);
    const spy = spyLog(cmd);
    await cmd.execute('test', 'cli/hello.txt');

    expect(spy.error.called).to.be.false;
    expect(spy.success.called).to.be.true;
  });

  it('fs-zip creates an archive in the temp fs', async () => {
    const cmd = await DI.resolve(FsZipCommand);
    await cmd.execute('test', 'cli/hello.txt', { out: 'cli-zip.zip' });

    const tmp = await tempFs();
    expect(await tmp.exists('cli-zip.zip')).to.be.true;
    await tmp.rm('cli-zip.zip');
  });

  it('fs-unzip extracts an archive', async () => {
    const cmd = await DI.resolve(FsUnzipCommand);
    await cmd.execute('test', 'cli/zipped.zip', 'cli/unzipped', {});

    const t = await testFs();
    expect(await t.exists('cli/unzipped/zipped.txt')).to.be.true;
  });

  it('logs an error for an unknown filesystem instead of throwing', async () => {
    const cmd = await DI.resolve(FsLsCommand);
    const spy = spyLog(cmd);

    // must not throw - command catches and logs
    await cmd.execute('does-not-exist', '/');
    expect(spy.error.called).to.be.true;
  });
});
