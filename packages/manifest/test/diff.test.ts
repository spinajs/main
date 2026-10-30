import { expect } from 'chai';
import 'mocha';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffManifest, renderMarkdown, routeFullPath } from '../src/index.js';
import type { Change, ControllerEntry, Manifest, ParamEntry, ParamWire, RouteEntry } from '../src/index.js';

const fixture = fileURLToPath(new URL('../../compiler/test/fixtures/app-basic/app.manifest.json', import.meta.url));
const base = JSON.parse(readFileSync(fixture, 'utf8')) as Manifest;

const clone = (): Manifest => JSON.parse(JSON.stringify(base)) as Manifest;
const allRoutes = (m: Manifest): RouteEntry[] => m.controllers.flatMap((c) => c.routes);
const routeOf = (m: Manifest, method: string, fullPath: string): RouteEntry => {
  const found = allRoutes(m).find((r) => r.method === method && r.fullPath === fullPath);
  if (!found) throw new Error(`no route ${method} ${fullPath}`);
  return found;
};
const schemaOf = (m: Manifest, name: string) => m.schemas[`spinajs/app-basic/${name}`] as { properties: Record<string, unknown>; required?: string[] };
const find = (changes: Change[], section: Change['section'], id: string): Change | undefined => changes.find((c) => c.section === section && c.id === id);
const param = (name: string, required: boolean): ParamEntry => ({ index: 5, name, kind: 'FromQuery', runtimeType: { text: 'string' }, required });

describe('diffManifest', () => {
  it('reports nothing for identical manifests', () => {
    const diff = diffManifest(base, clone());
    expect(diff.changes).to.deep.equal([]);
    expect(diff.breaking).to.equal(false);
    expect(diff.base).to.equal(base.hash);
  });

  describe('routes', () => {
    it('removed route is breaking', () => {
      const head = clone();
      head.controllers[0].routes = [];
      const change = find(diffManifest(base, head).changes, 'routes', 'GET /health/get');
      expect(change).to.include({ kind: 'removed', breaking: true });
    });

    it('added route is not breaking', () => {
      const head = clone();
      head.controllers[0].routes.push({ ...routeOf(head, 'get', '/health/get'), path: 'ping', fullPath: '/health/ping' });
      const diff = diffManifest(base, head);
      expect(find(diff.changes, 'routes', 'GET /health/ping')).to.include({ kind: 'added', breaking: false });
      expect(diff.breaking).to.equal(false);
    });

    it('changed method is breaking (old route removed)', () => {
      const head = clone();
      routeOf(head, 'post', '/users/create').method = 'put';
      const diff = diffManifest(base, head);
      expect(find(diff.changes, 'routes', 'POST /users/create')).to.include({ kind: 'removed', breaking: true });
      expect(find(diff.changes, 'routes', 'PUT /users/create')).to.include({ kind: 'added', breaking: false });
    });

    it('changed path is breaking (old route removed)', () => {
      const head = clone();
      routeOf(head, 'get', '/health/get').fullPath = '/healthz';
      expect(find(diffManifest(base, head).changes, 'routes', 'GET /health/get')).to.include({ kind: 'removed', breaking: true });
    });

    it('new required parameter is breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/users/list').params.push(param('tenant', true));
      expect(find(diffManifest(base, head).changes, 'routes', 'GET /users/list')).to.include({ kind: 'changed', breaking: true });
    });

    it('new optional parameter is not breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/users/list').params.push(param('tenant', false));
      expect(find(diffManifest(base, head).changes, 'routes', 'GET /users/list')).to.include({ kind: 'changed', breaking: false });
    });

    it('removed parameter is breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/users/list').params = [];
      const change = find(diffManifest(base, head).changes, 'routes', 'GET /users/list');
      expect(change).to.include({ breaking: true });
      expect(change?.detail).to.include('query');
    });

    it('changed parameter type is breaking', () => {
      const a = clone();
      const b = clone();
      routeOf(a, 'get', '/users/list').params.push(param('tenant', false));
      routeOf(b, 'get', '/users/list').params.push({ ...param('tenant', false), runtimeType: { text: 'number' } });
      expect(find(diffManifest(a, b).changes, 'routes', 'GET /users/list')).to.include({ breaking: true });
    });

    it('removed response property is breaking', () => {
      const head = clone();
      delete schemaOf(head, 'UserDto').properties.name;
      const change = find(diffManifest(base, head).changes, 'routes', 'GET /users/:id');
      expect(change).to.include({ breaking: true });
      expect(change?.detail).to.include('name');
    });

    it('changed response property type is breaking', () => {
      const head = clone();
      schemaOf(head, 'UserDto').properties.id = { type: 'string' };
      expect(find(diffManifest(base, head).changes, 'routes', 'GET /users/:id')).to.include({ breaking: true });
    });

    it('response property that stopped being required is breaking', () => {
      const head = clone();
      schemaOf(head, 'UserDto').required = ['id'];
      expect(find(diffManifest(base, head).changes, 'routes', 'GET /users/:id')).to.include({ breaking: true });
    });

    it('added response property is not breaking', () => {
      const head = clone();
      schemaOf(head, 'UserDto').properties.nick = { type: 'string' };
      expect(find(diffManifest(base, head).changes, 'routes', 'GET /users/:id')).to.include({ breaking: false });
    });

    it('response change inside a union member is detected through $ref', () => {
      const head = clone();
      delete schemaOf(head, 'UserDto').properties.email;
      expect(find(diffManifest(base, head).changes, 'routes', 'POST /users/create')).to.include({ breaking: true });
    });

    it('request property that stopped being required is not breaking', () => {
      const head = clone();
      schemaOf(head, 'CreateUserDto').required = [];
      expect(find(diffManifest(base, head).changes, 'routes', 'POST /users/create')).to.include({ breaking: false });
    });

    it('request property that became required is breaking', () => {
      const head = clone();
      schemaOf(head, 'CreateUserDto').required = ['email', 'name'];
      expect(find(diffManifest(base, head).changes, 'routes', 'POST /users/create')).to.include({ breaking: true });
    });

    it('terminates on recursive schemas', () => {
      const a = clone();
      const b = clone();
      for (const m of [a, b]) m.schemas['spinajs/app-basic/UserDto'] = { $id: 'spinajs/app-basic/UserDto', type: 'object', properties: { parent: { $ref: 'spinajs/app-basic/UserDto' } } };
      expect(diffManifest(a, b).changes).to.deep.equal([]);
    });
  });

  describe('route identity and wire keys', () => {
    const wired = (name: string, wire: ParamWire, required = true, text = 'string'): ParamEntry => ({ index: 0, name, kind: 'FromQuery', runtimeType: { text }, required, wire });
    const bare = (handler: string, params: ParamEntry[] = []): RouteEntry => ({
      method: 'get', path: '', handler, fullPath: routeFullPath('things', '', handler), params, returnType: { text: 'void' }, policies: [], middlewares: [], source: { file: 'src/things.ts', line: 1, col: 1, package: 'app-basic' },
    });
    const withThings = (...routes: RouteEntry[]): Manifest => {
      const m = clone();
      const things: ControllerEntry = { id: 'app-basic:Things', className: 'Things', basePath: 'things', mountPath: 'things', policies: [], middlewares: [], routes, source: routes[0].source };
      m.controllers.push(things);
      return m;
    };
    const thingsChanges = (b: Manifest, h: Manifest): Change[] => diffManifest(b, h).changes.filter((c) => c.id.includes('/things'));

    it('renaming the handler of a bare route moves its URL: the old route is removed (breaking)', () => {
      expect(thingsChanges(withThings(bare('list')), withThings(bare('all')))).to.deep.equal([
        { section: 'routes', kind: 'added', id: 'GET /things/all', breaking: false },
        { section: 'routes', kind: 'removed', id: 'GET /things/list', breaking: true },
      ]);
    });

    it('an injected argument is not a request parameter, by wire or by its FromDi kind', () => {
      const di = (wire?: ParamWire): ParamEntry => ({ index: 1, name: 'svc', kind: 'FromDi', runtimeType: { text: 'Svc' }, required: true, ...(wire ? { wire } : {}) });
      expect(thingsChanges(withThings(bare('list')), withThings(bare('list', [di({ in: 'none', shape: 'whole' })])))).to.deep.equal([]);
      expect(thingsChanges(withThings(bare('list')), withThings(bare('list', [di()])))).to.deep.equal([]);
      const req = (kind: string): ParamEntry => ({ index: 2, name: 'req', kind, runtimeType: { text: 'Request' }, required: true });
      expect(thingsChanges(withThings(bare('list')), withThings(bare('list', [req('ArgAsRequest'), { ...req('ArgAsResponse'), index: 3 }])))).to.deep.equal([]);
      expect(thingsChanges(withThings(bare('list')), withThings(bare('list', [req('Req')])))).to.deep.equal([]);
    });

    it('renaming a whole-body parameter keeps the wire, renaming a JSON query key breaks it', () => {
      const body = (name: string): ParamEntry => ({ ...wired(name, { in: 'body', shape: 'whole' }, true, 'Dto'), kind: 'FromBody' });
      expect(thingsChanges(withThings(bare('list', [body('body')])), withThings(bare('list', [body('payload')])))).to.deep.equal([]);
      const [change] = thingsChanges(withThings(bare('list', [wired('query', { in: 'query', name: 'query', shape: 'json' })])), withThings(bare('list', [wired('q', { in: 'query', name: 'q', shape: 'json' })])));
      expect(change).to.include({ id: 'GET /things/list', kind: 'changed', breaking: true });
      expect(change.detail).to.include('parameter query (FromQuery) removed');
    });

    it('a header renamed in code but sent under the same key is not a change', () => {
      const header = (name: string): ParamEntry => ({ ...wired(name, { in: 'header', name: 'x-tenant', shape: 'value' }), kind: 'FromHeader' });
      expect(thingsChanges(withThings(bare('list', [header('tenant')])), withThings(bare('list', [header('tenantId')])))).to.deep.equal([]);
    });
  });

  describe('schema direction rules', () => {
    const RESP = 'spinajs/app-basic/UserDto';
    const REQ = 'spinajs/app-basic/CreateUserDto';
    type S = Record<string, unknown>;
    const obj = (properties: S, extra: S = {}): S => ({ type: 'object', properties, ...extra });
    const verdict = (id: string, route: string, from: S, to: S): boolean => {
      const a = clone();
      const b = clone();
      a.schemas[id] = { $id: id, ...from };
      b.schemas[id] = { $id: id, ...to };
      return find(diffManifest(a, b).changes, 'routes', route)?.breaking === true;
    };
    const response = (from: S, to: S) => verdict(RESP, 'GET /users/:id', from, to);
    const request = (from: S, to: S) => verdict(REQ, 'POST /users/create', from, to);
    const field = (f: S) => obj({ v: f });

    it('enum: request removal breaks, addition is safe', () => {
      expect(request(field({ enum: ['a', 'b'] }), field({ enum: ['a'] }))).to.equal(true);
      expect(request(field({ enum: ['a'] }), field({ enum: ['a', 'b'] }))).to.equal(false);
    });

    it('enum: response addition breaks, removal is safe', () => {
      expect(response(field({ enum: ['a'] }), field({ enum: ['a', 'b'] }))).to.equal(true);
      expect(response(field({ enum: ['a', 'b'] }), field({ enum: ['a'] }))).to.equal(false);
    });

    const A = { type: 'string' };
    const B = { type: 'number' };

    it('union: request member removal breaks, addition is safe', () => {
      expect(request(field({ anyOf: [A, B] }), field({ anyOf: [A] }))).to.equal(true);
      expect(request(field({ anyOf: [A] }), field({ anyOf: [A, B] }))).to.equal(false);
    });

    it('union: response member addition breaks, removal is safe', () => {
      expect(response(field({ oneOf: [A] }), field({ oneOf: [A, B] }))).to.equal(true);
      expect(response(field({ oneOf: [A, B] }), field({ oneOf: [A] }))).to.equal(false);
    });

    it('union: a plain type facing a union counts as a one-member union', () => {
      const plain = field(A);
      const union = field({ anyOf: [A, B] });
      expect(response(plain, union)).to.equal(true);
      expect(response(union, plain)).to.equal(false);
      expect(request(union, plain)).to.equal(true);
      expect(request(plain, union)).to.equal(false);
    });

    it('union: reordering alone is not a change', () => {
      expect(request(field({ anyOf: [A, B] }), field({ anyOf: [B, A] }))).to.equal(false);
      expect(response(field({ anyOf: [A, B] }), field({ anyOf: [B, A] }))).to.equal(false);
    });

    it('union: a reordered $ref member is compared with its counterpart', () => {
      const x = { $ref: 'spinajs/app-basic/ListQuery' };
      const y = { $ref: 'spinajs/app-basic/CreateUserDto' };
      const a = clone();
      const b = clone();
      a.schemas[RESP] = { $id: RESP, ...field({ anyOf: [x, y] }) };
      b.schemas[RESP] = { $id: RESP, ...field({ anyOf: [y, x] }) };
      b.schemas['spinajs/app-basic/CreateUserDto'] = obj({});
      expect(find(diffManifest(a, b).changes, 'routes', 'GET /users/:id')?.breaking).to.equal(true);
    });

    it('type: narrowing breaks a request, widening breaks a response', () => {
      const wide = field({ type: ['string', 'number'] });
      const narrow = field({ type: 'string' });
      expect(request(wide, narrow)).to.equal(true);
      expect(request(narrow, wide)).to.equal(false);
      expect(response(narrow, wide)).to.equal(true);
      expect(response(wide, narrow)).to.equal(false);
    });

    it('nullable: type array, nullable flag and anyOf null are equivalent', () => {
      const forms = [{ type: ['string', 'null'] }, { type: 'string', nullable: true }, { anyOf: [{ type: 'string' }, { type: 'null' }] }];
      const plain = { type: 'string' };
      for (const nullable of forms) {
        expect(response(field(plain), field(nullable)), JSON.stringify(nullable)).to.equal(true);
        expect(response(field(nullable), field(plain)), JSON.stringify(nullable)).to.equal(false);
        expect(request(field(plain), field(nullable)), JSON.stringify(nullable)).to.equal(false);
        expect(request(field(nullable), field(plain)), JSON.stringify(nullable)).to.equal(true);
      }
      expect(response(field(forms[0]), field(forms[1]))).to.equal(false);
    });

    it('allOf: a property removed inside allOf is found', () => {
      const parent = { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' } } };
      const slim = { type: 'object', properties: { id: { type: 'number' } } };
      expect(response({ allOf: [parent] }, { allOf: [slim] })).to.equal(true);
      expect(response({ allOf: [parent] }, { allOf: [slim, { type: 'object', properties: { name: { type: 'string' } } }] })).to.equal(false);
    });

    it('allOf: required merged from members counts', () => {
      const mk = (required: string[]) => ({ allOf: [{ type: 'object', properties: { id: { type: 'number' } }, required }] });
      expect(request(mk([]), mk(['id']))).to.equal(true);
    });

    it('additionalProperties: closing breaks a request, opening breaks a response', () => {
      const open = obj({ a: { type: 'string' } });
      const closed = obj({ a: { type: 'string' } }, { additionalProperties: false });
      expect(request(open, closed)).to.equal(true);
      expect(request({ ...open, additionalProperties: true }, closed)).to.equal(true);
      expect(request(closed, open)).to.equal(false);
      expect(response(open, closed)).to.equal(false);
      expect(response(closed, open)).to.equal(true);
    });

    it('a $ref that no longer resolves in head is reported', () => {
      const a = clone();
      const b = clone();
      a.schemas[RESP] = { $id: RESP, ...field({ $ref: 'spinajs/app-basic/Gone' }) };
      a.schemas['spinajs/app-basic/Gone'] = obj({ x: { type: 'string' } });
      b.schemas[RESP] = { $id: RESP, ...field({ $ref: 'spinajs/app-basic/Gone' }) };
      const change = find(diffManifest(a, b).changes, 'routes', 'GET /users/:id');
      expect(change).to.include({ breaking: true });
      expect(change?.detail).to.include('Gone');
    });
  });

  describe('permissions', () => {
    it('permission required where none was is breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/health/get').access = ['health:read'];
      const change = find(diffManifest(base, head).changes, 'permissions', 'GET /health/get');
      expect(change).to.include({ kind: 'changed', breaking: true });
      expect(change?.detail).to.equal('health:read now required on GET /health/get');
    });

    it('policy counts as a requirement', () => {
      const head = clone();
      routeOf(head, 'get', '/health/get').policies = [[{ type: 'AccessPolicy', options: ['route'] }]];
      expect(find(diffManifest(base, head).changes, 'permissions', 'GET /health/get')).to.include({ breaking: true });
    });

    it('controller-level access applies to every route', () => {
      const head = clone();
      head.controllers[0].access = ['health:read'];
      expect(find(diffManifest(base, head).changes, 'permissions', 'GET /health/get')).to.include({ breaking: true });
    });

    it('extra permission on an already protected route is not breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/users/:id').access = ['user:read', 'user:audit'];
      const change = find(diffManifest(base, head).changes, 'permissions', 'GET /users/:id');
      expect(change).to.include({ breaking: false });
      expect(change?.detail).to.equal('user:audit now required on GET /users/:id');
    });

    it('dropped permission is not breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/users/:id').access = [];
      const change = find(diffManifest(base, head).changes, 'permissions', 'GET /users/:id');
      expect(change).to.include({ breaking: false });
      expect(change?.detail).to.equal('user:read no longer required on GET /users/:id');
    });
  });

  describe('other sections', () => {
    it('removed config module is breaking', () => {
      const head = clone();
      head.configModules = head.configModules.filter((c) => c.module !== 'app');
      expect(find(diffManifest(base, head).changes, 'config', 'app')).to.include({ kind: 'removed', breaking: true });
    });

    it('changed config schema is not breaking', () => {
      const head = clone();
      head.schemas['spinajs/app-basic/app.configuration.schema.json'] = { type: 'object' };
      expect(find(diffManifest(base, head).changes, 'config', 'app')).to.include({ kind: 'changed', breaking: false });
    });

    it('removed migration is breaking, added is not', () => {
      const migration = { id: 'app:M1', className: 'M1', connection: 'default', env: ['test'], file: 'src/m1.ts', source: base.controllers[0].source };
      const withMigration = clone();
      withMigration.migrations = [migration];
      expect(find(diffManifest(base, withMigration).changes, 'migrations', 'app:M1')).to.include({ kind: 'added', breaking: false });
      expect(find(diffManifest(withMigration, base).changes, 'migrations', 'app:M1')).to.include({ kind: 'removed', breaking: true });
    });

    it('reports services, commands and socket changes as non-breaking', () => {
      const head = clone();
      const source = base.controllers[0].source;
      head.services.push({ id: 'app:S', className: 'S', registeredAs: ['S'], lifetime: 'singleton', async: false, bootstrapper: false, ctorInjects: [], propertyInjects: [], source });
      head.commands.push({ name: 'do:it', className: 'DoIt', options: [], arguments: [], source });
      head.socketControllers[0].commands = [];
      const diff = diffManifest(base, head);
      expect(find(diff.changes, 'services', 'app:S')).to.include({ kind: 'added', breaking: false });
      expect(find(diff.changes, 'commands', 'do:it')).to.include({ kind: 'added', breaking: false });
      expect(find(diff.changes, 'socket', 'chat:send')).to.include({ kind: 'removed', breaking: false });
      expect(diff.breaking).to.equal(false);
    });

    it('lists schema additions and removals informationally', () => {
      const head = clone();
      delete head.schemas['spinajs/app-basic/ListQuery'];
      head.schemas['spinajs/app-basic/Extra'] = { type: 'object' };
      const { changes } = diffManifest(base, head);
      expect(find(changes, 'schemas', 'spinajs/app-basic/ListQuery')).to.include({ kind: 'removed', breaking: false });
      expect(find(changes, 'schemas', 'spinajs/app-basic/Extra')).to.include({ kind: 'added', breaking: false });
    });
  });

  it('orders changes by code unit regardless of input order', () => {
    const head = clone();
    head.controllers[0].routes = [];
    head.controllers[1].routes = [];
    const shuffled = clone();
    shuffled.controllers.reverse();
    for (const c of shuffled.controllers) c.routes.reverse();
    const ids = (from: Manifest) => diffManifest(from, head).changes.filter((c) => c.section === 'routes').map((c) => c.id);
    expect(ids(shuffled)).to.deep.equal(ids(base));
    expect(ids(base)).to.deep.equal(['GET /health/get', 'GET /users/:id', 'GET /users/list', 'POST /users/:id/avatar', 'POST /users/create']);
  });

  it('sorts by code unit, not by locale', () => {
    const head = clone();
    const source = base.controllers[0].source;
    for (const id of ['b:svc', 'Z:svc']) head.services.push({ id, className: 'S', registeredAs: ['S'], lifetime: 'singleton', async: false, bootstrapper: false, ctorInjects: [], propertyInjects: [], source });
    const ids = diffManifest(base, head).changes.filter((c) => c.section === 'services').map((c) => c.id);
    expect(ids).to.deep.equal(['Z:svc', 'b:svc']);
  });

  it('renders object policy options as JSON', () => {
    const head = clone();
    routeOf(head, 'get', '/health/get').policies = [[{ type: 'AccessPolicy', options: [{ role: 'admin' }] }]];
    const change = find(diffManifest(base, head).changes, 'permissions', 'GET /health/get');
    expect(change?.detail).to.include('{"role":"admin"}').and.not.include('[object Object]');
  });
});

describe('renderMarkdown', () => {
  const snapshot = (name: string, actual: string): void => {
    const file = fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));
    if (!existsSync(file) || process.env.UPDATE_SNAPSHOT) writeFileSync(file, actual);
    expect(actual).to.equal(readFileSync(file, 'utf8'));
  };

  it('renders a breaking diff', () => {
    const head = clone();
    head.hash = 'f'.repeat(64);
    routeOf(head, 'get', '/users/list').params = [];
    routeOf(head, 'get', '/health/get').access = ['health:read'];
    delete schemaOf(head, 'UserDto').properties.name;
    head.configModules = head.configModules.filter((c) => c.module !== 'app');
    snapshot('breaking.md', renderMarkdown(diffManifest(base, head)));
  });

  it('renders a non-breaking diff', () => {
    const head = clone();
    head.hash = 'e'.repeat(64);
    schemaOf(head, 'UserDto').properties.nick = { type: 'string' };
    snapshot('non-breaking.md', renderMarkdown(diffManifest(base, head)));
  });

  it('renders an empty diff', () => {
    snapshot('empty.md', renderMarkdown(diffManifest(base, clone())));
  });

  it('escapes table delimiters in details', () => {
    const md = renderMarkdown({ base: 'a', head: 'b', breaking: false, changes: [{ section: 'routes', kind: 'changed', id: 'GET /x', breaking: false, detail: 'a | b' }] });
    expect(md).to.include('a \\| b');
  });
});
