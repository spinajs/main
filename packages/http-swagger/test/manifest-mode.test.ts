import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'node:url';
import { DI } from '@spinajs/di';
import { Configuration, MANIFEST, MANIFEST_SETTINGS, registerManifest, registerManifestSettings } from '@spinajs/configuration';
import { loadRuntimeManifest, type ManifestMode } from '@spinajs/manifest';
import { Controllers } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { TestConfiguration } from './common.js';
import { SwaggerService } from '../src/swagger-service.js';
import '../src/index.js';

const manifestPath = fileURLToPath(new URL('../../compiler/test/fixtures/app-basic/app.manifest.json', import.meta.url));

type Switch = { path: string; mode: ManifestMode };

function configWith(prefix = '', configured?: Switch) {
  return class extends TestConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      const config = this.Config as Record<string, Record<string, unknown>>;
      config.http.controllers = { route: { prefix } };
      if (configured) config.system.manifest = configured;
    }
  };
}

/**
 * Registers what the configuration source decides for an app with this switch. Done after the controllers are listed:
 * app-basic's manifest describes another app, and a listing is cached for every later suite of this process.
 */
function decide(settings: Switch | undefined): void {
  DI.uncache(MANIFEST.key);
  DI.uncache(MANIFEST_SETTINGS.key);
  if (!settings) return;
  const manifest = loadRuntimeManifest(settings);
  registerManifestSettings(DI.RootContainer, settings);
  if (manifest) registerManifest(DI.RootContainer, manifest);
}

/** `manifest` undefined: an app built without the configuration source, which only `configured` switches. */
async function boot(manifest: Switch | undefined, prefix?: string, configured?: Switch): Promise<SwaggerService> {
  DI.clearCache();
  // the previous case's decision is a registered value, which clearCache() keeps; with it the loader would list app-basic
  decide(undefined);
  DI.setESMModuleSupport();
  DI.register(configWith(prefix, configured)).as(Configuration);
  DI.resolve(FsBootsrapper).bootstrap();
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Controllers);
  decide(manifest);
  return DI.resolve(SwaggerService);
}

describe('SwaggerService with a manifest', function () {
  this.timeout(30000);

  afterEach(() => {
    DI.clearCache();
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  after(() => {
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  it('serves OpenAPI 3.1 built from the manifest in prefer mode', async () => {
    const spec = await (await boot({ path: manifestPath, mode: 'prefer' })).buildSpec();
    expect(spec.openapi).to.equal('3.1.0');
    expect(spec.paths).to.have.property('/users/{id}');
    expect(spec.info.title).to.equal('Test Pet Store API');
    expect(spec.info.version).to.equal('2.0.0');
    expect(spec.servers).to.deep.equal([{ url: 'http://localhost:4557', description: 'Test server' }]);
  });

  it('applies the route prefix and the configured security', async () => {
    const spec = await (await boot({ path: manifestPath, mode: 'prefer' }, 'api')).buildSpec();
    expect(spec.paths).to.have.property('/api/users/{id}');
    expect(spec.security).to.deep.equal([{ cookieAuth: [] }]);
  });

  it('keeps the JSDoc builder in off mode', async () => {
    const spec = await (await boot({ path: manifestPath, mode: 'off' })).buildSpec();
    expect(spec.openapi).to.equal('3.0.3');
  });

  it('falls back to the JSDoc builder when prefer finds no manifest', async () => {
    const spec = await (await boot({ path: `${manifestPath}.missing`, mode: 'prefer' })).buildSpec();
    expect(spec.openapi).to.equal('3.0.3');
  });

  it('hides manifest internals from the served document', async () => {
    const spec = await (await boot({ path: manifestPath, mode: 'prefer' })).getSpec();
    const json = JSON.stringify(spec);
    expect(json).to.not.match(/"x-spinajs-/);
    expect(json).to.not.match(/\.tsx?"/);
    expect(json).to.not.include('"source"');
  });

  it('logs which builder served the docs when prefer falls back', async () => {
    const service = await boot({ path: `${manifestPath}.missing`, mode: 'prefer' });
    const lines: string[] = [];
    const log = service as unknown as { Log: Record<string, unknown> };
    const original = log.Log.info as (...a: unknown[]) => void;
    log.Log.info = (...args: unknown[]) => {
      lines.push(args.filter((a) => typeof a === 'string').join(' '));
      return original.apply(log.Log, args);
    };
    await service.buildSpec();
    expect(lines.some((l) => l.includes('prefer') && l.includes('JSDoc') && l.includes('missing'))).to.equal(true);
  });

  it('follows the decided switch, not a system.manifest key merged after it', async () => {
    const spec = await (await boot({ path: manifestPath, mode: 'off' }, '', { path: manifestPath, mode: 'prefer' })).buildSpec();
    expect(spec.openapi).to.equal('3.0.3');
  });

  it('reads system.manifest in an app built without the configuration source', async () => {
    const spec = await (await boot(undefined, '', { path: manifestPath, mode: 'prefer' })).buildSpec();
    expect(spec.openapi).to.equal('3.1.0');
  });

  it('fails in require mode without a manifest', async () => {
    let error: Error | undefined;
    await boot({ path: `${manifestPath}.missing`, mode: 'require' }).catch((e: Error) => (error = e));
    expect(error?.message).to.include('spinajs build');
  });
});
