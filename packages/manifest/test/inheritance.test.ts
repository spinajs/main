import 'mocha';
import { expect } from 'chai';
import { inheritController, inheritPolicies, inheritSocketHandlers, type ControllerEntry, type RouteEntry, type RouteOverride, type SocketControllerEntry } from '../src/index.js';

const src = (file: string, line = 1) => ({ file, line, col: 1, package: 'app' });
const route = (handler: string, path: string, extra: Partial<RouteEntry> = {}): RouteEntry => ({
  method: 'get', path, handler, fullPath: `/x/${path}`, params: [], returnType: { text: 'void' }, policies: [], middlewares: [], source: src('src/base.ts'), ...extra,
});
const controller = (className: string, extra: Partial<ControllerEntry> = {}): ControllerEntry => ({
  id: `app:${className}`, className, basePath: null, mountPath: className.toLowerCase(), policies: [], middlewares: [], routes: [], source: src(`src/${className}.ts`), ...extra,
});
const access = (scope: string) => [{ type: 'AccessPolicy', options: [scope] }];

describe('inheritController', () => {
  const base = controller('BaseCrud', { basePath: 'crud', mountPath: 'crud', routes: [route('head', ':id', { method: 'head' }), route('get', ':id'), route('list', '')] });

  it('serves the ancestor routes under the subclass mount path, first, marked with their origin', () => {
    const own = controller('Articles', { basePath: 'articles', mountPath: 'articles', routes: [route('stats', 'stats', { source: src('src/Articles.ts') })] });
    const merged = inheritController(base, own, []);
    expect(merged.routes.map((r) => `${r.method} ${r.fullPath} ${r.inheritedFrom ?? '-'}`)).to.deep.equal([
      'head /articles/:id app:BaseCrud',
      'get /articles/:id app:BaseCrud',
      'get /articles/list app:BaseCrud',
      'get /articles/stats -',
    ]);
    expect(merged.bases).to.deep.equal(['app:BaseCrud']);
    expect(merged.mountPath).to.equal('articles');
  });

  it('inherits the nearest @BasePath when the subclass declares none', () => {
    const merged = inheritController(base, controller('AppCrud'), []);
    expect(merged.basePath).to.equal('crud');
    expect(merged.mountPath).to.equal('crud');
    expect(merged.routes[1].fullPath).to.equal('/crud/:id');
  });

  it('falls back to the subclass name when no class in the chain declares a base path', () => {
    const merged = inheritController(controller('Plain', { routes: [route('get', ':id')] }), controller('AppPlain'), []);
    expect(merged.mountPath).to.equal('appplain');
  });

  it('keeps a redeclared route in its inherited place, with the override path and merged guards', () => {
    const ancestor = controller('Base', { routes: [route('get', ':id', { policies: [access('route'), [{ type: 'Throttle', options: [] }]] }), route('list', '')] });
    const override: RouteOverride = {
      handler: 'get', route: route('get', 'by/:id', { source: src('src/Sub.ts', 9) }), params: [], policies: [access('route')], middlewares: [], access: ['doc:read'], source: src('src/Sub.ts', 9),
    };
    const merged = inheritController(ancestor, controller('Sub', { basePath: 'sub', mountPath: 'sub', routes: [override.route!] }), [override]);
    expect(merged.routes.map((r) => r.handler)).to.deep.equal(['get', 'list']);
    expect(merged.routes[0].fullPath).to.equal('/sub/by/:id');
    expect(merged.routes[0].policies).to.deep.equal([[{ type: 'Throttle', options: [] }], access('route')]);
    expect(merged.routes[0].access).to.deep.equal(['doc:read']);
    expect(merged.routes[0].source).to.deep.equal(src('src/Sub.ts', 9));
    expect(merged.routes[0].inheritedFrom).to.equal('app:Base');
  });

  it('adds route policies of a verb-less override to the inherited route', () => {
    const ancestor = controller('Base', { routes: [route('get', ':id')] });
    const override: RouteOverride = { handler: 'get', params: [], policies: [[{ type: 'Owner', options: [] }]], middlewares: [], source: src('src/Sub.ts', 4) };
    const merged = inheritController(ancestor, controller('Sub'), [override]);
    expect(merged.routes[0].policies).to.deep.equal([[{ type: 'Owner', options: [] }]]);
    expect(merged.routes[0].path).to.equal(':id');
  });

  it('merges class guards: an own @Access replaces the inherited one, other groups add up', () => {
    const ancestor = controller('Base', { policies: [access('class'), [{ type: 'Tenant', options: [] }]], access: ['base:use'], middlewares: [{ type: 'AuthzFieldsMiddleware', options: [] }] });
    const own = controller('Sub', { policies: [access('class')], access: ['sub:use'], middlewares: [{ type: 'AuthzFieldsMiddleware', options: [] }] });
    const merged = inheritController(ancestor, own, []);
    expect(merged.policies).to.deep.equal([[{ type: 'Tenant', options: [] }], access('class')]);
    expect(merged.access).to.deep.equal(['sub:use']);
    expect(merged.middlewares).to.deep.equal([{ type: 'AuthzFieldsMiddleware', options: [] }]);
  });

  it('carries every field of an overridden route it does not merge', () => {
    const inherited = { ...route('get', ':id'), future: { kept: true } } as RouteEntry;
    const override: RouteOverride = { handler: 'get', params: [], policies: [], middlewares: [], source: src('src/Sub.ts', 4) };
    const merged = inheritController(controller('Base', { routes: [inherited] }), controller('Sub'), [override]);
    expect(merged.routes[0]).to.deep.include({ future: { kept: true } });
  });

  it('keeps the base runtime type of an index the override decorates again, and takes the rest from the override', () => {
    const param = (kind: string, exportName: string, text: string): RouteEntry['params'][number] => ({
      index: 0, name: 'id', kind, required: true, wire: { in: 'none', shape: 'whole' }, runtimeType: { text, ref: { package: 'app', file: 'src/a.ts', export: exportName } },
    });
    const ancestor = controller('Base', { routes: [route('get', ':id', { params: [param('FromParams', 'BaseId', 'BaseId')] })] });
    const override: RouteOverride = { handler: 'get', params: [param('FromQuery', 'SubId', 'SubId')], policies: [], middlewares: [], source: src('src/Sub.ts', 4) };
    const [merged] = inheritController(ancestor, controller('Sub'), [override]).routes[0].params;
    expect(merged.kind).to.equal('FromQuery');
    expect(merged.runtimeType).to.deep.equal({ text: 'SubId', ref: { package: 'app', file: 'src/a.ts', export: 'BaseId' } });
  });

  it('chains bases nearest first and keeps the first declarer as the origin', () => {
    const mid = { ...inheritController(base, controller('Mid'), []), id: 'app:Mid' };
    const merged = inheritController(mid, controller('Leaf'), []);
    expect(merged.bases).to.deep.equal(['app:Mid', 'app:BaseCrud']);
    expect(merged.routes[0].inheritedFrom).to.equal('app:BaseCrud');
  });

  it('writes no inheritance fields for a controller without ancestors', () => {
    const own = controller('Alone', { routes: [route('get', ':id')] });
    expect(own).to.not.have.property('bases');
    expect(own.routes[0]).to.not.have.property('inheritedFrom');
  });
});

describe('inheritPolicies', () => {
  it('keeps every inherited group when the own side has no @Access', () => {
    expect(inheritPolicies([access('class')], [[{ type: 'P', options: [] }]])).to.deep.equal([access('class'), [{ type: 'P', options: [] }]]);
  });
});

describe('inheritSocketHandlers', () => {
  const cmd = (handler: string, name = handler) => ({ name, handler, payload: { text: 'X' }, result: { text: 'Y' }, options: {}, policies: [], source: src('src/s.ts') });
  const base: SocketControllerEntry = { id: 'pkg:CrudSocket', className: 'CrudSocket', prefix: '', contract: 'crud', commands: [cmd('save'), cmd('load')], events: [{ name: 'touched', payload: { text: 'X' } }], diArgs: [{ handler: 'save', index: 1 }], source: src('src/s.ts') };

  it('adds base handlers the subclass does not declare, own first, with their origin', () => {
    const own: SocketControllerEntry = { id: 'app:Things', className: 'Things', prefix: 'things', commands: [cmd('load', 'fetch')], events: [], source: src('src/t.ts') };
    const merged = inheritSocketHandlers(own, [base]);
    expect(merged.commands.map((c) => `${c.name}:${c.inheritedFrom ?? '-'}`)).to.deep.equal(['fetch:-', 'save:pkg:CrudSocket']);
    expect(merged.events.map((e) => e.inheritedFrom)).to.deep.equal(['pkg:CrudSocket']);
    expect(merged.diArgs).to.deep.equal([{ handler: 'save', index: 1 }]);
    expect(merged.contract).to.equal('crud');
  });

  it('is idempotent on an entry that already holds the base handlers', () => {
    const once = inheritSocketHandlers({ ...base, id: 'app:T', className: 'T', commands: [], events: [], diArgs: undefined, contract: undefined }, [base]);
    expect(inheritSocketHandlers(once, [base])).to.deep.equal(once);
  });
});
