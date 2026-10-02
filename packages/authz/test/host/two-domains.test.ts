import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';

import { StaticModel, fixtureDsl, userPrincipal } from '@spinajs/authz-testing';

import { authz, AuthorizationModel, AuthzConfigError, ChangeBus, DecisionAudit, ResourceAdapter } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';
import { domains, installHost, instance, resetHost, rootService, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const f1 = { type: 'file', id: 'f1' };
const READ = { principal: alice, permission: 'file:read', resource: f1 } as const;
const PERMISSIONS = { 'file:read': {} };
const route = (...models: string[]) => ({ default: { algorithm: 'deny-overrides', models } });
// No model list: every model of the domain is routed, so a model leaking into it would vote.
const EVERY_MODEL = { default: { algorithm: 'deny-overrides' } };

const permits = (name: string) => new StaticModel({ name, votes: { 'file:read': fixtureDsl.permit() } });
const silent = (name: string) => new StaticModel({ name });
const names = (svc: AuthzService) => svc.models().map((m) => m.name);
const callsOf = (m: StaticModel, method: string) => m.calls.filter((c) => c.method === method).length;

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('two domains (host acceptance)', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  it('a child adds a model; the parent keeps its models and its answers', async () => {
    const root = await rootService();
    const rootModels = names(root);
    const ds = await domains();

    const m1 = silent('m1');
    setConfig(['authz', 'domains', 'parent'], { permissions: PERMISSIONS, combine: EVERY_MODEL });
    ds.create('parent').register(instance(m1)).as(AuthorizationModel);
    const parent = await ds.service('parent');
    expect((await parent.check(READ)).reason?.code).to.equal('no_access');

    const m2 = permits('m2');
    ds.create('child', 'parent').register(instance(m2)).as(AuthorizationModel);
    const child = await ds.service('child');

    expect(names(child)).to.deep.equal(['m1', 'm2']);
    expect((await child.check(READ)).allowed).to.equal(true);
    expect(names(parent)).to.deep.equal(['m1']);
    const again = await parent.check(READ);
    expect(again.allowed).to.equal(false);
    expect(again.reason?.code).to.equal('no_access');
    expect(callsOf(m2, 'evaluate')).to.equal(1);
    expect(callsOf(m2, 'init')).to.equal(1);
    expect(callsOf(m1, 'init')).to.equal(1);
    expect(names(root)).to.deep.equal(rootModels);
  });

  it('a sibling domain does not see the model another sibling adds', async () => {
    const ds = await domains();
    const mine = permits('m1');
    setConfig(['authz', 'domains', 'a'], { permissions: PERMISSIONS, combine: route('m1') });
    setConfig(['authz', 'domains', 'b'], { permissions: PERMISSIONS, combine: route() });
    ds.create('a').register(instance(mine)).as(AuthorizationModel);
    ds.create('b');
    const a = await ds.service('a');
    const b = await ds.service('b');

    expect(names(a)).to.deep.equal(['m1']);
    expect(names(b)).to.deep.equal([]);
    expect((await a.check(READ)).allowed).to.equal(true);
    expect((await b.check(READ)).allowed).to.equal(false);
    expect(callsOf(mine, 'evaluate')).to.equal(1);
  });

  it('a model registered in a test domain is disposed with it, and nothing leaks into root', async () => {
    const root = await rootService();
    // Resolves the process ALS, which the first check of any domain would otherwise create in root.
    root.current();
    const rc = DI.RootContainer;
    const tokens = [AuthorizationModel, ResourceAdapter, DecisionAudit, ChangeBus].map((t) => t.name);
    const registrations = () => tokens.map((t) => [...(rc.Registry.getTypes(t, false) ?? [])]);
    const cached = () => [...rc.Cache].map((e) => e.value);
    const before = { models: root.models(), registrations: registrations(), cached: cached() };

    const ds = await domains();
    const model = permits('fake');
    setConfig(['authz', 'domains', 't1'], { permissions: PERMISSIONS, combine: route('fake') });
    const t1 = ds.create('t1');
    t1.register(instance(model)).as(AuthorizationModel);
    expect(t1.Registry.getTypes(tokens[0], false), 'the name lookup sees registrations').to.have.lengthOf(1);
    const svc = await ds.service('t1');
    expect((await svc.check(READ)).allowed).to.equal(true);
    expect(authz('t1')).to.equal(svc);
    expect(callsOf(model, 'dispose')).to.equal(0);

    await ds.container('t1').dispose();

    expect(callsOf(model, 'dispose')).to.equal(1);
    expect(ds.names()).to.deep.equal(['root']);
    expect(() => authz('t1')).to.throw(AuthzConfigError);
    expect(await rejection(svc.check(READ))).to.be.instanceOf(AuthzConfigError);

    expect(root.models()).to.equal(before.models);
    expect(registrations()).to.deep.equal(before.registrations);
    const after = cached();
    expect(after).to.have.lengthOf(before.cached.length);
    for (const v of after) expect(before.cached.includes(v), `a root cache entry was added: ${String(v?.constructor?.name)}`).to.equal(true);
    expect(await rootService()).to.equal(root);
  });
});
