import 'mocha';
import { expect } from 'chai';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { hashManifest, type Manifest } from '@spinajs/manifest';
import { hasBuiltFragments, installApp, type InstalledApp, type ProbeResult } from './support/installed-app.js';

const TMP = resolve('test/fixtures/.tmp-e2e-boot');

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
  'elsewhere/twin-a.ts': controller('TwinController', 'twin-a'),
  'elsewhere/twin-b.ts': controller('TwinController', 'twin-b'),
  'controllers/stars.ts': "export * from '../elsewhere/twin-a.js';\n// @ts-expect-error both name TwinController: at runtime the module exports neither\nexport * from '../elsewhere/twin-b.js';\n",
  'elsewhere/local-other.ts': controller('LocalController', 'local-other'),
  'controllers/own.ts': `${controller('LocalController', 'local-own')}\nexport * from '../elsewhere/local-other.js';\n`,
  'migrations/legacy.old.ts': `
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

@Migration('default')
export class Legacy_2026_10_29_00_00_00 extends OrmMigration {
  public async up(_: OrmDriver): Promise<void> {}
  public async down(_: OrmDriver): Promise<void> {}
}
`,
  'migrations/Tested_2026_10_29_00_00_00.test.ts': `
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

@Migration('default')
export class Tested_2026_10_29_00_00_00 extends OrmMigration {
  public async up(_: OrmDriver): Promise<void> {}
  public async down(_: OrmDriver): Promise<void> {}
}
`,
  'migrations/helper.util.ts': "throw new Error('no scan of this environment imports this file');\n\nexport {};\n",
  'controllers/data.json': '{ "a": 1 }\n',
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

// Abandoned copies with the same class name, mount path and socket prefix as the live classes.
const ABANDONED_COPIES: Array<[string, string]> = [
  ['src/controllers/HealthController.ts', 'src/controllers-old/HealthController.ts'],
  ['src/controllers/users.ts', 'src/controllers-old/users.ts'],
  ['src/socket/chat.ts', 'src/socket-old/chat.ts'],
];

// A decorator of the app's own: the compiler sees neither `Autoinject` nor the class it names.
const WRAPPED_CONTROLLER = `
import { Autoinject, Injectable } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@Injectable()
export class WrappedDep {
  public readonly name = 'dep';
}

function InjectDep() {
  return Autoinject(WrappedDep);
}

@BasePath('wrapped')
export class WrappedController extends BaseController {
  @InjectDep()
  public dep: WrappedDep;

  @InjectDep()
  public deps: WrappedDep[];

  @Get()
  public async get(): Promise<Ok<{ dep: string; deps: number }>> {
    return new Ok({ dep: this.dep.name, deps: this.deps.length });
  }
}
`;

const view = (r: ProbeResult) => ({ responses: r.responses, controllers: r.controllers, schedules: r.schedules, commands: r.commands, socketCommands: r.socketCommands, migrations: [...r.migrations].sort() });

describe('app-basic boots from its manifest', function () {
  this.timeout(300_000);

  let installed: InstalledApp;
  let withoutMetadata: InstalledApp;
  let required: ProbeResult;
  let requiredWithoutMetadata: ProbeResult;
  let discovered: ProbeResult;
  let explainRequired: ProbeResult;
  let explainDiscovered: ProbeResult;
  let preferred: ProbeResult;
  let productionRequired: ProbeResult;
  let productionDiscovered: ProbeResult;
  let manifest: Manifest;

  before(async function () {
    if (!hasBuiltFragments()) {
      if (process.env.CI) throw new Error('no built @spinajs fragments (lib/manifest.fragment.json): run `npm run build` at the repo root first');
      console.log('    skipped: no built @spinajs fragments (lib/manifest.fragment.json), run `npm run build` at the repo root');
      this.skip();
    }
    rmSync(TMP, { recursive: true, force: true });
    const app = {
      sources: { 'src/controllers/wrapped.ts': WRAPPED_CONTROLLER, ...Object.fromEntries(Object.entries(OUTSIDE_THE_DIRS).map(([file, source]) => [`src/${file}`, source])) },
      copies: ABANDONED_COPIES,
      withoutMetadata: ['elsewhere/SourcedController'],
      appDirs: true,
    };
    installed = await installApp(join(TMP, 'metadata'), app);
    withoutMetadata = await installApp(join(TMP, 'no-metadata'), { ...app, emitDecoratorMetadata: false });
    manifest = installed.manifest;
    const fromManifest = (mode: string) => ({ SPINAJS_MANIFEST_MODE: mode, SPINAJS_MANIFEST: installed.manifestPath });
    required = installed.boot(fromManifest('require'));
    requiredWithoutMetadata = withoutMetadata.boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: withoutMetadata.manifestPath });
    discovered = installed.boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1' });
    preferred = installed.boot(fromManifest('prefer'));
    productionRequired = installed.boot({ ...fromManifest('require'), APP_ENV: 'production' });
    productionDiscovered = installed.boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1', APP_ENV: 'production' });
    explainRequired = installed.boot({ ...fromManifest('require'), E2E_EXPLAIN: '1', E2E_APP_SOURCE: '1' });
    explainDiscovered = installed.boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1', E2E_EXPLAIN: '1', E2E_APP_SOURCE: '1' });
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

  it('records the hash of the manifest it booted from, the one hashManifest gives, and null in off mode', () => {
    expect(required.booted).to.deep.include({ mode: 'require', hash: hashManifest(manifest) });
    expect(preferred.booted).to.deep.include({ mode: 'prefer', hash: hashManifest(manifest) });
    expect(required.booted.compilerVersion).to.equal(manifest.compilerVersion);
    expect(discovered.booted).to.deep.equal({ mode: 'off', hash: null });
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

  it('follows ES module export precedence on a name collision: two stars export neither, a local export wins', () => {
    for (const result of [discovered, required]) {
      expect(result.responses.twinA.status).to.equal(404);
      expect(result.responses.twinB.status).to.equal(404);
      expect(result.responses.localOwn.status).to.equal(200);
      expect(result.responses.localOther.status).to.equal(404);
    }
  });

  it('runs a dotted migration file only in the environment its name matches, as a scan does', () => {
    for (const result of [required, preferred, discovered, productionRequired, productionDiscovered]) {
      expect(result.migrations).to.not.include('Legacy_2026_10_29_00_00_00');
    }
    expect(discovered.migrations).to.include('Tested_2026_10_29_00_00_00');
    expect(required.migrations).to.include('Tested_2026_10_29_00_00_00');
    expect(productionDiscovered.migrations).to.not.include('Tested_2026_10_29_00_00_00');
    expect(productionRequired.migrations).to.not.include('Tested_2026_10_29_00_00_00');
    expect([...productionRequired.migrations].sort()).to.deep.equal([...productionDiscovered.migrations].sort());
  });

  it('boots past a file no scan imports: a throwing helper, and JSON the build copied', () => {
    expect(required.responses.health.status).to.equal(200);
    expect((manifest.scanFiles ?? []).map((f) => f.source.file)).to.not.include('src/controllers/data.json');
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

  it('serves a route the controller inherits from an abstract generic base', () => {
    expect(required.responses.article).to.deep.equal({ status: 200, body: { id: 7, title: 'article 7' } });
    expect(discovered.responses.article).to.deep.equal(required.responses.article);
  });

  it('validates an inherited route body against the type the subclass binds', () => {
    expect(required.validation.articleInvalid.status).to.equal(400);
    const [first] = (required.validation.articleInvalid.body as { errors: Record<string, unknown>[] }).errors;
    expect(first).to.include({ instancePath: '/title', keyword: 'type' });
    // the unbound base schema rejected every non-empty body, so only a passing valid body proves the bound type
    expect(required.validation.articleValid).to.deep.equal({ status: 200, body: { id: 2, title: 'news' } });
  });

  it('lists the inherited routes on the concrete controller of the manifest it booted from', () => {
    const articles = manifest.controllers.find((c) => c.className === 'ArticlesController')!;
    expect(articles.routes.map((r) => r.fullPath)).to.deep.equal(['/articles/:id', '/articles/add']);
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
    const globbed = required.scans.globPatterns.map((p) => relative(installed.root, p).split(sep).join('/'));
    expect(globbed.filter((p) => !/^(?:(?:src|lib|dist|build)\/)?config\//.test(p))).to.deep.equal([]);
    expect(required.imports.filter((i) => i.specifier.startsWith('typescript'))).to.deep.equal([]);
    expect(required.imports.filter((i) => i.specifier === 'glob' && /reflection/.test(i.parent))).to.deep.equal([]);
  });

  it('serves the same app as directory discovery', () => {
    // positive controls: the same spies do see a discovery boot
    expect(discovered.scans.controllerDirScans).to.be.greaterThan(0);
    expect(discovered.scans.migrationDirScans).to.be.greaterThan(0);
    expect(discovered.imports.some((i) => i.specifier === 'glob' && /reflection/.test(i.parent))).to.equal(true);
    expect(view(required)).to.deep.equal(view(discovered));
  });

  describe('built with emitDecoratorMetadata: false', () => {
    it('really has no decorator metadata in what it boots', () => {
      const emitted = readdirSync(join(withoutMetadata.root, 'lib'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js'));
      expect(emitted).to.include.members([join('controllers', 'users.js')]);
      expect(emitted.filter((f) => readFileSync(join(withoutMetadata.root, 'lib', f), 'utf8').includes('design:'))).to.deep.equal([]);
      expect(readFileSync(join(installed.root, 'lib', 'controllers', 'users.js'), 'utf8')).to.include('design:paramtypes');
    });

    it('boots in require mode with zero scans and serves the same app', () => {
      expect(requiredWithoutMetadata.scans.ancestorWalks).to.equal(0);
      expect(requiredWithoutMetadata.scans.controllerDirScans).to.equal(0);
      expect(requiredWithoutMetadata.scans.migrationDirScans).to.equal(0);
      expect(requiredWithoutMetadata.imports.filter((i) => i.specifier.startsWith('typescript'))).to.deep.equal([]);
      expect(view(requiredWithoutMetadata)).to.deep.equal(view(required));
    });

    it('types the live controller by its file when an abandoned copy shares its name and mount path', () => {
      expect(withoutMetadata.manifest.controllers.filter((c) => c.className === 'UsersController').map((c) => c.mountedBy)).to.have.members([undefined, 'di']);
      expect(requiredWithoutMetadata.responses.users).to.deep.equal(required.responses.users);
      expect(requiredWithoutMetadata.validation.users.status).to.equal(400);
    });

    it("injects through a decorator of the app's own, a list as a list", () => {
      expect(required.responses.wrapped).to.deep.equal({ status: 200, body: { dep: 'dep', deps: 1 } });
      expect(requiredWithoutMetadata.responses.wrapped).to.deep.equal(required.responses.wrapped);
    });
  });
});
