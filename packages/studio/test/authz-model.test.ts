import 'mocha';
import { expect } from 'chai';
import { testHost } from '@spinajs/authz-testing';

import { permId, roleId, rolesGraph } from '../src/authz/roles.js';
import type { RoleGraphLike } from '../src/authz/roles.js';
import type { StudioAuthzDomain, StudioGraph, StudioPage } from '../src/contracts/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { RBAC_SECRETS, rbacModel } from './support/authz.js';
import { ROOT_PERMISSIONS } from './support/config.js';
import { registerHeaderSource } from './support/principals.js';

const SECRET_EXTRA = 'SECRET-extra-field';

const has = (g: StudioGraph, source: string, kind: string, target: string): boolean => g.edges.some((e) => e.source === source && e.kind === kind && e.target === target);

describe('Studio authz model', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;
  const get = (path: string, user = 'bob') => app.request().get(path).set('Accept', 'application/json').set('x-user', user);
  const domainsOf = async (query = ''): Promise<StudioPage<StudioAuthzDomain>> => (await get(`/_studio/api/authz/domains${query}`)).body as StudioPage<StudioAuthzDomain>;
  const rolesOf = async (query: string): Promise<StudioGraph> => (await get(`/_studio/api/authz/roles${query}`)).body as StudioGraph;

  before(async () => {
    unregister = registerHeaderSource();
    app = await startApp({
      models: [rbacModel()],
      config: {
        'authz.permissions': { ...ROOT_PERMISSIONS, 'order:read': { types: ['order'] }, 'order:write': {} },
        'authz.combine.default.models': ['m1', 'rbac'],
        'authz.combine.types': { order: { algorithm: 'first-applicable' } },
      },
    });
    // The first guarded request boots root, as in an app.
    await get('/_studio/api/capabilities');
  });

  after(async () => {
    await stopApp();
    unregister();
  });

  it('lists the domains with models, algorithm and permission catalogue', async () => {
    const res = await get('/_studio/api/authz/domains');
    expect(res.status).to.eq(200);
    const root = (res.body as StudioPage<StudioAuthzDomain>).items.find((d) => d.name === 'root');
    expect(root?.models).to.include.members(['m1', 'rbac']);
    expect(root?.algorithm).to.eq('deny-overrides');
    expect(root?.typeAlgorithms).to.deep.eq({ order: 'first-applicable' });
    expect(root?.permissions).to.deep.include({ name: 'order:read', types: ['order'] });
    expect(root).to.not.have.property('parent');
  });

  it('answers the RBAC role graph with inheritance, ladder steps and grants', async () => {
    const g = await rolesOf('?domain=root');
    expect(g.source).to.eq('runtime');
    expect(has(g, roleId('editor'), 'inherits', roleId('viewer'))).to.eq(true);
    expect(has(g, roleId('viewer'), 'grants', permId('order:read'))).to.eq(true);
    expect(has(g, roleId('editor'), 'grants', permId('order:write'))).to.eq(true);
    expect(g.edges.find((e) => e.kind === 'ladder')).to.include({ source: roleId('owner'), target: roleId('member'), label: 'project' });
    expect(g.nodes.find((n) => n.id === roleId('owner'))).to.deep.include({ kind: 'role', group: 'project', attributes: { assignable: true, deny: false } });
    expect(g.nodes.find((n) => n.id === roleId('blocked'))?.attributes).to.deep.eq({ assignable: false, deny: true });
    // order:read is granted by three roles and twice by editor: one node, one edge per role.
    expect(g.nodes.filter((n) => n.id === permId('order:read'))).to.have.length(1);
    expect(g.edges.filter((e) => e.target === permId('order:read')).map((e) => e.source)).to.have.members([roleId('viewer'), roleId('editor'), roleId('member')]);
  });

  it('sends no grant pattern, role description or assignment', async () => {
    const texts = [(await get('/_studio/api/authz/roles')).text, (await get('/_studio/api/authz/domains')).text];
    for (const text of texts) for (const secret of RBAC_SECRETS) expect(text).to.not.include(secret);
  });

  it('cuts the role graph by limit and by focus and depth', async () => {
    const limited = await rolesOf('?limit=2');
    expect(limited.nodes).to.have.length(2);
    expect(limited.truncated).to.eq(true);

    const around = await rolesOf(`?focus=${encodeURIComponent(roleId('viewer'))}&depth=1`);
    expect(around.nodes.map((n) => n.id)).to.have.members([roleId('viewer'), roleId('editor'), permId('order:read')]);
    // A permission is never a role of the same name.
    expect((await get(`/_studio/api/authz/roles?focus=${encodeURIComponent(roleId('order:read'))}`)).status).to.eq(404);
  });

  it('answers 400 for an unknown domain or a bad argument, and 403 without studio:read on each route', async () => {
    const statuses = await Promise.all(
      ['roles?domain=nope', 'roles?domain=a/b', 'roles?limit=0', 'roles?depth=1', 'roles?depth=11&focus=role%3Aviewer', 'domains?limit=0', 'domains?cursor=-1'].map(async (q) => (await get(`/_studio/api/authz/${q}`)).status),
    );
    expect(statuses).to.deep.eq([400, 400, 400, 400, 400, 400, 400]);
    expect((await get('/_studio/api/authz/domains', 'alice')).status).to.eq(403);
    expect((await get('/_studio/api/authz/roles', 'alice')).status).to.eq(403);
  });

  it('refuses a domain outside the name pattern without echoing it', async () => {
    const bad = await get('/_studio/api/authz/roles?domain=zz%2Fqq%3C');
    expect(bad.status).to.eq(400);
    expect(bad.text).to.not.include('zz/qq<');
  });

  it('shows a child domain nothing booted without the models and roles of root', async () => {
    testHost.config().set(['authz', 'domains', 'tenant'], { parent: 'root', permissions: {} });
    (await testHost.domains()).create('tenant', 'root');

    const tenant = (await domainsOf()).items.find((d) => d.name === 'tenant');
    expect(tenant).to.deep.include({ parent: 'root', models: [] });
    expect((await rolesOf('?domain=tenant')).nodes).to.deep.eq([]);
  });

  it('lists every domain without paging arguments, and pages them by limit and cursor', async () => {
    const created = await testHost.domains();
    for (let i = 0; i < 101; i++) created.create(`bulk-${i}`, 'root');
    const all = await domainsOf();
    expect(all.total).to.be.greaterThan(101);
    expect(all.items).to.have.length(all.total ?? 0);
    expect(all).to.not.have.property('cursor');

    const first = await domainsOf('?limit=1');
    expect(first.items.map((d) => d.name)).to.deep.eq(['root']);
    expect(first.total).to.be.greaterThan(1);
    expect(first.cursor).to.eq('1');
    const second = await domainsOf(`?limit=1&cursor=${first.cursor ?? ''}`);
    expect(second.items).to.have.length(1);
    expect(second.items[0].name).to.not.eq('root');
  });

  it('sends mistyped configuration as values of their type, and a domain it cannot read with the error', async () => {
    testHost.config().set(['authz', 'domains', 'typo'], {
      permissions: { 'x:y': { description: 42, types: ['order', 7], extra: SECRET_EXTRA } },
      combine: { default: { algorithm: 7 }, types: { order: { algorithm: 'x'.repeat(5000) } } },
    });
    testHost.config().set(['authz', 'domains', 'broken'], { combine: {} });
    const created = await testHost.domains();
    created.create('typo', 'root');
    created.create('broken', 'root');

    const res = await get('/_studio/api/authz/domains?limit=1000');
    expect(res.text).to.not.include(`"${SECRET_EXTRA}"`);
    const items = (res.body as StudioPage<StudioAuthzDomain>).items;
    const typo = items.find((d) => d.name === 'typo');
    expect(typo).to.deep.include({ parent: 'root', algorithm: '', permissions: [{ name: 'x:y', types: ['order'] }] });
    expect(Buffer.byteLength(typo?.typeAlgorithms.order ?? '')).to.be.lessThan(2100);
    const broken = items.find((d) => d.name === 'broken');
    expect(broken).to.deep.include({ models: [], permissions: [] });
    expect(broken?.error).to.be.a('string').and.not.eq('');
  });
});

describe('rolesGraph', () => {
  it('ends on a structural graph whose roles extend each other in a cycle', () => {
    const def = (parent: string) => ({ def: { extends: [parent], grants: [] }, assignable: true });
    const graph: RoleGraphLike = { names: ['a', 'b'], ladders: [], get: (name: string) => def(name === 'a' ? 'b' : 'a') };
    const g = rolesGraph(graph);
    expect(g.nodes).to.have.length(2);
    expect(has(g, roleId('a'), 'inherits', roleId('b')) && has(g, roleId('b'), 'inherits', roleId('a'))).to.eq(true);
  });
});
