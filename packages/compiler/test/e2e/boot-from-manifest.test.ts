import 'mocha';
import { expect } from 'chai';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { hasBuiltFragments, installApp, type InstalledApp, type ProbeResult } from './support/installed-app.js';

const TMP = resolve('test/fixtures/.tmp-e2e-boot');

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

  before(async function () {
    if (!hasBuiltFragments()) {
      if (process.env.CI) throw new Error('no built @spinajs fragments (lib/manifest.fragment.json): run `npm run build` at the repo root first');
      console.log('    skipped: no built @spinajs fragments (lib/manifest.fragment.json), run `npm run build` at the repo root');
      this.skip();
    }
    rmSync(TMP, { recursive: true, force: true });
    const sources = { 'src/controllers/wrapped.ts': WRAPPED_CONTROLLER };
    installed = await installApp(join(TMP, 'metadata'), { sources });
    withoutMetadata = await installApp(join(TMP, 'no-metadata'), { sources, emitDecoratorMetadata: false });
    required = installed.boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: installed.manifestPath });
    requiredWithoutMetadata = withoutMetadata.boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: withoutMetadata.manifestPath });
    discovered = installed.boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1' });
    explainRequired = installed.boot({ SPINAJS_MANIFEST_MODE: 'require', SPINAJS_MANIFEST: installed.manifestPath, E2E_EXPLAIN: '1' });
    explainDiscovered = installed.boot({ SPINAJS_MANIFEST_MODE: 'off', E2E_SCAN: '1', E2E_EXPLAIN: '1' });
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

    it("injects through a decorator of the app's own, a list as a list", () => {
      expect(required.responses.wrapped).to.deep.equal({ status: 200, body: { dep: 'dep', deps: 1 } });
      expect(requiredWithoutMetadata.responses.wrapped).to.deep.equal(required.responses.wrapped);
    });
  });
});
