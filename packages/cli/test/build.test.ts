import 'mocha';
import { expect } from 'chai';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultMigrationDirs, type Configuration } from '@spinajs/configuration';
import type { Manifest } from '@spinajs/manifest';
import { Build } from '../src/cli/Build.js';
import { stripFrameworkOptions } from '../src/argv.js';

const fixtures = fileURLToPath(new URL('../../compiler/test/fixtures/', import.meta.url));
const appBasic = join(fixtures, 'app-basic/tsconfig.json');
const reportWarning = join(fixtures, 'report-warning/tsconfig.build.json');
const minimalManifest = (): Manifest => JSON.parse(readFileSync(fileURLToPath(new URL('../../manifest/test/fixtures/minimal.manifest.json', import.meta.url)), 'utf8')) as Manifest;

class Captured extends Build {
  public output = '';
  protected override write(text: string): void {
    this.output += text;
  }
}

/** What `system.dirs` holds decides what reaches the compiler; a real configuration is exercised in build-effective-dirs.test.ts. */
class WithDirs extends Captured {
  public received?: { effectiveDirs?: Record<string, string[]>; defaultDirs?: Record<string, string[]>; requireAppDirs?: boolean };

  public constructor(dirs: unknown) {
    super();
    this.Config = { get: (_path: string[], fallback: unknown) => dirs ?? fallback } as unknown as Configuration;
  }

  protected override importCompiler(): ReturnType<Build['importCompiler']> {
    const buildAppManifest = (options: WithDirs['received'] & { out: string }) => {
      this.received = options;
      return Promise.resolve({ manifest: this.built(), written: options.out });
    };
    return Promise.resolve({ buildAppManifest, summarize: () => ({ error: 0, warning: 0, info: 0 }), NoAppDirs: class extends Error {} } as unknown as Awaited<ReturnType<Build['importCompiler']>>);
  }

  protected built(): Manifest {
    return minimalManifest();
  }
}

/** A compiler that writes the manifest it returns, as the real one does. */
class Writes extends WithDirs {
  public constructor() {
    super(undefined);
  }

  protected override importCompiler(): ReturnType<Build['importCompiler']> {
    return super.importCompiler().then((compiler) => ({
      ...compiler,
      buildAppManifest: async (options: Parameters<typeof compiler.buildAppManifest>[0]) => {
        const built = await compiler.buildAppManifest(options);
        writeFileSync(built.written, JSON.stringify(built.manifest));
        return built;
      },
    }));
  }
}

/** A compiler that writes a manifest its own schema refuses. */
class WritesInvalid extends Writes {
  protected override built(): Manifest {
    return { ...minimalManifest(), app: { ...minimalManifest().app, name: 42 as unknown as string } };
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

  // The runtime trusts a manifest whose hash matches without checking its schema again, so the build checks it.
  it('refuses and removes a manifest that fails the manifest schema', async () => {
    const out = join(dir, 'm.json');
    const cmd = new WritesInvalid();
    await cmd.execute({ tsconfig: appBasic, out });
    expect(cmd.output).to.match(/^error CLI002 - .*\$\.app\.name/m);
    expect(process.exitCode).to.equal(1);
    expect(existsSync(out)).to.equal(false);
  });

  it('keeps a manifest that passes the manifest schema', async () => {
    const out = join(dir, 'm.json');
    const cmd = new Writes();
    await cmd.execute({ tsconfig: appBasic, out });
    expect(cmd.output).to.not.include('CLI002');
    expect(process.exitCode).to.equal(undefined);
    expect(existsSync(out)).to.equal(true);
  });

  it('--config-path never reaches a command', () => {
    expect(stripFrameworkOptions(['node', 'spinajs', 'build', '--config-path', 'deploy', '--config-path=other', '--out', 'x'])).to.deep.equal(['node', 'spinajs', 'build', '--out', 'x']);
  });

  describe('the dirs it hands to the compiler', () => {
    const received = async (dirs: unknown, allowNoDirs?: boolean): Promise<WithDirs['received']> => {
      const cmd = new WithDirs(dirs);
      await cmd.execute({ tsconfig: appBasic, out: join(dir, 'm.json'), allowNoDirs });
      return cmd.received;
    };
    const handed = async (dirs: unknown): Promise<Record<string, string[]> | undefined> => (await received(dirs))?.effectiveDirs;

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
      it(`hands the orm's default dirs apart from the config when the key is ${title}: they prove nothing`, async () => {
        const options = await received(dirs);
        expect(options?.defaultDirs?.migrations).to.deep.equal(defaultMigrationDirs());
        expect(options?.effectiveDirs?.migrations ?? []).to.deep.equal([]);
      });
    }

    it('keeps configured migrations, which replace the defaults', async () => {
      expect((await handed({ migrations: ['db/migrations'] }))?.migrations).to.deep.equal([resolve('db/migrations')]);
    });

    it('requires a dir in the app unless --allow-no-dirs says otherwise', async () => {
      expect((await received({}))?.requireAppDirs).to.equal(true);
      expect((await received({}, true))?.requireAppDirs).to.equal(false);
    });
  });

  it('hands the global route middlewares of the configuration to the compiler', async () => {
    const entries = ['RouteTiming', { service: 'Audit', options: [1] }];
    const cmd = new WithDirs(undefined);
    const values: Record<string, unknown> = { 'http.routes.middlewares': entries };
    cmd['Config'] = { get: (path: string | string[], fallback: unknown) => values[[path].flat().join('.')] ?? fallback } as unknown as Configuration;
    await cmd.execute({ tsconfig: appBasic, out: join(dir, 'm.json') });
    expect((cmd.received as { globalRouteMiddlewares?: unknown })?.globalRouteMiddlewares).to.deep.equal(entries);
  });
});
