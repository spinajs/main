import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Manifest } from '@spinajs/manifest';
import ts from 'typescript';
import { buildAppManifest } from '../../src/index.js';

const WORKSPACE = resolve('../..');
const APP = resolve('test/fixtures/app-basic');
const TMP = resolve('test/fixtures/.tmp-e2e-boot');
const INSTALLED = join(TMP, 'app');
const PROBE = resolve('test/e2e/support/probe.boot.mjs');

// What an app ships in its own config. `system.dirs` is set for the discovery run only: the manifest run has none.
const E2E_CONFIG = `
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const provider = (name) => ({ service: 'fsNative', name, basePath: tmpdir() });
const dirs = (...names) => names.map((n) => join(process.cwd(), 'lib', n));

export default {
  ...(process.env.E2E_SCAN === '1'
    ? { system: { dirs: { controllers: dirs('controllers'), migrations: dirs('migrations'), schedules: dirs('schedules'), cli: dirs('commands'), socketControllers: dirs('socket') } } }
    : {}),
  ...(process.env.E2E_EXPLAIN === '1' ? { authz: { http: { explainRoute: { enabled: true } } } } : {}),
  fs: { defaultProvider: 'fs-temp', providers: [provider('fs-temp'), provider('__fs_controller_cache__')] },
  logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '\${message}' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
  intl: { locales: ['en'], defaultLocale: 'en' },
  http: { port: 0 },
  db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'default', Migration: { OnStartup: false } }] },
};
`;

const controller = (name: string, path: string, decorators = ''): string => `
import { DI, Injectable } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

void DI;
void Injectable;

${decorators}
@BasePath('${path}')
export class ${name} extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('${path}');
  }
}
`;

// Classes the fixture keeps outside the dirs its config declares. Which of them run depends on what the app does, not on
// the manifest: lib/plugin/registrations.js stands for its entry point and is imported only with E2E_APP_SOURCE.
const OUTSIDE_THE_DIRS: Record<string, string> = {
  'elsewhere/ElsewhereController.ts': controller('ElsewhereController', 'elsewhere'),
  'elsewhere/InjectableNeverImported.ts': controller('InjectableNeverImported', 'injectable', '@Injectable(BaseController)'),
  'elsewhere/dev-only.ts': `${controller('DebugController', 'debug')}
export function enableDebug(): void {
  if (process.env.ENABLE_DEBUG === '1') DI.register(DebugController).as(BaseController);
}
`,
  'elsewhere/AdminController.ts': controller('AdminController', 'elsewhere-admin'),
  'plugin/AdminController.ts': controller('AdminController', 'plugin-admin'),
  'elsewhere/LoopController.ts': controller('LoopController', 'loop'),
  'elsewhere/AddedController.ts': controller('AddedController', 'added'),
  'elsewhere/BarrelledController.ts': controller('BarrelledController', 'barrelled'),
  'controllers/barrel.ts': "export { BarrelledController } from '../elsewhere/BarrelledController.js';\n",
  'elsewhere/TypeStarController.ts': controller('TypeStarController', 'typestar'),
  'elsewhere/ImportTypeController.ts': controller('ImportTypeController', 'import-type'),
  'controllers/type-barrel.ts': `
export type * from '../elsewhere/TypeStarController.js';

import type { ImportTypeController } from '../elsewhere/ImportTypeController.js';
export { ImportTypeController };
`,
  'elsewhere/ConstController.ts': controller('ConstController', 'const'),
  'controllers/served.ts': "import { ConstController } from '../elsewhere/ConstController.js';\n\nexport const Served = ConstController;\n",
  'elsewhere/SideEffectController.ts': controller('SideEffectController', 'side-effect'),
  'controllers/register.ts': `
import { DI } from '@spinajs/di';
import { BaseController } from '@spinajs/http';
import { SideEffectController } from '../elsewhere/SideEffectController.js';

DI.register(SideEffectController).as(BaseController);
`,
  'schedules/unexported.ts': `
import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('unexported-task', { every: '1h' })
class UnexportedTask extends ScheduledTask {}

void UnexportedTask;
`,
  'elsewhere/ViaImportTask.ts': `
import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('via-import-task', { every: '1h' })
export class ViaImportTask extends ScheduledTask {}
`,
  'schedules/via-import.ts': "import '../elsewhere/ViaImportTask.js';\n",
  'socket/unexported.ts': `
import { BaseSocketController, Command, Payload, SocketController } from '@spinajs/http-socket';

@SocketController('unexported')
class UnexportedSocket extends BaseSocketController {
  @Command('ping')
  public async ping(@Payload() payload: { text: string }): Promise<{ text: string }> {
    return payload;
  }
}

void UnexportedSocket;
`,
  'migrations/Unexported_2026_10_28_00_00_00.ts': `
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

@Migration('default')
class Unexported_2026_10_28_00_00_00 extends OrmMigration {
  public async up(_: OrmDriver): Promise<void> {}
  public async down(_: OrmDriver): Promise<void> {}
}

void Unexported_2026_10_28_00_00_00;
`,
  'elsewhere/SourcedController.ts': `
import { ClassInfo, Injectable } from '@spinajs/di';
import { BaseController, BasePath, ControllerSource, Get, Ok, Query } from '@spinajs/http';

@BasePath('sourced')
export class SourcedController extends BaseController {
  @Get()
  public async get(@Query() page: number): Promise<Ok<{ page: number; type: string }>> {
    return new Ok({ page, type: typeof page });
  }
}

@Injectable(ControllerSource)
export class SourcedControllerSource extends ControllerSource {
  public async getControllers(): Promise<ClassInfo<BaseController>[]> {
    const ci = new ClassInfo<BaseController>();
    ci.name = SourcedController.name;
    ci.type = SourcedController;
    ci.file = '<di>';
    return [ci];
  }
}
`,
  'elsewhere/BoundSocket.ts': `
import { BaseSocketController, Command, Payload, SocketController } from '@spinajs/http-socket';

export interface Ping {
  text: string;
}

@SocketController('bound')
export class BoundSocket extends BaseSocketController {
  @Command('ping')
  public async ping(@Payload() payload: Ping): Promise<Ping> {
    return payload;
  }
}
`,
  'plugin/registrations.ts': `
import { DI } from '@spinajs/di';
import { BaseController } from '@spinajs/http';
import { AdminController } from './AdminController.js';
import { LoopController } from '../elsewhere/LoopController.js';
import '../elsewhere/SourcedController.js';
import '../elsewhere/BoundSocket.js';

DI.register(AdminController).as(BaseController);
for (const registered of [LoopController]) DI.register(registered).as(BaseController);
`,
};

interface ProbeResult {
  unsupported?: string;
  error?: { name: string; message: string; stack: string };
  imports: Array<{ specifier: string; parent: string }>;
  scans: { ancestorWalks: number; controllerDirScans: number; migrationDirScans: number; globPatterns: string[] };
  responses: Record<string, { status: number; body: unknown }>;
  validation: Record<string, { status: number; body: unknown }>;
  controllers: string[];
  migrations: string[];
  schedules: string[];
  commands: string[];
  socketCommands: string[];
}

/** Emits the fixture to `lib/` with its own tsconfig, without the `noEmit` of the analysis config; discovery reads the .d.ts files. */
function compileApp(root: string): void {
  const read = ts.readConfigFile(join(root, 'tsconfig.json'), (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const options = { ...parsed.options, noEmit: false, outDir: join(root, 'lib'), rootDir: join(root, 'src') };
  const program = ts.createProgram({ rootNames: parsed.fileNames, options });
  const emitted = program.emit();
  const errors = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, { getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n' }));
}

/** One file built as with `emitDecoratorMetadata: false`: its argument types can only come from the manifest. */
function dropDecoratorMetadata(root: string, file: string): void {
  const read = ts.readConfigFile(join(root, 'tsconfig.json'), (f) => ts.sys.readFile(f));
  const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const { outputText } = ts.transpileModule(readFileSync(join(root, 'src', `${file}.ts`), 'utf8'), { compilerOptions: { ...options, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, emitDecoratorMetadata: false, declaration: false } });
  writeFileSync(join(root, 'lib', `${file}.js`), outputText);
}

/** The app as a deployment lays it out: its own lib/ and a node_modules/@spinajs holding only the packages it depends on. */
async function installApp(): Promise<Manifest> {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(INSTALLED, { recursive: true });
  cpSync(join(APP, 'src'), join(INSTALLED, 'src'), { recursive: true });
  cpSync(join(APP, 'tsconfig.json'), join(INSTALLED, 'tsconfig.json'));

  // pkg-basic is another fixture package that is not built here, and only the app's entry point imports it
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  delete pkg.dependencies['pkg-basic'];
  // `workspaces` makes it a root: the configuration walk does not climb into the repo above it
  writeFileSync(join(INSTALLED, 'package.json'), JSON.stringify({ ...pkg, workspaces: [] }));
  rmSync(join(INSTALLED, 'src', 'index.ts'));
  for (const [file, source] of Object.entries(OUTSIDE_THE_DIRS)) {
    mkdirSync(dirname(join(INSTALLED, 'src', file)), { recursive: true });
    writeFileSync(join(INSTALLED, 'src', file), source);
  }
  // Abandoned copies with the same class name, mount path and socket prefix as the live classes.
  for (const [from, to] of [['controllers/HealthController.ts', 'controllers-old/HealthController.ts'], ['controllers/users.ts', 'controllers-old/users.ts'], ['socket/chat.ts', 'socket-old/chat.ts']]) {
    mkdirSync(dirname(join(INSTALLED, 'src', to)), { recursive: true });
    cpSync(join(INSTALLED, 'src', from), join(INSTALLED, 'src', to));
  }

  compileApp(INSTALLED);
  dropDecoratorMetadata(INSTALLED, 'elsewhere/SourcedController');
  mkdirSync(join(INSTALLED, 'lib', 'config'), { recursive: true });
  writeFileSync(join(INSTALLED, 'lib', 'config', 'e2e.js'), E2E_CONFIG);

  const built = (name: string): string[] => [join(INSTALLED, 'lib', name)];
  const effectiveDirs = { controllers: built('controllers'), migrations: built('migrations'), schedules: built('schedules'), cli: built('commands'), socketControllers: built('socket') };
  const { manifest } = await buildAppManifest({ tsconfig: join(INSTALLED, 'tsconfig.json'), appRoot: INSTALLED, out: join(INSTALLED, 'app.manifest.json'), effectiveDirs });
  for (const { name } of manifest.packages) {
    const link = join(INSTALLED, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(WORKSPACE, 'node_modules', name)), link, 'junction');
  }
  writeFileSync(join(INSTALLED, 'probe.mjs'), readFileSync(PROBE));
  return manifest;
}

function boot(env: NodeJS.ProcessEnv): ProbeResult {
  const run = spawnSync(process.execPath, ['probe.mjs'], {
    cwd: INSTALLED,
    encoding: 'utf8',
    timeout: 150_000,
    env: { ...process.env, APP_ENV: 'test', WORKSPACE_ROOT_PATH: INSTALLED, ...env },
  });
  const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
  if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(match[1]) as ProbeResult;
  if (result.unsupported) throw new Error(result.unsupported);
  if (result.error) throw new Error(`${result.error.name}: ${result.error.message}\n${result.error.stack}`);
  return result;
}

describe('app-basic boots from its manifest', function () {
  this.timeout(300_000);

  let required: ProbeResult;
  let discovered: ProbeResult;
  let explainRequired: ProbeResult;
  let explainDiscovered: ProbeResult;
  let preferred: ProbeResult;
  let manifest: Manifest;

  before(async function () {
    if (!existsSync(join(WORKSPACE, 'node_modules', '@spinajs', 'configuration', 'lib', 'manifest.fragment.json'))) {
      if (process.env.CI) throw new Error('no built @spinajs fragments (lib/manifest.fragment.json): run `npm run build` at the repo root first');
      console.log('    skipped: no built @spinajs fragments (lib/manifest.fragment.json), run `npm run build` at the repo root');
      this.skip();
    }
    manifest = await installApp();
    required = boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: join(INSTALLED, 'app.manifest.json') });
    discovered = boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1' });
    preferred = boot({ SPINAJS_MANIFEST_MODE: 'prefer', SPINAJS_MANIFEST: join(INSTALLED, 'app.manifest.json') });
    explainRequired = boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: join(INSTALLED, 'app.manifest.json'), E2E_EXPLAIN: '1', E2E_APP_SOURCE: '1' });
    explainDiscovered = boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1', E2E_EXPLAIN: '1', E2E_APP_SOURCE: '1' });
  });

  after(() => {
    if (!process.env.E2E_KEEP) rmSync(TMP, { recursive: true, force: true });
  });

  it('serves routes, lists migrations, schedules, commands and socket commands', () => {
    expect(required.responses.health).to.deep.equal({ status: 200, body: { ok: true } });
    expect(required.responses.users).to.deep.equal({ status: 200, body: [{ id: 1, email: 'ada@example.com', name: 'Ada' }] });
    expect(required.controllers).to.include.members(['HealthController', 'UsersController']);
    expect(required.migrations).to.include('AppBasic_2026_10_27_00_00_00');
    expect(required.schedules).to.include('basic-task');
    expect(required.commands).to.include('BasicCommand');
    expect(required.socketCommands).to.include.members(['chat.send', 'chat.history']);
  });

  it('does not mount the explain route, which only its own source serves', () => {
    expect(required.responses.explain.status).to.equal(404);
    expect(required.controllers).to.not.include('ExplainController');
  });

  it('serves the explain route through its own source when the flag is on, in require as in off mode', () => {
    expect(explainDiscovered.controllers).to.include('ExplainController');
    expect(explainRequired.controllers).to.include('ExplainController');
    expect(explainRequired.responses.explain.status).to.not.equal(404);
    expect(explainRequired.responses.explain.status).to.equal(explainDiscovered.responses.explain.status);
  });

  it('does not mount a class of the app outside its dirs, which discovery never loads, and reports it', () => {
    expect(discovered.responses.elsewhere.status).to.equal(404);
    expect(required.responses.elsewhere.status).to.equal(404);
    expect(required.controllers).to.not.include('ElsewhereController');
    const reported = manifest.diagnostics.find((d) => d.code === 'CMP006' && d.message.includes('ElsewhereController'));
    expect(reported?.source?.file).to.equal('src/elsewhere/ElsewhereController.ts');
  });

  it('mounts no class outside the dirs on the strength of a registration that never ran', () => {
    for (const result of [required, explainRequired]) {
      expect(result.responses.injectable.status).to.equal(404);
      expect(result.responses.debug.status).to.equal(404);
      expect(result.responses.adminElsewhere.status).to.equal(404);
    }
    expect(required.responses.adminPlugin.status).to.equal(404);
    expect(required.controllers).to.not.include.members(['InjectableNeverImported', 'DebugController', 'AdminController']);
  });

  it('serves what a registration that ran brings in, in require as in off mode', () => {
    for (const route of ['adminPlugin', 'loop', 'added']) {
      expect(explainDiscovered.responses[route].status, route).to.equal(200);
      expect(explainRequired.responses[route], route).to.deep.equal(explainDiscovered.responses[route]);
    }
  });

  it('does not mount a class a file under the dirs re-exports only as a type: nothing is emitted, so no scan sees it', () => {
    for (const route of ['typestar', 'importType']) {
      expect(discovered.responses[route].status, route).to.equal(404);
      expect(required.responses[route].status, route).to.equal(404);
      expect(preferred.responses[route].status, route).to.equal(404);
    }
    const flagged = manifest.controllers.filter((c) => c.mountedBy === 'di').map((c) => c.className);
    expect(flagged).to.include.members(['TypeStarController', 'ImportTypeController']);
  });

  it('serves a class exported as a value under another name, as discovery does', () => {
    expect(discovered.responses.const.status).to.equal(200);
    expect(required.responses.const).to.deep.equal(discovered.responses.const);
  });

  it('runs what a scan brings in without an export, as discovery does', () => {
    for (const result of [discovered, required]) {
      expect(result.schedules).to.include.members(['unexported-task', 'via-import-task']);
      expect(result.socketCommands).to.include('unexported.ping');
      expect(result.migrations).to.include('Unexported_2026_10_28_00_00_00');
      expect(result.responses.sideEffect.status).to.equal(200);
    }
  });

  it('is not disturbed by an abandoned copy of a live controller or socket', () => {
    expect(required.responses.health).to.deep.equal({ status: 200, body: { ok: true } });
    expect(required.socketCommands).to.include('chat.send');
    expect(manifest.controllers.filter((c) => c.className === 'HealthController').map((c) => c.mountedBy)).to.have.members([undefined, 'di']);
  });

  it('keeps derived validation of a live controller with an abandoned copy, in require and in prefer', () => {
    expect(required.validation.users.status).to.equal(400);
    expect(preferred.validation.users.status).to.equal(400);
  });

  it('serves a class a file under the dirs re-exports, as discovery does', () => {
    expect(discovered.responses.barrelled.status).to.equal(200);
    expect(required.responses.barrelled).to.deep.equal(discovered.responses.barrelled);
    expect(manifest.controllers.find((c) => c.className === 'BarrelledController')?.source.file).to.equal('src/elsewhere/BarrelledController.ts');
  });

  it('types and validates a <di> controller from its flagged entry, in a file built without decorator metadata', () => {
    expect(manifest.controllers.find((c) => c.className === 'SourcedController')?.mountedBy).to.equal('di');
    expect(required.responses.sourced.status).to.equal(404);
    expect(explainRequired.responses.sourced).to.deep.equal({ status: 200, body: { page: 2, type: 'number' } });
    expect(explainRequired.responses.sourcedInvalid.status).to.equal(400);
  });

  it('serves a socket controller an import registers, from its flagged entry', () => {
    expect(manifest.socketControllers.find((c) => c.className === 'BoundSocket')?.mountedBy).to.equal('di');
    expect(required.socketCommands).to.not.include('bound.ping');
    expect(explainDiscovered.socketCommands).to.include('bound.ping');
    expect(explainRequired.socketCommands).to.include('bound.ping');
  });

  it('lists no abstract controller base', () => {
    expect(required.controllers).to.not.include.members(['UploadController']);
    expect(required.controllers.filter((c) => /Base$/.test(c))).to.deep.equal([]);
  });

  it('runs no directory scan and never loads typescript', () => {
    expect(required.scans.ancestorWalks).to.equal(0);
    expect(required.scans.controllerDirScans).to.equal(0);
    expect(required.scans.migrationDirScans).to.equal(0);
    // the app's own config dirs are still listed: configuration files are not a manifest section
    const globbed = required.scans.globPatterns.map((p) => relative(INSTALLED, p).split(sep).join('/'));
    expect(globbed.filter((p) => !/^(?:(?:src|lib|dist|build)\/)?config\//.test(p))).to.deep.equal([]);
    expect(required.imports.filter((i) => i.specifier.startsWith('typescript'))).to.deep.equal([]);
    expect(required.imports.filter((i) => i.specifier === 'glob' && /reflection/.test(i.parent))).to.deep.equal([]);
  });

  it('serves the same app as directory discovery', () => {
    // positive controls: the same spies do see a discovery boot
    expect(discovered.scans.controllerDirScans).to.be.greaterThan(0);
    expect(discovered.scans.migrationDirScans).to.be.greaterThan(0);
    expect(discovered.imports.some((i) => i.specifier === 'glob' && /reflection/.test(i.parent))).to.equal(true);
    const view = (r: ProbeResult) => ({ responses: r.responses, controllers: r.controllers, schedules: r.schedules, commands: r.commands, socketCommands: r.socketCommands, migrations: [...r.migrations].sort() });
    expect(view(required)).to.deep.equal(view(discovered));
  });
});
