import * as chai from 'chai';
import 'mocha';
import { AuthzConfigError, CORE_FILTER_OPS, FALSE, TRUE } from '@spinajs/authz';
import type { PermissionDef, Principal, ResourceRef, Vote } from '@spinajs/authz';
import { FakePermissionRegistry, fakeModelInitContext, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';

import { MemoryTupleStore, REBAC_CHECK_OP, RebacModel } from '../../src/index.js';
import { NAMESPACES, PERMISSIONS, PERMISSION_INPUTS, d1, d2, d3, f1, setup, tuple, user } from '../support/world.js';
import type { Setup } from '../support/world.js';

const expect = chai.expect;

const vote = (s: Setup, who: Principal, permission: string, resource: ResourceRef): Promise<Vote> => s.model.evaluate({ principal: who, permission, resource }, s.context());
const allowed = async (s: Setup, who: string, permission: string, resource: ResourceRef): Promise<boolean> => (await vote(s, userPrincipal(who), permission, resource)).permitWhen === TRUE;
const def = (name: string): PermissionDef => new FakePermissionRegistry(PERMISSION_INPUTS).get(name)!;

describe('authz-rebac: RebacModel', () => {
  let s: Setup;

  beforeEach(async () => {
    s = await setup();
  });

  describe('evaluate on a concrete resource', () => {
    it('a direct tuple grants its subject', async () => {
      expect(await allowed(s, 'alice', 'doc:read', d1)).to.equal(true);
      expect(await allowed(s, 'eve', 'doc:read', d1)).to.equal(false);
    });

    it('a subject set grants its members, nested sets included', async () => {
      expect(await allowed(s, 'bob', 'doc:read', d1)).to.equal(true);
      expect(await allowed(s, 'olga', 'doc:read', d1)).to.equal(true);
    });

    it('a tuple-to-userset follows the parent tuples, over several hops', async () => {
      expect(await allowed(s, 'frank', 'doc:read', d2)).to.equal(true);
      expect(await allowed(s, 'carol', 'doc:read', d2)).to.equal(true);
      expect(await allowed(s, 'carol', 'folder:read', f1)).to.equal(true);
      expect(await allowed(s, 'alice', 'doc:read', d2)).to.equal(false);
    });

    it('an intersection needs every branch', async () => {
      expect(await allowed(s, 'alice', 'doc:edit', d1)).to.equal(true);
      expect(await allowed(s, 'bob', 'doc:edit', d1)).to.equal(false);
    });

    it('an exclusion takes the subtracted subjects away', async () => {
      expect(await allowed(s, 'alice', 'doc:view', d1)).to.equal(true);
      expect(await allowed(s, 'olga', 'doc:view', d1)).to.equal(true);
      expect(await allowed(s, 'bob', 'doc:view', d1)).to.equal(false);
    });

    it('a cycle of subject sets ends without a grant and without an error', async () => {
      const v = await vote(s, userPrincipal('alice'), 'doc:read', d3);
      expect(v.permitWhen).to.equal(FALSE);
      expect(v.error).to.equal(undefined);
      expect(v.reason).to.deep.equal({ code: 'no_access', model: 'rebac' });
    });

    it('a permit vote is cacheable and never denies', async () => {
      const v = await vote(s, userPrincipal('alice'), 'doc:read', d1);
      expect(v).to.deep.include({ model: 'rebac', permitWhen: TRUE, denyWhen: FALSE, cacheable: true });
    });

    it('a proof deeper than limit.maxDepth makes the vote indeterminate; one within it still grants', async () => {
      const shallow = await setup({ limit: { maxDepth: 1 } });
      const deep = await vote(shallow, userPrincipal('olga'), 'doc:read', d1);
      expect(deep.permitWhen).to.equal(FALSE);
      expect(deep.error).to.be.a('string').that.includes('maxDepth 1');
      expect(deep.reason).to.deep.equal({ code: 'model_error', model: 'rebac' });
      expect(await allowed(shallow, 'bob', 'doc:read', d1)).to.equal(true);
    });

    it('a check past limit.maxCalls makes the vote indeterminate', async () => {
      const tight = await setup({ limit: { maxCalls: 2 } });
      const v = await vote(tight, userPrincipal('olga'), 'doc:read', d1);
      expect(v.error).to.be.a('string').that.includes('maxCalls 2');
      expect(v.reason).to.deep.equal({ code: 'model_error', model: 'rebac' });
    });

    it('a permission it does not map, or another type, permits nothing', async () => {
      expect((await vote(s, userPrincipal('alice'), 'doc:read', f1)).permitWhen).to.equal(FALSE);
      expect((await vote(s, userPrincipal('alice'), 'doc:share', d1)).permitWhen).to.equal(FALSE);
    });

    it('only the principal itself matches a direct subject', async () => {
      expect((await vote(s, servicePrincipal('alice'), 'doc:read', d1)).permitWhen).to.equal(FALSE);
      expect((await vote(s, servicePrincipal('svc', { companions: [user('alice')] }), 'doc:read', d1)).permitWhen).to.equal(FALSE);
    });
  });

  describe('evaluate on a type', () => {
    it('answers with the native residual, which the registered filter decides per row', async () => {
      const v = await vote(s, userPrincipal('carol'), 'doc:read', { type: 'doc' });
      expect(v.permitWhen).to.deep.equal({ op: REBAC_CHECK_OP, args: { relation: 'read', principal: { type: 'user', id: 'carol' } } });
      const args = (v.permitWhen as { args: unknown }).args;
      expect(await s.model.nativeFilter.matches(args, undefined, d2, s.context())).to.equal(true);
      expect(await s.model.nativeFilter.matches(args, undefined, d1, s.context())).to.equal(false);
      expect(s.model.nativeFilter.principalInArgs).to.equal(true);
    });

    it('the filter answers false where the check is indeterminate', async () => {
      const shallow = await setup({ limit: { maxDepth: 1 } });
      expect(await shallow.model.nativeFilter.matches({ relation: 'read', principal: user('olga') }, undefined, d1, shallow.context())).to.equal(false);
    });
  });

  describe('routing and capabilities', () => {
    it('applies to the permissions it maps, on their type', () => {
      expect(s.model.applies(def('doc:read'), 'doc')).to.equal(true);
      expect(s.model.applies(def('folder:read'), 'folder')).to.equal(true);
      expect(s.model.applies(def('doc:read'), 'folder')).to.equal(false);
    });

    it('declares a permit-only model with the native op on the types it maps', () => {
      const c = s.model.capabilities;
      expect(c.effects).to.deep.equal(['permit']);
      expect(c.residuals).to.include.members([...CORE_FILTER_OPS, REBAC_CHECK_OP]);
      expect(c.sync).to.equal('never');
      expect(c.fields).to.equal(false);
      expect(c.needsSubject).to.equal(false);
      expect([...(c.resourceTypes as readonly string[])].sort()).to.deep.equal(['doc', 'folder']);
    });

    it('registers its native filter at init', async () => {
      const model = new RebacModel({ store: new MemoryTupleStore(), namespaces: NAMESPACES, permissions: PERMISSIONS });
      const init = fakeModelInitContext({ permissions: PERMISSION_INPUTS });
      await model.init(init);
      expect(init.registered.nativeFilters).to.deep.equal([model.nativeFilter]);
    });

    it('refuses a mapped permission nobody registered on first routing', async () => {
      const model = new RebacModel({ store: new MemoryTupleStore(), namespaces: NAMESPACES, permissions: { ...PERMISSIONS, 'doc:share': 'doc#read' } });
      await model.init(fakeModelInitContext({ permissions: PERMISSION_INPUTS }));
      expect(() => model.applies(def('doc:read'), 'doc')).to.throw(AuthzConfigError, 'doc:share');
    });
  });

  describe('configuration', () => {
    it('reads namespaces, permissions and limits from authz.<name>.*', async () => {
      const store = new MemoryTupleStore([tuple(d1, 'owner', user('alice'))]);
      const model = new RebacModel({ store });
      await model.init(fakeModelInitContext({ permissions: PERMISSION_INPUTS, config: { namespaces: NAMESPACES, permissions: PERMISSIONS, limit: { maxDepth: 3, maxCalls: 50 } } }));
      expect(model.schema().targets.get('doc:read')).to.deep.equal({ type: 'doc', name: 'read' });
      expect(await model.check(d1, 'read', user('alice'))).to.equal('member');
      expect(model.store()).to.equal(store);
    });

    it('constructor options win over the config', async () => {
      const model = new RebacModel({ store: new MemoryTupleStore(), namespaces: NAMESPACES, permissions: { 'doc:read': 'doc#owner' } });
      await model.init(fakeModelInitContext({ permissions: PERMISSION_INPUTS, config: { permissions: PERMISSIONS } }));
      expect(model.schema().targets.get('doc:read')).to.deep.equal({ type: 'doc', name: 'owner' });
      expect(model.schema().targets.has('doc:edit')).to.equal(false);
    });

    it('a bad namespace or limit fails init with AuthzConfigError', async () => {
      const bad = new RebacModel({ store: new MemoryTupleStore(), namespaces: { doc: { permissions: { read: 'nope' } } } });
      let error: unknown;
      await bad.init(fakeModelInitContext()).catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      const limit = new RebacModel({ store: new MemoryTupleStore(), namespaces: NAMESPACES, limit: { maxDepth: 0 } });
      error = undefined;
      await limit.init(fakeModelInitContext()).catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.include('maxDepth');
    });
  });

  describe('freshness', () => {
    it('a store write is live and moves the version', async () => {
      const before = s.model.version();
      expect(await allowed(s, 'dave', 'doc:read', d1)).to.equal(false);
      await s.store.write([tuple(d1, 'viewer', user('dave'))], [], user('admin'));
      expect(await allowed(s, 'dave', 'doc:read', d1)).to.equal(true);
      expect(s.model.version()).to.not.equal(before);
    });

    it('invalidate moves the version for its own tags only', () => {
      const v0 = s.model.version();
      s.model.invalidate(['policy']);
      expect(s.model.version()).to.equal(v0);
      s.model.invalidate(['rebac']);
      const v1 = s.model.version();
      expect(v1).to.not.equal(v0);
      s.model.invalidate(['model:rebac']);
      expect(s.model.version()).to.not.equal(v1);
    });

    it('reads each object#relation once per request context', async () => {
      const ctx = s.context();
      let reads = 0;
      const read = s.store.read.bind(s.store);
      s.store.read = (object, relation) => {
        reads++;
        return read(object, relation);
      };
      await s.model.check(d1, 'read', user('olga'), ctx);
      const first = reads;
      await s.model.check(d1, 'read', user('olga'), ctx);
      expect(reads).to.equal(first);
      await s.model.check(d1, 'read', user('olga'), s.context());
      expect(reads).to.equal(2 * first);
    });

    it('dispose stops listening to the store', async () => {
      await s.model.dispose();
      const v = s.model.version();
      await s.store.write([tuple(d2, 'viewer', user('dave'))], [], user('admin'));
      expect(s.model.version()).to.equal(v);
    });
  });
});
