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

  it('keeps the abstract base entry declaration-site and free of inheritance fields', () => {
    expect(entry('BaseCrud')).to.not.have.property('bases');
    expect(entry('BaseCrud').routes.every((r) => r.inheritedFrom === undefined)).to.equal(true);
  });
});

describe('inherited routes from a dependency fragment', function () {
  this.timeout(120_000);
  let fragment: ManifestFragment;
  const files = () => fragment.controllers.find((c) => c.className === 'FilesController')!;

  before(async () => {
    fragment = await analyzePackage({ tsconfig: 'test/fixtures/inherited-app/tsconfig.json', packageRoot: 'test/fixtures/inherited-app' });
  });

  it('takes routes and guards from the dependency fragment, mounted under the subclass path', () => {
    expect(files().routes.map((r) => `${r.method} ${r.fullPath} <${r.inheritedFrom}`)).to.deep.equal(['get /files/:id <inherited-lib:StoreController', 'delete /files/:id <inherited-lib:StoreController']);
    expect(files().access).to.deep.equal(['store:use']);
    expect(files().bases).to.deep.equal(['inherited-lib:StoreController']);
  });

  it('types the inherited response with what the subclass binds, read through the declaration file', () => {
    expect(files().routes[0].returnType).to.deep.include({ text: 'FileDto' });
    expect(files().routes[0].returnType.schema).to.be.a('string');
    expect(files().routes[1].returnType).to.deep.equal({ text: 'null' });
  });

  it('keeps the fragment parameter facts', () => {
    expect(files().routes[0].params[0]).to.deep.include({ kind: 'FromParams', wire: { in: 'path', name: 'id', shape: 'value' } });
  });

  it('walks through a dependency class without an entry and inherits nothing from it', () => {
    const loose = fragment.controllers.find((c) => c.className === 'LooseController')!;
    expect(loose.routes).to.deep.equal([]);
    expect(loose).to.not.have.property('bases');
  });

  it('reports nothing for framework classes up the chain, whose packages ship fragments', () => {
    expect(fragment.diagnostics.filter((d) => d.code === 'CMP009')).to.deep.equal([]);
  });
});

describe('inherited routes from a dependency without a fragment', function () {
  this.timeout(120_000);

  it('reports the base as CMP009 info, once, naming the class and the package', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/inherited-nofragment/app/tsconfig.json', packageRoot: 'test/fixtures/inherited-nofragment/app' });
    const reported = fragment.diagnostics.filter((d) => d.code === 'CMP009');
    expect(reported).to.have.length(1);
    expect(reported[0]).to.deep.include({ code: 'CMP009', severity: 'info' });
    expect(reported[0].message).to.contain('StoreController').and.contain('inherited-lib');
    expect(fragment.controllers.find((c) => c.className === 'FilesController')!.routes).to.deep.equal([]);
  });
});
