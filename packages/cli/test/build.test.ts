import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultMigrationDirs, type Configuration } from '@spinajs/configuration';
import type { Manifest } from '@spinajs/manifest';
import { Build } from '../src/cli/Build.js';

const fixtures = fileURLToPath(new URL('../../compiler/test/fixtures/', import.meta.url));
const appBasic = join(fixtures, 'app-basic/tsconfig.json');
const reportWarning = join(fixtures, 'report-warning/tsconfig.build.json');

class Captured extends Build {
  public output = '';
  protected override write(text: string): void {
    this.output += text;
  }
}

/** What `system.dirs` holds decides what reaches the compiler; a real configuration is exercised in build-effective-dirs.test.ts. */
class WithDirs extends Captured {
  public received?: { effectiveDirs?: Record<string, string[]> };

  public constructor(dirs: unknown) {
    super();
    this.Config = { get: (_path: string[], fallback: unknown) => dirs ?? fallback } as unknown as Configuration;
  }

  protected override importCompiler(): ReturnType<Build['importCompiler']> {
    const manifest = { diagnostics: [], services: [], controllers: [], models: [], schemas: {} };
    const buildAppManifest = (options: WithDirs['received']) => {
      this.received = options;
      return Promise.resolve({ manifest, written: 'app.manifest.json' });
    };
    return Promise.resolve({ buildAppManifest, summarize: () => ({ error: 0, warning: 0, info: 0 }) } as unknown as Awaited<ReturnType<Build['importCompiler']>>);
  }
}

describe('build', function () {
  this.timeout(120000);

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spinajs-build-'));
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('writes app.manifest.json for the app and prints a summary', async () => {
    const out = join(dir, 'app.manifest.json');
    const cmd = new Captured();
    await cmd.execute({ tsconfig: appBasic, out, schemas: true });

    const manifest = JSON.parse(readFileSync(out, 'utf8')) as Manifest;
    expect(manifest.app.name).to.equal('app-basic');
    expect(manifest.controllers.length).to.be.greaterThan(0);
    expect(cmd.output).to.match(/controllers\s+\d+/);
    expect(cmd.output).to.match(/routes\s+\d+/);
    expect(cmd.output).to.match(/diagnostics\s+\d+ error\(s\), \d+ warning\(s\), \d+ info/);
    expect(process.exitCode).to.equal(undefined);
  });

  it('--no-schemas derives fewer schemas than the default', async () => {
    const read = (file: string) => Object.keys((JSON.parse(readFileSync(file, 'utf8')) as Manifest).schemas);
    await new Captured().execute({ tsconfig: appBasic, out: join(dir, 'on.json'), schemas: true });
    await new Captured().execute({ tsconfig: appBasic, out: join(dir, 'off.json'), schemas: false });
    expect(read(join(dir, 'off.json')).length).to.be.lessThan(read(join(dir, 'on.json')).length);
  });

  it('exits 0 on warnings and prints them as "warning CODE file:line message"', async () => {
    const cmd = new Captured();
    await cmd.execute({ tsconfig: reportWarning, out: join(dir, 'm.json'), schemas: true });
    expect(cmd.output).to.match(/^warning SCH001 src\/index\.ts:\d+ .+$/m);
    expect(process.exitCode).to.equal(undefined);
  });

  it('--fail-on-warning exits 1 when a warning is reported', async () => {
    const cmd = new Captured();
    await cmd.execute({ tsconfig: reportWarning, out: join(dir, 'm.json'), schemas: true, failOnWarning: true });
    expect(process.exitCode).to.equal(1);
    expect(existsSync(join(dir, 'm.json'))).to.equal(true);
  });

  describe('the dirs it hands to the compiler', () => {
    const handed = async (dirs: unknown): Promise<Record<string, string[]> | undefined> => {
      const cmd = new WithDirs(dirs);
      await cmd.execute({ tsconfig: appBasic, out: join(dir, 'm.json') });
      return cmd.received?.effectiveDirs;
    };

    it('hands over nothing without a configuration: a command built by hand stays unfiltered', async () => {
      const cmd = new Captured();
      await cmd.execute({ tsconfig: appBasic, out: join(dir, 'm.json'), schemas: false });
      expect((JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8')) as Manifest).diagnostics.filter((d) => /^CMP00[67]$/.test(d.code))).to.deep.equal([]);
    });

    it('reads every system.dirs key as absolute paths from the working directory, as a scan does', async () => {
      const absolute = resolve('elsewhere', 'controllers');
      const dirs = await handed({ controllers: [absolute, 'lib/controllers'], cli: ['lib/cli'], locales: ['lib/locales'] });
      expect(dirs?.controllers).to.deep.equal([absolute, resolve('lib/controllers')]);
      expect(dirs?.cli).to.deep.equal([resolve('lib/cli')]);
    });

    it('takes a single string, which a scan accepts too, and ignores what is no path', async () => {
      const dirs = await handed({ schedules: 'lib/schedules', controllers: [null, 7, 'lib/controllers'], cli: 3 });
      expect(dirs?.schedules).to.deep.equal([resolve('lib/schedules')]);
      expect(dirs?.controllers).to.deep.equal([resolve('lib/controllers')]);
      expect(dirs?.cli).to.deep.equal([]);
    });

    for (const [title, dirs] of [
      ['empty', { migrations: [] }],
      ['absent', {}],
      ['not configured at all', undefined],
    ] as Array<[string, unknown]>) {
      it(`gives migrations the orm's default dirs when the key is ${title}`, async () => {
        expect((await handed(dirs))?.migrations).to.deep.equal(defaultMigrationDirs());
      });
    }

    it('keeps configured migrations, which replace the defaults', async () => {
      expect((await handed({ migrations: ['db/migrations'] }))?.migrations).to.deep.equal([resolve('db/migrations')]);
    });
  });
});
