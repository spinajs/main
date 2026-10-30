import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@spinajs/manifest';

const FIXTURES = fileURLToPath(new URL('../../compiler/test/fixtures/', import.meta.url));
const APP = join(FIXTURES, 'app-dirs');
const TMP = join(FIXTURES, '.tmp-cli-build');
const CLI_PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(CLI_PACKAGE, 'lib', 'cli.js');
const MANIFEST = join(TMP, 'app.manifest.json');

// Written the way an app ships it. No `migrations` key: the app relies on the orm's default dirs. `spinajs` itself has no
// logger implementation: an app's import of @spinajs/log registers it.
const CONFIG = `
import '@spinajs/log';
import { join } from 'node:path';

const built = (name) => [join(process.cwd(), 'lib', name)];

export default {
  system: { dirs: { controllers: built('controllers'), socketControllers: built('sockets'), schedules: built('schedules'), cli: built('commands') } },
};
`;

const PROD_CONFIG = `
import { join } from 'node:path';

export default { system: { dirs: { controllers: [join(process.cwd(), 'lib', 'elsewhere')] } } };
`;

interface Run {
  status: number | null;
  output: string;
  manifest: Manifest;
}

function spinajs(args: string[] = [], env: NodeJS.ProcessEnv = {}): Run {
  rmSync(MANIFEST, { force: true });
  const run = spawnSync(process.execPath, [BIN, 'build', ...args], {
    cwd: TMP,
    encoding: 'utf8',
    timeout: 110_000,
    env: { ...process.env, WORKSPACE_ROOT_PATH: undefined, NODE_OPTIONS: undefined, APP_ENV: 'test', ...env },
  });
  const output = `${run.stdout}\n${run.stderr}`;
  try {
    return { status: run.status, output, manifest: JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest };
  } catch {
    throw new Error(`no manifest (${String(run.status)}):\n${output}`);
  }
}

const own = (entries: Array<{ className: string; source: { package: string } }>): string[] => entries.filter((e) => e.source.package === 'app-dirs').map((e) => e.className).sort();

describe('spinajs build reads the dirs the app runs with', function () {
  this.timeout(120_000);

  before(() => {
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
  });

  beforeEach(() => {
    writeFileSync(join(TMP, 'lib', 'config', 'app.js'), CONFIG);
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('drops a class outside the dirs, prints why, and keeps migrations under the default dirs', () => {
    const { manifest, output, status } = spinajs();
    expect(status).to.equal(0);
    expect(own(manifest.controllers)).to.deep.equal(['KeptController', 'NestedController', 'RegisteredController']);
    expect(own(manifest.socketControllers)).to.deep.equal(['KeptSocket']);
    expect(own(manifest.schedules)).to.deep.equal(['KeptTask']);
    expect(own(manifest.commands)).to.deep.equal(['KeptCommand']);
    expect(own(manifest.migrations)).to.deep.equal(['Kept_2026_01_01_00_00_00']);
    expect(output).to.match(/^warning CMP006 src\/elsewhere\/ElsewhereController\.ts:\d+ ElsewhereController .*system\.dirs\.controllers searches src\/controllers\b/m);
  });

  it('keeps a RunApp layout, through the dir applyAppDirs adds for --app and --apppath', () => {
    expect(own(spinajs().manifest.controllers)).to.not.include('ShopController');
    expect(own(spinajs(['--app', 'shop', '--apppath', 'lib/apps']).manifest.controllers)).to.include('ShopController');
  });

  it('reflects the config of the APP_ENV of the build', () => {
    writeFileSync(join(TMP, 'lib', 'config', 'app.prod.js'), PROD_CONFIG);
    try {
      expect(own(spinajs([], { APP_ENV: 'test' }).manifest.controllers)).to.not.include('ElsewhereController');
      expect(own(spinajs([], { APP_ENV: 'production' }).manifest.controllers)).to.include('ElsewhereController');
    } finally {
      rmSync(join(TMP, 'lib', 'config', 'app.prod.js'));
    }
  });

  it('does not empty the manifest when the dirs of the app are not in the config it can read', () => {
    writeFileSync(join(TMP, 'lib', 'config', 'app.js'), "import '@spinajs/log';\nexport default {};\n");
    const { manifest, output } = spinajs();
    expect(own(manifest.controllers)).to.include.members(['KeptController', 'ElsewhereController']);
    expect(own(manifest.schedules)).to.include.members(['KeptTask', 'ElsewhereTask']);
    expect(output).to.match(/^warning CMP007 src\/controllers\/KeptController\.ts:\d+ /m);
    expect(spinajs(['--fail-on-warning']).status).to.equal(1);
  });

  it('reads the same dirs in a process that booted from the previous manifest', () => {
    spinajs();
    const previous = readFileSync(MANIFEST, 'utf8');
    const reused = join(TMP, 'previous.manifest.json');
    writeFileSync(reused, previous);
    mkdirSync(join(TMP, 'lib', 'commands'), { recursive: true });
    writeFileSync(join(TMP, 'lib', 'commands', 'KeptCommand.js'), 'export class KeptCommand {}\n');

    const { manifest } = spinajs(['--out', 'app.manifest.json'], { SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: reused });
    expect(own(manifest.controllers)).to.deep.equal(['KeptController', 'NestedController', 'RegisteredController']);
  });
});
