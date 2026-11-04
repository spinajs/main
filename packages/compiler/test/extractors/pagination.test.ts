import 'mocha';
import { expect } from 'chai';
import type { ControllerEntry, ManifestFragment, RouteEntry } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';
import { pageWithoutParam } from '../../src/doctor/rules/page-without-param.js';
import { fixture } from '../doctor/fixture.js';

const OPTIONS = { tsconfig: 'test/fixtures/paged-app/tsconfig.json', packageRoot: 'test/fixtures/paged-app' };
const USER = { text: 'UserDto', schema: 'spinajs/paged-app/UserDto' };
const doctorCtx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('route pagination', function () {
  this.timeout(120_000);
  let fragment: ManifestFragment;
  const entry = (className: string): ControllerEntry => [...fragment.controllers, ...(fragment.controllerBases ?? [])].find((c) => c.className === className)!;
  const users = (handler: string): RouteEntry => entry('UsersController').routes.find((r) => r.handler === handler)!;

  before(async () => {
    fragment = await analyzePackage(OPTIONS);
  });

  it('marks a Page<T> reply as offset, with the page inside a JSON query object and the default first page', () => {
    expect(users('list').pagination).to.deep.equal({ kind: 'offset', item: USER, param: { arg: 'query', path: ['page'] }, size: { arg: 'query', path: ['pageSize'] }, firstPage: 1 });
  });

  it('reads the first page from the minimum of the page property, and perPage as the size', () => {
    expect(users('zero').pagination).to.deep.equal({ kind: 'offset', item: USER, param: { arg: 'query', path: ['page'] }, size: { arg: 'query', path: ['perPage'] }, firstPage: 0 });
  });

  it('finds query value arguments, the first page from their explicit schema, and limit as the size', () => {
    expect(users('values').pagination).to.deep.equal({ kind: 'offset', item: USER, param: { arg: 'page', path: [] }, size: { arg: 'limit', path: [] }, firstPage: 0 });
  });

  it('marks a CursorPage<T> reply as cursor, with no first page', () => {
    expect(users('feed').pagination).to.deep.equal({ kind: 'cursor', item: USER, param: { arg: 'query', path: ['cursor'] }, size: { arg: 'query', path: ['pageSize'] } });
  });

  it('accepts after as the cursor, and gives an anonymous item a schema of its own', () => {
    const { pagination } = users('after');
    expect(pagination).to.deep.include({ kind: 'cursor', param: { arg: 'after', path: [] } });
    expect(pagination?.item.schema).to.equal('spinajs/paged-app/UsersController_after_Item');
    expect(fragment.schemas['spinajs/paged-app/UsersController_after_Item']).to.deep.include({ type: 'object', required: ['id'] });
  });

  it('records a page without a page parameter, which doctor reports as HTTP007', () => {
    expect(users('all').pagination).to.deep.equal({ kind: 'offset', item: USER });
    const diagnostics = pageWithoutParam.run(fixture({ controllers: fragment.controllers }), doctorCtx);
    expect(diagnostics.map((d) => d.message)).to.deep.equal([
      'UsersController.all returns a page but has no page parameter (page): the generated client gets no infinite query for it.',
    ]);
  });

  it('does not mark a structurally equal type declared outside @spinajs/http', () => {
    for (const handler of ['lookalike', 'local', 'array']) expect(users(handler), handler).to.not.have.property('pagination');
  });

  it('keeps the reply schema of a page as derived without pagination', () => {
    expect(users('list').returnType).to.deep.equal({ text: 'Page<UserDto>', schema: 'spinajs/paged-app/Page_UserDto' });
    expect(fragment.schemas['spinajs/paged-app/Page_UserDto']).to.deep.include({ required: ['items', 'total'] });
  });

  describe('other spellings of a page', () => {
    const shapes = (handler: string): RouteEntry => entry('ShapesController').routes.find((r) => r.handler === handler)!;

    it('marks an app alias of Page<T>, by the declaration it was instantiated from', () => {
      expect(shapes('named').returnType.text).to.equal('UserPage');
      expect(shapes('named').pagination).to.deep.equal({ kind: 'offset', item: USER, param: { arg: 'page', path: [] }, firstPage: 1 });
    });

    it('marks Readonly<CursorPage<T>> and a page intersected with more fields', () => {
      expect(shapes('frozen').pagination).to.deep.equal({ kind: 'cursor', item: USER, param: { arg: 'cursor', path: [] } });
      expect(shapes('faceted').pagination).to.deep.equal({ kind: 'offset', item: USER, param: { arg: 'page', path: [] }, firstPage: 1 });
    });

    it('marks an interface that extends Page<T>, through its base types', () => {
      expect(shapes('extended').pagination).to.deep.equal({ kind: 'offset', item: USER, param: { arg: 'page', path: [] }, firstPage: 1 });
    });

    it('reads the first page from exclusiveMinimum, and through a $ref on the page property', () => {
      expect(shapes('exclusive').pagination?.firstPage).to.equal(0);
      expect(shapes('referenced').pagination).to.deep.include({ param: { arg: 'query', path: ['page'] }, firstPage: 0 });
    });

    it('marks an optional page, whose undefined member is not a second answer', () => {
      expect(shapes('optional').pagination).to.deep.equal({ kind: 'offset', item: USER, param: { arg: 'page', path: [] }, firstPage: 1 });
      expect(shapes('optional').returnType.schema).to.equal('spinajs/paged-app/Page_UserDto');
    });

    it('does not mark a union reply, and warns with HTTP007 at the route instead of staying silent', () => {
      expect(shapes('maybe')).to.not.have.property('pagination');
      const warnings = fragment.diagnostics.filter((d) => d.code === 'HTTP007');
      expect(warnings.map((d) => [d.severity, d.message, d.source?.file])).to.deep.equal([
        ['warning', 'ShapesController.maybe returns a page inside a union, which is not marked as paginated: the generated client gets no infinite query for it. Return the page type itself, and the other answers by throwing.', 'src/shapes.ts'],
      ]);
      const doctor = pageWithoutParam.run(fixture({ controllers: fragment.controllers, diagnostics: fragment.diagnostics }), doctorCtx);
      expect(doctor.filter((d) => d.message.startsWith('ShapesController.maybe'))).to.have.length(1);
    });
  });

  it('records the item a subclass binds on a route inherited from a generic base', () => {
    const list = entry('ArticlesController').routes.find((r) => r.handler === 'list')!;
    expect(list.inheritedFrom).to.equal('paged-app:BaseCrud');
    expect(list.pagination).to.deep.equal({
      kind: 'offset', item: { text: 'ArticleDto', schema: 'spinajs/paged-app/ArticleDto' }, param: { arg: 'query', path: ['page'] }, size: { arg: 'query', path: ['pageSize'] }, firstPage: 1,
    });
    expect(entry('BaseCrud').routes[0].pagination?.item.text).to.equal('T');
  });
});
