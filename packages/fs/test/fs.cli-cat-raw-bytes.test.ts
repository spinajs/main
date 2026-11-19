import 'mocha';
import { expect } from 'chai';

import { Cli } from '@spinajs/cli';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/templates-pug';
import { fs, FsBootsrapper, fsService } from '../src/index.js';
import { FsCatCommand } from '../src/cli/cat.js';
import { captureStdio, dir, TestConfiguration } from './common.js';

/** Not valid UTF-8 ( 0xff, a lone 0xc3 ) and a NUL byte. */
const BYTES = Buffer.from([0x68, 0x69, 0xff, 0x00, 0xc3, 0x0a]);

describe('fs-cat and a file that is not UTF-8 text', function () {
  this.timeout(30000);

  let previousCliDirs: unknown;
  let hadEsmMode: boolean;
  let hadArgvProvider: boolean;

  before(async () => {
    hadEsmMode = DI.get('__esmMode__') !== null;
    hadArgvProvider = DI.check('__cli_argv_provider__');

    // the command scan imports the command files, as the bin does
    DI.setESMModuleSupport();
    DI.resolve(FsBootsrapper).bootstrap();
    if (!DI.has(Configuration)) {
      DI.register(TestConfiguration).as(Configuration);
    }
    await DI.resolve(Configuration);
    await DI.resolve(fsService);

    previousCliDirs = DI.get(Configuration)!.get('system.dirs.cli');
  });

  beforeEach(async () => {
    const t = await DI.resolve<fs>('__file_provider__', ['test']);
    await t.mkdir('cli-raw');
    await t.write('cli-raw/data.bin', BYTES);
  });

  afterEach(async () => {
    const t = await DI.resolve<fs>('__file_provider__', ['test']);
    await t.rm('cli-raw');
  });

  after(() => {
    DI.get(Configuration)?.set('system.dirs.cli', previousCliDirs);
    if (!hadArgvProvider) {
      DI.unregister('__cli_argv_provider__');
    }
    if (!hadEsmMode) {
      DI.uncache('__esmMode__');
    }
  });

  // through commander, which is where an option's default value is applied
  it('writes the bytes unchanged when run without --encoding', async () => {
    DI.get(Configuration)!.set('system.dirs.cli', [dir('../src/cli')]);
    // Cli reads the argv provider from the root container
    DI.register(() => ['node', 'spinajs', 'fs-cat', 'test', 'cli-raw/data.bin']).as('__cli_argv_provider__');

    const { stdoutBytes } = await captureStdio(() => DI.child().resolve(Cli));

    expect(stdoutBytes.toString('hex')).to.equal(BYTES.toString('hex'));
  });

  it('decodes the file with --encoding, as before', async () => {
    const cmd = await DI.resolve(FsCatCommand);
    const { stdout } = await captureStdio(() => cmd.execute('test', 'cli-raw/data.bin', { encoding: 'latin1' }));

    expect(stdout).to.equal(BYTES.toString('latin1'));
  });
});
