import { expect } from 'chai';
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hashManifest, type Manifest } from '@spinajs/manifest';
import { buildAppManifest, locateFragments } from '../src/index.js';

const WORKSPACE = resolve('../..');
const APP = resolve('../http-socket-example');
const TMP = resolve('test/fixtures/.tmp-real-app');
const INSTALLED = join(TMP, 'app');

const BOOT_SCRIPT = join(TMP, 'boot.mjs');
const RESULT_MARK = '@@config@@';

const BOOT_SOURCE = `
import { DI } from '@spinajs/di';
import * as configuration from '@spinajs/configuration';

const container = DI.RootContainer.child({ isolateSingletons: true });
container.register({ ...process.env }).asValue('process.env');
for (const source of [configuration.ManifestConfigurationSource, configuration.JsFileSource, configuration.JsonFileSource]) container.register(source).as(configuration.ConfigurationSource);
container.register(configuration.FrameworkConfiguration).as(configuration.Configuration, { replace: true });
const config = await container.resolve(configuration.Configuration);
if (process.env.WORKSPACE_ROOT_PATH !== process.cwd()) throw new Error('the hoisting root of the installed app is ' + process.env.WORKSPACE_ROOT_PATH);
const root = JSON.parse(JSON.stringify(config.RootConfig));
delete root.process;
delete root.system?.manifest;
process.stdout.write(${JSON.stringify(RESULT_MARK)} + JSON.stringify(root));
process.exit(0);
`;

interface NpmTree {
  dependencies?: Record<string, NpmTree>;
}

/** The `@spinajs/*` packages a production install of the app contains, as npm itself resolves the tree. */
function installedSpinajsPackages(): string[] {
  let out: string;
  try {
    out = execSync('npm ls --workspace=packages/http-socket-example --all --omit=dev --json', { cwd: WORKSPACE, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    // npm ls exits non-zero on tree problems ( e.g. an invalid peer ) but still prints the tree
    out = (err as { stdout?: string }).stdout ?? '';
  }
  const names = new Set<string>();
  const walk = (tree: NpmTree) => {
    for (const [name, sub] of Object.entries(tree.dependencies ?? {})) {
      if (names.has(name)) continue;
      names.add(name);
      walk(sub);
    }
  };
  walk(out ? (JSON.parse(out) as NpmTree) : {});
  return [...names].filter((n) => n.startsWith('@spinajs/') && n !== '@spinajs/http-socket-example').sort();
}

/**
 * The workspace's `node_modules/@spinajs` holds every package of the repo, so the walk there would load far more than
 * the app depends on. The app is laid out as an install would place it instead: the packages npm installs for it.
 */
function installLayout(manifest: Manifest, installed: string[]): void {
  rmSync(TMP, { recursive: true, force: true });
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { name: string; version: string };
  mkdirSync(INSTALLED, { recursive: true });
  // `workspaces` makes it a root: the walk does not climb into the repo above it
  writeFileSync(join(INSTALLED, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', workspaces: [] }));
  for (const dir of ['lib/config', 'config']) {
    if (existsSync(join(APP, dir))) cpSync(join(APP, dir), join(INSTALLED, dir), { recursive: true });
  }
  for (const name of installed) {
    const link = join(INSTALLED, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(WORKSPACE, 'node_modules', name)), link, 'junction');
  }
  const app = { ...manifest, app: { ...manifest.app, root: INSTALLED } };
  writeFileSync(join(INSTALLED, 'app.manifest.json'), JSON.stringify({ ...app, hash: hashManifest(app) }));
}

describe('configuration of a real app (http-socket-example)', function () {
  /** Each mode boots in a process of its own: the ESM cache keeps config modules evaluated by an earlier boot. */
  function boot(mode: string): unknown {
    const env: NodeJS.ProcessEnv = { ...process.env, SPINAJS_MANIFEST_MODE: mode, APP_ENV: 'development' };
    delete env.WORKSPACE_ROOT_PATH;
    const out = execFileSync(process.execPath, ['--experimental-specifier-resolution=node', BOOT_SCRIPT], { cwd: INSTALLED, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'inherit'] });
    return JSON.parse(out.slice(out.lastIndexOf(RESULT_MARK) + RESULT_MARK.length)) as unknown;
  }

  before(async function () {
    // the dependency fragments come from the root `npm run build`; without them there is nothing to compare
    const located = existsSync(join(APP, 'package.json')) ? await locateFragments(APP) : [];
    if (!located.some((l) => l.name === '@spinajs/configuration')) {
      console.log('    skipped: no built @spinajs fragments (lib/manifest.fragment.json), run `npm run build` at the repo root');
      this.skip();
    }
    const installed = installedSpinajsPackages();
    if (installed.length === 0) {
      console.log('    skipped: `npm ls` listed no installed @spinajs packages for the app');
      this.skip();
    }
    mkdirSync(TMP, { recursive: true });
    const { manifest } = await buildAppManifest({ tsconfig: join(APP, 'tsconfig.json'), appRoot: APP, out: join(TMP, 'built.manifest.json') });
    installLayout(manifest, installed);
    writeFileSync(BOOT_SCRIPT, BOOT_SOURCE);
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('merges the same configuration in off and prefer mode', async () => {
    const walk = boot('off');
    const listed = boot('prefer');
    expect(Object.keys(walk as object)).to.include.members(['http', 'logger', 'fs']);
    expect(listed).to.deep.equal(walk);
  });
});
