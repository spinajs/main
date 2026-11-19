import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { expect } from 'chai';
import 'mocha';
import { join, resolve } from 'path';
import { ListFromFiles } from './../src/index.js';

const PACKAGE_GUESS = resolve(join(process.cwd(), 'node_modules', '@spinajs', 'not-installed', 'lib', 'mjs', 'cli'));
// spelled out with each separator, so the classification does not depend on the platform the test runs on
const WINDOWS_PACKAGE_GUESS = 'C:\\nowhere\\app\\node_modules\\@spinajs\\not-installed\\lib\\mjs\\cli';
const POSIX_PACKAGE_GUESS = '/nowhere/app/node_modules/@spinajs/not-installed/lib/mjs/cli';
const WINDOWS_APP_DIR = 'C:\\nowhere\\app\\controllers';
const LOOKALIKE_DIR = '/nowhere/app/my_node_modules_backup';
const WINDOWS_LOOKALIKE_DIR = 'C:\\nowhere\\app\\my_node_modules_backup';
const APP_DIR = resolve(join(process.cwd(), 'test', 'not-created-by-the-app'));

const lines: Array<{ level: string; directory: unknown }> = [];

/** Records the level of each "not exists" line; registered as the Log implementation the scanner resolves. */
class RecordingLog {
  public debug(vars: { directory: unknown }) {
    lines.push({ level: 'debug', directory: vars.directory });
  }

  public warn(vars: { directory: unknown }) {
    lines.push({ level: 'warn', directory: vars.directory });
  }

  public trace() {}
}

class MissingDirsCfg extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      system: {
        dirs: {
          missing: [PACKAGE_GUESS, APP_DIR],
          separators: [WINDOWS_PACKAGE_GUESS, POSIX_PACKAGE_GUESS, WINDOWS_APP_DIR],
          lookalike: [LOOKALIKE_DIR, WINDOWS_LOOKALIKE_DIR],
        },
      },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
    };
  }
}

describe('a missing directory in a scanned dirs list', () => {
  before(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(MissingDirsCfg).as(Configuration);
    DI.register(RecordingLog).as(Log);
    await DI.resolve(Configuration);
  });

  after(() => {
    DI.unregister(RecordingLog);
    DI.unregister(MissingDirsCfg);
    DI.clearCache();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it("logs a package's guessed install directory at debug and the application's own directory at warn", async () => {
    const target = { found: undefined as unknown };
    ListFromFiles('/**/*.{ts,js}', 'system.dirs.missing')(target, 'found');

    expect(await target.found).to.eql([]);
    expect(lines).to.eql([
      { level: 'debug', directory: PACKAGE_GUESS },
      { level: 'warn', directory: APP_DIR },
    ]);
  });

  it('finds the node_modules segment with backslash and with slash separators', async () => {
    const target = { found: undefined as unknown };
    ListFromFiles('/**/*.{ts,js}', 'system.dirs.separators')(target, 'found');

    expect(await target.found).to.eql([]);
    expect(lines).to.eql([
      { level: 'debug', directory: WINDOWS_PACKAGE_GUESS },
      { level: 'debug', directory: POSIX_PACKAGE_GUESS },
      { level: 'warn', directory: WINDOWS_APP_DIR },
    ]);
  });

  it('still warns for a directory whose name only contains "node_modules"', async () => {
    const target = { found: undefined as unknown };
    ListFromFiles('/**/*.{ts,js}', 'system.dirs.lookalike')(target, 'found');

    expect(await target.found).to.eql([]);
    expect(lines).to.eql([
      { level: 'warn', directory: LOOKALIKE_DIR },
      { level: 'warn', directory: WINDOWS_LOOKALIKE_DIR },
    ]);
  });
});
