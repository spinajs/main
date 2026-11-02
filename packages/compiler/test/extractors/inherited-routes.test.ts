import 'mocha';
import { expect } from 'chai';
import type { ControllerEntry, ManifestFragment } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';

const OPTIONS = { tsconfig: 'test/fixtures/inherited/tsconfig.json', packageRoot: 'test/fixtures/inherited' };

describe('inherited routes', function () {
  this.timeout(120_000);
  let fragment: ManifestFragment;
  const entry = (className: string): ControllerEntry => [...fragment.controllers, ...(fragment.controllerBases ?? [])].find((c) => c.className === className)!;
  const shape = (c: ControllerEntry) => c.routes.map((r) => `${r.method} ${r.fullPath}${r.inheritedFrom ? ` <${r.inheritedFrom}` : ''}`);

  before(async () => {
    fragment = await analyzePackage(OPTIONS);
  });

  it('lists the base routes on the subclass under its own path, in runtime order', () => {
    expect(shape(entry('ArticlesController'))).to.deep.equal([
      'head /articles/:id <inherited:BaseCrud',
      'get /articles/:id <inherited:BaseCrud',
      'post /articles/create <inherited:BaseCrud',
      'get /articles/health <inherited:BaseCrud',
    ]);
    expect(entry('ArticlesController').bases).to.deep.equal(['inherited:BaseCrud']);
  });

  it('records the types the subclass binds', () => {
    const articles = entry('ArticlesController');
    const get = articles.routes.find((r) => r.handler === 'get')!;
    const create = articles.routes.find((r) => r.handler === 'create')!;
    expect(get.returnType).to.deep.include({ text: 'ArticleDto', schema: 'spinajs/inherited/ArticleDto' });
    expect(create.params[0].runtimeType).to.deep.include({ text: 'CreateArticleDto', schema: 'spinajs/inherited/CreateArticleDto' });
    expect(entry('TagsController').routes.find((r) => r.handler === 'create')!.params[0].runtimeType.schema).to.equal('spinajs/inherited/CreateTagDto');
  });

  it('keeps the declaration-site runtime type and wire of a generic argument', () => {
    const base = entry('BaseCrud').routes.find((r) => r.handler === 'create')!.params[0];
    const sub = entry('ArticlesController').routes.find((r) => r.handler === 'create')!.params[0];
    expect(sub.runtimeType.ref).to.deep.equal(base.runtimeType.ref);
    expect(sub.wire).to.deep.equal(base.wire);
    expect(sub.kind).to.equal(base.kind);
  });

  it('reuses the base type refs for a member generics do not touch', () => {
    const base = entry('BaseCrud').routes.find((r) => r.handler === 'health')!;
    const sub = entry('ArticlesController').routes.find((r) => r.handler === 'health')!;
    expect(sub.returnType).to.deep.equal(base.returnType);
    expect(Object.keys(fragment.schemas).filter((id) => /ArticlesController_health/.test(id))).to.deep.equal([]);
  });

  it('merges class guards: own @Access replaces the base one, the base @Policy stays', () => {
    const tags = entry('TagsController');
    expect(tags.access).to.deep.equal(['tags:use']);
    expect(tags.policies).to.deep.equal([[{ type: 'TenantPolicy', options: [] }], [{ type: 'AccessPolicy', options: ['class'] }]]);
    expect(entry('ArticlesController').access).to.deep.equal(['crud:use']);
  });

  it('keeps a redeclared route in place with its new path, merged policies and the base parameter', () => {
    const tags = entry('TagsController');
    expect(shape(tags)).to.deep.equal([
      'head /tags/:id <inherited:BaseCrud',
      'get /tags/by/:id <inherited:BaseCrud',
      'post /tags/create <inherited:BaseCrud',
      'get /tags/health <inherited:BaseCrud',
      'get /tags/popular',
    ]);
    const get = tags.routes[1];
    expect(get.policies).to.deep.equal([[{ type: 'TenantPolicy', options: [] }]]);
    expect(get.params.map((p) => `${p.index}:${p.kind}`)).to.deep.equal(['0:FromParams']);
    expect(get.returnType.text).to.equal('TagDto');
    expect(get.source.file).to.equal('src/controllers.ts');
  });

  it('mounts a subclass without @BasePath under the base path it inherits', () => {
    expect(entry('SharedController').mountPath).to.equal('shared');
    expect(shape(entry('SharedController'))).to.deep.equal(['get /shared/ping']);
    expect(entry('SharedController').bases).to.deep.equal(['inherited:PathOnlyBase']);
  });

  it('follows a chain of concrete controllers', () => {
    const plain = entry('PlainChild');
    expect(plain.mountPath).to.equal('articles');
    expect(plain.bases).to.deep.equal(['inherited:ArticlesController', 'inherited:BaseCrud']);
    expect(plain.routes.find((r) => r.handler === 'get')!.returnType.text).to.equal('ArticleDto');
  });

  it('reports a type parameter of a base as info, not as a warning', () => {
    expect(fragment.diagnostics.filter((d) => d.code === 'SCH001' && d.severity === 'warning')).to.deep.equal([]);
  });

  it('derives nothing for a decorated argument that never reads its type, as the declaration site', () => {
    const put = entry('UploadsController').routes.find((r) => r.handler === 'put')!;
    const stream = put.params.find((p) => p.name === 'stream')!;
    expect(stream.runtimeType.schema).to.equal(undefined);
    expect(put.params.find((p) => p.name === 'dto')!.runtimeType.schema).to.equal('spinajs/inherited/CreateTagDto');
    expect(Object.keys(fragment.schemas).filter((id) => /ReadableStream|UploadsController_put_stream/.test(id))).to.deep.equal([]);
  });

  it('keeps the abstract base entry declaration-site and free of inheritance fields', () => {
    expect(entry('BaseCrud')).to.not.have.property('bases');
    expect(entry('BaseCrud').routes.every((r) => r.inheritedFrom === undefined)).to.equal(true);
  });
});
