import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { ClassInfo } from '@spinajs/di';
import type { ControllerEntry, Manifest, ManifestMode } from '@spinajs/manifest';
import { sourceRef, testManifest, withManifest } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { DefaultControllerCache } from '../src/cache.js';
import { BaseController, CacheControllerMetadata, ControllerMetadataProvider, Controllers, HttpServer, ManifestControllerMetadata, NoControllerMetadata } from '../src/index.js';
import { MetadataParamsController, MetadataUnlistedController } from './controller-metadata/MetadataParamsController.js';
import { dir, httpApp, req } from './common.js';

// The source names the arguments `a` and `b`; the manifest says `first` and `second`, so a request bound by the
// manifest's names proves the manifest answered and not the TypeScript cache.
const entry: ControllerEntry = {
  id: 'test-app:MetadataParamsController',
  className: 'MetadataParamsController',
  basePath: 'metadata-params',
  mountPath: 'metadata-params',
  policies: [],
  middlewares: [],
  routes: [
    {
      method: 'get',
      path: 'query',
      handler: 'query',
      fullPath: '/metadata-params/query',
      params: [
        { index: 1, name: 'second', kind: 'FromQuery', runtimeType: { text: 'number' }, required: true },
        { index: 0, name: 'first', kind: 'FromQuery', runtimeType: { text: 'string' }, required: true },
      ],
      returnType: { text: 'Ok' },
      policies: [],
      middlewares: [],
      doc: { summary: 'Query test', description: 'Binds two query values', tags: ['metadata'], deprecated: true, responses: [{ status: 404, description: 'not here' }] },
      source: sourceRef('test/controller-metadata/MetadataParamsController.ts'),
    },
  ],
  source: sourceRef('test/controller-metadata/MetadataParamsController.ts'),
};

const manifest: Manifest = testManifest({ root: process.cwd(), controllers: [entry] });

function classInfo(type: typeof BaseController, name = type.name): ClassInfo<BaseController> {
  return Object.assign(new ClassInfo<BaseController>(), { name, type, file: dir('controller-metadata/MetadataParamsController.ts') });
}

describe('ControllerMetadataProvider', function () {
  this.timeout(60000);

  let app: TestApp | undefined;

  async function boot(mode: ManifestMode, resolve: Array<typeof Controllers> = []): Promise<TestApp> {
    app = await httpApp({ register: withManifest(manifest, mode), resolve });
    return app;
  }

  afterEach(async () => {
    sinon.restore();
    await app?.dispose();
    app = undefined;
  });

  it('the manifest provider answers parameter names in argument order and docs from the manifest', async () => {
    const booted = await boot('require');
    const provider = await booted.resolve(ManifestControllerMetadata);
    const ci = classInfo(MetadataParamsController);

    expect(provider.supports(ci)).to.equal(true);
    expect(await provider.parameters(ci, 'query')).to.deep.equal(['first', 'second']);
    expect(await provider.parameters(ci, 'missing')).to.deep.equal([]);

    const doc = await provider.documentation(ci);
    expect(doc.className).to.equal('MetadataParamsController');
    expect(doc.methods.query).to.deep.include({ summary: 'Query test', description: 'Binds two query values', tags: ['metadata'], deprecated: true });
    expect(doc.methods.query.params).to.deep.equal({ first: { name: 'first' }, second: { name: 'second' } });
    expect(doc.methods.query.responses).to.deep.equal({ '404': { description: 'not here' } });
  });

  it('the manifest provider does not support a controller the manifest lacks', async () => {
    const booted = await boot('prefer');
    const provider = await booted.resolve(ManifestControllerMetadata);
    expect(provider.supports(classInfo(MetadataUnlistedController))).to.equal(false);
  });

  it('the manifest provider supports nothing in off mode', async () => {
    const booted = await boot('off');
    const provider = await booted.resolve(ManifestControllerMetadata);
    expect(provider.supports(classInfo(MetadataParamsController))).to.equal(false);
  });

  it('providers are registered in priority order: manifest before cache', async () => {
    const booted = await boot('prefer');
    const providers = await booted.container.resolve(Array.ofType(ControllerMetadataProvider));
    const sorted = [...providers].sort((a, b) => a.Priority - b.Priority);
    expect(sorted[0]).to.be.instanceOf(ManifestControllerMetadata);
    expect(sorted[sorted.length - 1]).to.be.instanceOf(CacheControllerMetadata);
  });

  it('the loader binds arguments by the manifest names in require mode without the TypeScript cache', async () => {
    const getCache = sinon.spy(DefaultControllerCache.prototype, 'getCache');
    const booted = await boot('require', [Controllers]);
    await (await booted.resolve(HttpServer)).start();

    const res = await req().get('metadata-params/query?first=x&second=2');
    expect(res.status, res.text).to.equal(200);
    expect(res.body).to.deep.equal({ a: 'x', b: 2 });
    expect(getCache.called).to.equal(false);
  });

  it('throws NoControllerMetadata for a controller outside the manifest in require mode', async () => {
    const booted = await boot('require', [Controllers]);
    const loader = await booted.resolve(Controllers);

    let error: unknown;
    try {
      await loader.add(MetadataUnlistedController);
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(NoControllerMetadata);
    expect((error as Error).message).to.include('MetadataUnlistedController');
  });

  it('falls back to the TypeScript cache for a controller outside the manifest in prefer mode', async () => {
    const booted = await boot('prefer', [Controllers]);
    await (await booted.resolve(HttpServer)).start();
    await (await booted.resolve(Controllers)).add(MetadataUnlistedController);

    const res = await req().get('metadata-unlisted/ping?value=v');
    expect(res.status, res.text).to.equal(200);
    expect(res.body).to.deep.equal({ value: 'v' });
  });
});
