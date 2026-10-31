import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@spinajs/manifest';

const FIXTURES = fileURLToPath(new URL('../../compiler/test/fixtures/', import.meta.url));
const APP = join(FIXTURES, 'app-dirs');
const TMP = join(FIXTURES, '.tmp-cli-build');
const LINK = join(FIXTURES, '.tmp-cli-build-current');
const CLI_PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(CLI_PACKAGE, 'lib', 'cli.js');
const MANIFEST = join(TMP, 'app.manifest.json');
const APP_CONFIG = join(TMP, 'lib', 'config', 'app.js');

const LOADED_CONTROLLERS = ['BarrelledController', 'KeptController', 'NestedController', 'StarController'];

// Written the way an app ships it. No `migrations` key: the app relies on the orm's default dirs. `spinajs` itself has no
// logger implementation: an app's import of @spinajs/log registers it.
const config = (dirs: string, base = "join(process.cwd(), 'lib')"): string => `
import '@spinajs/log';
import { join } from 'node:path';

const built = (name) => [join(${base}, name)];

export default { system: { dirs: ${dirs} } };
`;

const ALL_DIRS = "{ controllers: built('controllers'), socketControllers: built('sockets'), schedules: built('schedules'), cli: built('commands') }";
const CONFIG = config(ALL_DIRS);
const NO_DIRS = "import '@spinajs/log';\nexport default {};\n";

interface Run {
  status: number | null;
  output: string;
}

function spinajs(args: string[] = [], env: NodeJS.ProcessEnv = {}, cwd = TMP): Run {
  const run = spawnSync(process.execPath, [BIN, 'build', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 110_000,
    env: { ...process.env, WORKSPACE_ROOT_PATH: undefined, NODE_OPTIONS: undefined, APP_ENV: 'test', ...env },
  });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

function manifestOf(run: Run, file = MANIFEST): Manifest {
  if (!existsSync(file)) throw new Error(`no manifest (${String(run.status)}):\n${run.output}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

function built(args: string[] = [], env: NodeJS.ProcessEnv = {}, cwd = TMP): Run & { manifest: Manifest } {
  rmSync(MANIFEST, { force: true });
  const run = spinajs(args, env, cwd);
  return { ...run, manifest: manifestOf(run) };
}

type Entry = { className: string; mountedBy?: string; source: { package: string } };

const own = (entries: Entry[]): Entry[] => entries.filter((e) => e.source.package === 'app-dirs');
const loaded = (entries: Entry[]): string[] => own(entries).filter((e) => e.mountedBy === undefined).map((e) => e.className).sort();
const flagged = (entries: Entry[]): string[] => own(entries).filter((e) => e.mountedBy === 'di').map((e) => e.className).sort();

describe('spinajs build reads the dirs the app runs with', function () {
  this.timeout(120_000);

  before(() => {
    rmSync(LINK, { force: true });
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(TMP, 'lib', 'config'), { recursive: true });
    cpSync(join(APP, 'src'), join(TMP, 'src'), { recursive: true });
    cpSync(join(APP, 'tsconfig.json'), join(TMP, 'tsconfig.json'));
    // `workspaces` makes it a root: the configuration walk does not climb into the repo above it
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'app-dirs', version: '1.0.0', type: 'module', main: 'lib/index.js', workspaces: [], dependencies: { '@spinajs/cli': '*', '@spinajs/log': '*' } }));
    for (const name of ['cli', 'log']) {
      const link = join(TMP, 'node_modules', '@spinajs', name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(realpathSync(join(CLI_PACKAGE, '..', name)), link, 'junction');
    }
    symlinkSync(TMP, LINK, 'junction');
  });

  beforeEach(() => {
    writeFileSync(APP_CONFIG, CONFIG);
  });

  after(() => {
    rmSync(LINK, { force: true });
    rmSync(TMP, { recursive: true, force: true });
  });

  it('flags a class outside the dirs, prints why, and keeps migrations under the default dirs', () => {
    const { manifest, output, status } = built();
    expect(status).to.equal(0);
    expect(loaded(manifest.controllers)).to.deep.equal(LOADED_CONTROLLERS);
    expect(flagged(manifest.controllers)).to.include.members(['ElsewhereController', 'RegisteredController', 'InjectableNeverImported', 'DebugController', 'AdminController']);
    expect(loaded(manifest.socketControllers)).to.deep.equal(['KeptSocket']);
    expect(loaded(manifest.schedules)).to.deep.equal(['KeptTask']);
    expect(loaded(manifest.commands)).to.deep.equal(['KeptCommand']);
    expect(loaded(manifest.migrations)).to.deep.equal(['Kept_2026_01_01_00_00_00']);
    expect(output).to.match(/^warning CMP006 src\/elsewhere\/ElsewhereController\.ts:\d+ ElsewhereController .*src\/controllers\b.*system\.dirs\.controllers/m);
    expect(output).to.match(new RegExp(`controllers\\s+${LOADED_CONTROLLERS.length}\\b`));
    expect(output).to.match(/not loaded\s+[1-9]/);
  });

  it('loads a RunApp layout, through the dir applyAppDirs adds for --app and --apppath', () => {
    expect(flagged(built().manifest.controllers)).to.include('ShopController');
    expect(loaded(built(['--app', 'shop', '--apppath', 'lib/apps']).manifest.controllers)).to.include('ShopController');
  });

  it('reads an extra config folder from --config-path, as the app gets it from cfgCustomPaths', () => {
    mkdirSync(join(TMP, 'lib', 'deploy'), { recursive: true });
    writeFileSync(join(TMP, 'lib', 'deploy', 'tenant.js'), config("{ controllers: built('apps/shop/controllers') }"));
    expect(flagged(built().manifest.controllers)).to.include('ShopController');
    expect(loaded(built(['--config-path', 'lib/deploy']).manifest.controllers)).to.include('ShopController');
  });

  it('reflects the config of the APP_ENV of the build', () => {
    const prod = join(TMP, 'lib', 'config', 'app.prod.js');
    writeFileSync(prod, config("{ controllers: built('elsewhere') }"));
    try {
      expect(flagged(built([], { APP_ENV: 'test' }).manifest.controllers)).to.include('ElsewhereController');
      expect(loaded(built([], { APP_ENV: 'production' }).manifest.controllers)).to.include('ElsewhereController');
    } finally {
      rmSync(prod);
    }
  });

  describe('when a section has no dir', () => {
    it('takes an unset section for an empty one when another section maps into the app: the config was read', () => {
      writeFileSync(APP_CONFIG, config("{ schedules: built('schedules') }"));
      const { manifest, output, status } = built();
      expect(status).to.equal(0);
      expect(loaded(manifest.schedules)).to.deep.equal(['KeptTask']);
      expect(loaded(manifest.controllers)).to.deep.equal([]);
      expect(flagged(manifest.controllers)).to.include('KeptController');
      expect(output).to.match(/^warning CMP006 src\/controllers\/KeptController\.ts:\d+ .*system\.dirs\.controllers names no source folder/m);
    });

    it('refuses to build when nothing maps into the app, and writes nothing', () => {
      writeFileSync(APP_CONFIG, NO_DIRS);
      writeFileSync(MANIFEST, 'the previous manifest');
      const { output, status } = spinajs();
      expect(status).to.equal(1);
      expect(readFileSync(MANIFEST, 'utf8')).to.equal('the previous manifest');
      expect(output).to.match(/^error CMP007 - no system\.dirs entry maps to a source folder of this app\. Searched none/m);
      expect(output).to.include('--allow-no-dirs');
    });

    it('names what it searched when a dir does not map', () => {
      writeFileSync(APP_CONFIG, config("{ controllers: built('mjs/controllers') }"));
      rmSync(MANIFEST, { force: true });
      const { output, status } = spinajs();
      expect(status).to.equal(1);
      expect(output).to.include('Searched controllers: lib/mjs/controllers');
      expect(existsSync(MANIFEST)).to.equal(false);
    });

    it('does not take the default migration dirs for evidence: they exist without any config', () => {
      writeFileSync(APP_CONFIG, NO_DIRS);
      expect(existsSync(join(TMP, 'src', 'migrations'))).to.equal(true);
      expect(spinajs().status).to.equal(1);
    });

    it('takes configured migrations for evidence', () => {
      writeFileSync(APP_CONFIG, config("{ migrations: built('migrations') }"));
      const { manifest, status } = built();
      expect(status).to.equal(0);
      expect(loaded(manifest.migrations)).to.deep.equal(['Kept_2026_01_01_00_00_00']);
      expect(loaded(manifest.controllers)).to.deep.equal([]);
    });

    it('--allow-no-dirs builds a deliberate no-dirs app: nothing loads from the manifest, as nothing does in discovery', () => {
      writeFileSync(APP_CONFIG, NO_DIRS);
      const { manifest, status } = built(['--allow-no-dirs']);
      expect(status).to.equal(0);
      expect(loaded(manifest.controllers)).to.deep.equal([]);
      expect(loaded(manifest.migrations)).to.deep.equal(['Kept_2026_01_01_00_00_00']);
      expect(flagged(manifest.controllers)).to.include('KeptController');
    });
  });

  describe('when the working directory is not the app root', () => {
    const fromLib = ['--tsconfig', '../tsconfig.json', '--out', '../app.manifest.json'];

    it('warns but builds for an app that runs from its build folder, whose dirs are right from there', () => {
      writeFileSync(APP_CONFIG, config(ALL_DIRS, 'process.cwd()'));
      const { manifest, output, status } = built(fromLib, {}, join(TMP, 'lib'));
      expect(status).to.equal(0);
      expect(loaded(manifest.controllers)).to.deep.equal(LOADED_CONTROLLERS);
      expect(output).to.match(/^warning CLI001 - .*working directory/m);
    });

    it('--fail-on-warning turns that warning into exit 1', () => {
      writeFileSync(APP_CONFIG, config(ALL_DIRS, 'process.cwd()'));
      expect(spinajs([...fromLib, '--fail-on-warning'], {}, join(TMP, 'lib')).status).to.equal(1);
    });

    it('refuses when the dirs computed from there name no source folder, instead of dropping every class', () => {
      rmSync(MANIFEST, { force: true });
      const { output, status } = spinajs(fromLib, {}, join(TMP, 'lib'));
      expect(status).to.equal(1);
      expect(output).to.match(/^warning CLI001 - /m);
      expect(output).to.match(/^error CMP007 - /m);
      expect(existsSync(MANIFEST)).to.equal(false);
    });
  });

  describe('through a symlinked release folder', () => {
    it('maps physical dirs onto a logical --tsconfig', () => {
      const { manifest, output, status } = built(['--tsconfig', join(LINK, 'tsconfig.json')]);
      expect(status).to.equal(0);
      expect(loaded(manifest.controllers)).to.deep.equal(LOADED_CONTROLLERS);
      expect(output).to.not.include('CLI001');
    });

    it('maps logical dirs onto a physical --tsconfig', () => {
      writeFileSync(APP_CONFIG, config(ALL_DIRS, `${JSON.stringify(join(LINK, 'lib'))}`));
      const { manifest, status } = built();
      expect(status).to.equal(0);
      expect(loaded(manifest.controllers)).to.deep.equal(LOADED_CONTROLLERS);
    });
  });

  it('reads the same dirs in a process that booted from the previous manifest', () => {
    built();
    const reused = join(TMP, 'previous.manifest.json');
    writeFileSync(reused, readFileSync(MANIFEST, 'utf8'));
    mkdirSync(join(TMP, 'lib', 'commands'), { recursive: true });
    writeFileSync(join(TMP, 'lib', 'commands', 'KeptCommand.js'), 'export class KeptCommand {}\n');

    const { manifest } = built(['--out', 'app.manifest.json'], { SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: reused });
    expect(loaded(manifest.controllers)).to.deep.equal(LOADED_CONTROLLERS);
  });
});
