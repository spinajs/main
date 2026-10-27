import { expect } from 'chai';
import 'mocha';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffManifest, renderMarkdown } from '../src/index.js';
import type { Change, Manifest, ParamEntry, RouteEntry } from '../src/index.js';

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
      const change = find(diffManifest(base, head).changes, 'routes', 'GET /health');
      expect(change).to.include({ kind: 'removed', breaking: true });
    });

    it('added route is not breaking', () => {
      const head = clone();
      head.controllers[0].routes.push({ ...routeOf(head, 'get', '/health'), path: 'ping', fullPath: '/health/ping' });
      const diff = diffManifest(base, head);
      expect(find(diff.changes, 'routes', 'GET /health/ping')).to.include({ kind: 'added', breaking: false });
      expect(diff.breaking).to.equal(false);
    });

    it('changed method is breaking (old route removed)', () => {
      const head = clone();
      routeOf(head, 'post', '/users').method = 'put';
      const diff = diffManifest(base, head);
      expect(find(diff.changes, 'routes', 'POST /users')).to.include({ kind: 'removed', breaking: true });
      expect(find(diff.changes, 'routes', 'PUT /users')).to.include({ kind: 'added', breaking: false });
    });

    it('changed path is breaking (old route removed)', () => {
      const head = clone();
      routeOf(head, 'get', '/health').fullPath = '/healthz';
      expect(find(diffManifest(base, head).changes, 'routes', 'GET /health')).to.include({ kind: 'removed', breaking: true });
    });

    it('new required parameter is breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/users').params.push(param('tenant', true));
      expect(find(diffManifest(base, head).changes, 'routes', 'GET /users')).to.include({ kind: 'changed', breaking: true });
    });

    it('new optional parameter is not breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/users').params.push(param('tenant', false));
      expect(find(diffManifest(base, head).changes, 'routes', 'GET /users')).to.include({ kind: 'changed', breaking: false });
    });

    it('removed parameter is breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/users').params = [];
      const change = find(diffManifest(base, head).changes, 'routes', 'GET /users');
      expect(change).to.include({ breaking: true });
      expect(change?.detail).to.include('query');
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
      expect(find(diffManifest(base, head).changes, 'routes', 'POST /users')).to.include({ breaking: true });
    });

    it('request property that stopped being required is not breaking', () => {
      const head = clone();
      schemaOf(head, 'CreateUserDto').required = [];
      expect(find(diffManifest(base, head).changes, 'routes', 'POST /users')).to.include({ breaking: false });
    });

    it('request property that became required is breaking', () => {
      const head = clone();
      schemaOf(head, 'CreateUserDto').required = ['email', 'name'];
      expect(find(diffManifest(base, head).changes, 'routes', 'POST /users')).to.include({ breaking: true });
    });

    it('terminates on recursive schemas', () => {
      const a = clone();
      const b = clone();
      for (const m of [a, b]) m.schemas['spinajs/app-basic/UserDto'] = { $id: 'spinajs/app-basic/UserDto', type: 'object', properties: { parent: { $ref: 'spinajs/app-basic/UserDto' } } };
      expect(diffManifest(a, b).changes).to.deep.equal([]);
    });
  });

  describe('permissions', () => {
    it('permission required where none was is breaking', () => {
      const head = clone();
      routeOf(head, 'get', '/health').access = ['health:read'];
      const change = find(diffManifest(base, head).changes, 'permissions', 'GET /health');
      expect(change).to.include({ kind: 'changed', breaking: true });
      expect(change?.detail).to.equal('health:read now required on GET /health');
    });

    it('policy counts as a requirement', () => {
      const head = clone();
      routeOf(head, 'get', '/health').policies = [[{ type: 'AccessPolicy', options: ['route'] }]];
      expect(find(diffManifest(base, head).changes, 'permissions', 'GET /health')).to.include({ breaking: true });
    });

    it('controller-level access applies to every route', () => {
      const head = clone();
      head.controllers[0].access = ['health:read'];
      expect(find(diffManifest(base, head).changes, 'permissions', 'GET /health')).to.include({ breaking: true });
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
      head.configModules = head.configModules.filter((c) => c.module !== 'hooks');
      expect(find(diffManifest(base, head).changes, 'config', 'hooks')).to.include({ kind: 'removed', breaking: true });
    });

    it('changed config schema is not breaking', () => {
      const head = clone();
      head.schemas['spinajs/hooks.configuration.schema.json'] = { type: 'object' };
      expect(find(diffManifest(base, head).changes, 'config', 'hooks')).to.include({ kind: 'changed', breaking: false });
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

  it('orders changes deterministically', () => {
    const head = clone();
    head.controllers[0].routes = [];
    head.controllers[1].routes = [];
    const routes = diffManifest(base, head).changes.filter((c) => c.section === 'routes').map((c) => c.id);
    expect(routes).to.deep.equal([...routes].sort((a, b) => a.localeCompare(b)));
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
    routeOf(head, 'get', '/users').params = [];
    routeOf(head, 'get', '/health').access = ['health:read'];
    delete schemaOf(head, 'UserDto').properties.name;
    head.configModules = head.configModules.filter((c) => c.module !== 'hooks');
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
