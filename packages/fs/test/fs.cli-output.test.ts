import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Log } from '@spinajs/log-common';
import '@spinajs/templates-pug';
import { fs, FsBootsrapper, fsService } from '../src/index.js';
import { captureStdio as run, TestConfiguration } from './common.js';

import { FsDescribeCommand } from '../src/cli/fs.js';
import { FsLsCommand } from '../src/cli/ls.js';
import { FsStatCommand } from '../src/cli/stat.js';
import { FsCatCommand } from '../src/cli/cat.js';
import { FsExistsCommand } from '../src/cli/exists.js';
import { FsHashCommand } from '../src/cli/hash.js';
import { FsInfoCommand } from '../src/cli/info.js';
import { FsDownloadCommand } from '../src/cli/download.js';

const lines = (text: string) => text.split(/\r?\n/).filter((l) => l !== '');

describe('fs cli commands: result on stdout, log lines on stderr', function () {
  this.timeout(15000);

  const originalExitCode = process.exitCode;

  // The other suites of this package share the fs service and its providers, so the configuration stays theirs and
  // only the commands' `fs` logger gets a console target, as an application's development config has it.
  before(async () => {
    DI.resolve(FsBootsrapper).bootstrap();
    if (!DI.has(Configuration)) {
      DI.register(TestConfiguration).as(Configuration);
    }
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    DI.resolve(Log, ['fs']).addTarget({ name: 'CliOutputConsole', type: 'ConsoleTarget' }, { level: 'info' });
  });

  beforeEach(async () => {
    const t = await DI.resolve<fs>('__file_provider__', ['test']);
    await t.mkdir('cli-output');
    await t.write('cli-output/hello.txt', 'hello world', 'utf-8');
  });

  afterEach(async () => {
    sinon.restore();
    process.exitCode = originalExitCode;
    const t = await DI.resolve<fs>('__file_provider__', ['test']);
    await t.rm('cli-output');
  });

  after(async () => {
    await DI.resolve(Log, ['fs']).removeTarget('CliOutputConsole');
  });

  it('fs-describe', async () => {
    const cmd = await DI.resolve(FsDescribeCommand);
    const { stdout, stderr } = await run(() => cmd.execute());

    expect(lines(stdout)).to.not.be.empty;
    expect(lines(stdout).every((l) => l.startsWith("Filesystem '"))).to.eq(true, stdout);
    expect(stdout).to.contain("Filesystem 'test'");
    expect(stderr).to.not.contain('Filesystem');
  });

  it('fs-ls', async () => {
    const cmd = await DI.resolve(FsLsCommand);
    const { stdout, stderr } = await run(() => cmd.execute('test', 'cli-output'));

    expect(lines(stdout)).to.eql(['hello.txt']);
    expect(stderr).to.contain('1 entries in cli-output ( fs: test ):');
  });

  it('fs-stat', async () => {
    const cmd = await DI.resolve(FsStatCommand);
    const { stdout, stderr } = await run(() => cmd.execute('test', 'cli-output/hello.txt'));

    expect(lines(stdout).map((l) => l.split(':')[0])).to.eql(['type', 'size', 'created', 'modified', 'accessed']);
    expect(lines(stdout).slice(0, 2)).to.eql(['type: file', 'size: 11 bytes']);
    expect(stderr).to.contain('Stat for cli-output/hello.txt ( fs: test ):');
    expect(stderr).to.not.contain('size:');
  });

  it('fs-cat prints the file content and logs a failure on stderr only', async () => {
    const cmd = await DI.resolve(FsCatCommand);

    const ok = await run(() => cmd.execute('test', 'cli-output/hello.txt', { encoding: 'utf-8' }));
    expect(ok.stdout).to.equal('hello world');
    expect(ok.stderr).to.not.contain('hello world');

    const failed = await run(() => cmd.execute('test', 'cli-output/missing.txt', { encoding: 'utf-8' }));
    expect(failed.stdout).to.equal('');
    expect(failed.stderr).to.contain('Cannot read cli-output/missing.txt on test');
    expect(process.exitCode).to.eq(1);
  });

  it('fs-exists', async () => {
    const cmd = await DI.resolve(FsExistsCommand);
    const { stdout, stderr } = await run(() => cmd.execute('test', 'cli-output/hello.txt'));

    expect(lines(stdout)).to.eql(['cli-output/hello.txt exists ( fs: test )']);
    expect(stderr).to.not.contain('exists');
  });

  it('fs-hash', async () => {
    const cmd = await DI.resolve(FsHashCommand);
    const { stdout, stderr } = await run(() => cmd.execute('test', 'cli-output/hello.txt', { algo: 'sha256' }));

    expect(lines(stdout)).to.eql(['sha256(cli-output/hello.txt) = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9']);
    expect(stderr).to.not.contain('b94d27b9');
  });

  it('fs-download prints the local path alone on stdout', async () => {
    const t = await DI.resolve<fs>('__file_provider__', ['test']);
    const cmd = await DI.resolve(FsDownloadCommand);
    const { stdout, stderr } = await run(() => cmd.execute('test', 'cli-output/hello.txt'));

    expect(lines(stdout)).to.eql([t.resolvePath('cli-output/hello.txt')]);
    expect(stderr).to.contain('Downloaded cli-output/hello.txt ( fs: test )');
  });

  it('fs-info prints the metadata as one JSON document', async () => {
    const t = await DI.resolve<fs>('__file_provider__', ['test']);
    sinon.stub(t, 'metadata').resolves({ FileSize: 11 });

    const cmd = await DI.resolve(FsInfoCommand);
    const { stdout, stderr } = await run(() => cmd.execute('test', 'cli-output/hello.txt'));

    expect(JSON.parse(stdout)).to.eql({ FileSize: 11 });
    expect(stderr).to.contain('Info for cli-output/hello.txt ( fs: test ):');
  });
});
