import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, AuthzAdminReader, AuthzConfigError, MemoryAuthzAdminBackend, ScopeForgetter, SYSTEM } from '@spinajs/authz';
import type { Policy } from '@spinajs/authz';

import { AbacPolicyReader, AbacScopeForgetter } from '../../src/index.js';
import { F1, G, O1, P1, P2, abacDomain, installHost, ok, rejection, resetHost, snapshot, stored, uninstallHost } from './support.js';
import type { AbacDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');

const TYPE_LEVEL = { type: 'project' };

const POLICIES: Policy[] = [stored('a', { scope: P1 }), stored('b', { scope: P1 }), stored('c', { scope: P1 }), stored('d', { scope: P2 }), stored('e'), stored('f', { scope: G }), stored('g', { scope: TYPE_LEVEL }), stored('h', { scope: O1 })];

describe('ABAC policy reader and scope forgetter', function () {
  this.timeout(20000);
  let d: AbacDomain;

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    d = await abacDomain('test', { policies: POLICIES });
  });

  describe('list policies', () => {
    it('lists the policies at exactly the scope, by id, a page at a time', async () => {
      const at = await d.admin.list(alice, { kind: 'policies', scope: P1 });
      expect(at).to.deep.equal({ items: [stored('a', { scope: P1 }), stored('b', { scope: P1 }), stored('c', { scope: P1 })], total: 3 });
      const page = await d.admin.list(alice, { kind: 'policies', scope: P1, page: { limit: 1, offset: 1 } });
      expect(page).to.deep.equal({ items: [stored('b', { scope: P1 })], total: 3 });
      expect((await d.admin.list(alice, { kind: 'policies', scope: TYPE_LEVEL })).items.map((p) => (p as Policy).id)).to.deep.equal(['g']);
    });

    it('GLOBAL lists the unscoped policies; no scope lists them all', async () => {
      expect((await d.admin.list(alice, { kind: 'policies', scope: G })).items.map((p) => (p as Policy).id)).to.deep.equal(['e', 'f']);
      const all = await d.admin.list(alice, { kind: 'policies' });
      expect(all.total).to.equal(POLICIES.length);
      expect(all.items.map((p) => (p as Policy).id)).to.deep.equal(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    });

    it('needs authz:policies.read at the scope (AuthzAdmin checks it)', async () => {
      expect(((await rejection(d.admin.list(bob, { kind: 'policies', scope: P2 }))) as AuthzAdminFailure).code).to.equal('forbidden');
      expect((await d.admin.list(bob, { kind: 'policies', scope: P1 })).total).to.equal(3);
    });

    it('refuses a malformed scope or page as invalid_query', async () => {
      const r = new AbacPolicyReader();
      const code = async (q: unknown) => ((await rejection(r.list(q as never, d.context()))) as AuthzAdminFailure).code;
      expect(await code({ kind: 'policies', scope: { type: '' } })).to.equal('invalid_query');
      expect(await code({ kind: 'policies', page: { limit: -1, offset: 0 } })).to.equal('invalid_query');
      expect(await code({ kind: 'rules' })).to.equal('not_found');
      // A direct call without a page gets the admin's default.
      expect((await r.list({ kind: 'policies' }, d.context())).items).to.have.length(8);
    });

    it('is registered for kind policies', async () => {
      const readers = (await d.container.resolve(Array.chainOf(AuthzAdminReader))) as AuthzAdminReader[];
      expect(readers.filter((x) => x instanceof AbacPolicyReader).map((x) => [...x.kinds])).to.deep.equal([['policies']]);
    });

    it('rejects without a writable PolicyStore', async () => {
      await resetHost();
      d = await abacDomain('test', { without: ['store'] });
      expect(await rejection(d.admin.list(alice, { kind: 'policies' }))).to.be.instanceOf(AuthzConfigError);
    });
  });

  describe('scope.forget', () => {
    it('deletes the policies whose scope is exactly the node', async () => {
      const [r] = ok(await d.admin.execute(alice, [{ kind: 'scope.forget', scope: P1 }]));
      expect(r.affected).to.equal(3);
      expect(Object.keys(await snapshot(d.store))).to.deep.equal(['d', 'e', 'f', 'g', 'h']);
      expect([...d.bus.published[0].tags].sort()).to.deep.equal(['policy', 'policy:a', 'policy:b', 'policy:c', 'scope:project:p1']);
      const changed = d.sink.events.filter((e) => e.type === 'PolicyChanged').map((e) => e.data);
      expect(changed).to.deep.equal(['a', 'b', 'c'].map((id) => ({ id, scope: P1, op: 'delete' })));
    });

    it('forgets nothing at a node without policies, and needs a memory transaction for a memory store', async () => {
      const f = new AbacScopeForgetter();
      expect(await new MemoryAuthzAdminBackend().transaction('test', (tx) => f.forget(F1, d.context(), tx))).to.deep.equal({ affected: 0, tags: [], events: [] });
      expect(await rejection(f.forget(P1, d.context(), { driver: {} }))).to.be.instanceOf(AuthzConfigError);
      expect(Object.keys(await snapshot(d.store))).to.have.length(POLICIES.length);
    });

    it('is registered as a ScopeForgetter and skips a domain without a PolicyStore', async () => {
      const forgetters = (await d.container.resolve(Array.chainOf(ScopeForgetter))) as ScopeForgetter[];
      expect(forgetters.filter((x) => x instanceof AbacScopeForgetter)).to.have.length(1);
      await resetHost();
      d = await abacDomain('test', { without: ['store'] });
      const [r] = ok(await d.admin.execute(SYSTEM, [{ kind: 'scope.forget', scope: P1 }]));
      expect(r.affected).to.equal(0);
    });
  });
});
