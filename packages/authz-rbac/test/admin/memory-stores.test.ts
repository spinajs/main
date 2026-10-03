import * as chai from 'chai';
import 'mocha';

import { AuthzAdminFailure, AuthzConfigError, GLOBAL, MemoryAuthzAdminBackend } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef, ResourceRef } from '@spinajs/authz';

import { AdminAssignmentStore, MemoryAssignmentStore, MemoryLinkStore, MemoryRuleStore } from '../../src/index.js';
import type { Assignment, RuleDef } from '../../src/index.js';

const expect = chai.expect;

const ALICE: PrincipalRef = { type: 'user', id: 'alice' };
const BOB: PrincipalRef = { type: 'user', id: 'bob' };
const ROOT: PrincipalRef = { type: 'user', id: 'root' };
const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const F1: ResourceRef = { type: 'file', id: 'f1' };
const MEMBERS = { set: { role: 'org.member', scope: O1 } };

const T0 = new Date('2026-10-03T00:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

const ROLLBACK = new Error('roll back');

/** Runs fn in a memory transaction; `commit: false` rolls it back. */
async function inTx<T>(backend: MemoryAuthzAdminBackend, fn: (tx: AuthzTx) => Promise<T>, commit = true): Promise<T | undefined> {
  let out: T | undefined;
  try {
    await backend.transaction('test', async (tx) => {
      out = await fn(tx);
      if (!commit) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out;
}

async function failure(p: Promise<unknown>): Promise<AuthzAdminFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzAdminFailure);
    return e as AuthzAdminFailure;
  }
  throw new Error('expected a rejection');
}

describe('MemoryAssignmentStore', () => {
  let backend: MemoryAuthzAdminBackend;
  let store: MemoryAssignmentStore;
  const grant = (a: Partial<Omit<Assignment, 'id' | 'source'>> = {}) => inTx(backend, (tx) => store.assign({ subject: ALICE, role: 'viewer', scope: P1, ...a }, ROOT, tx)) as Promise<Assignment>;

  beforeEach(() => {
    backend = new MemoryAuthzAdminBackend();
    store = new MemoryAssignmentStore();
  });

  it('assign returns a frozen row with an id, normalised tags, the actor and the memory source', async () => {
    const a = await grant({ tags: ['code', 'inspect', 'code'] });
    expect(a.id).to.match(/^[0-9a-f-]{36}$/);
    expect(a).to.deep.include({ subject: ALICE, role: 'viewer', scope: P1, tags: ['code', 'inspect'], expiresAt: null, grantedBy: ROOT, source: 'memory' });
    expect(Object.isFrozen(a)).to.equal(true);
    expect(await store.byId(a.id)).to.deep.equal(a);
  });

  it('a re-grant of (subject, role, scope) keeps the id and updates tags and expiry; another scope is another row', async () => {
    const a = await grant({ tags: ['x'] });
    const b = await grant({ tags: ['y'], expiresAt: later(1000) });
    expect(b.id).to.equal(a.id);
    expect(b.tags).to.deep.equal(['y']);
    expect(b.expiresAt?.getTime()).to.equal(later(1000).getTime());
    const c = await grant({ scope: P2 });
    expect(c.id).to.not.equal(a.id);
    expect((await store.find({ at: T0 })).total).to.equal(2);
  });

  it('a re-grant revives an expired row under the same id', async () => {
    const a = await grant({ expiresAt: later(-1) });
    expect(await store.forSubjects([ALICE], T0)).to.deep.equal([]);
    const b = await grant({ expiresAt: null });
    expect(b.id).to.equal(a.id);
    expect((await store.forSubjects([ALICE], T0)).map((r) => r.id)).to.deep.equal([a.id]);
  });

  it('copies what it is given: later changes to the input do not reach the store', async () => {
    const tags = ['a'];
    const scope = { type: 'project', id: 'p1' };
    const a = await inTx(backend, (tx) => store.assign({ subject: ALICE, role: 'viewer', scope, tags }, ROOT, tx));
    tags.push('b');
    scope.id = 'p9';
    expect(await store.byId(a!.id)).to.deep.include({ tags: ['a'], scope: P1 });
  });

  it('forSubjects matches principals and subject sets structurally and leaves out expired rows', async () => {
    const live = await grant();
    const set = await grant({ subject: MEMBERS, role: 'editor' });
    await grant({ subject: BOB, role: 'viewer', expiresAt: T0 });
    const future = await grant({ subject: BOB, role: 'editor', expiresAt: later(1) });
    const ids = async (s: Parameters<MemoryAssignmentStore['forSubjects']>[0]) => (await store.forSubjects(s, T0)).map((r) => r.id).sort();
    expect(await ids([{ type: 'user', id: 'alice' }])).to.deep.equal([live.id]);
    expect(await ids([{ set: { role: 'org.member', scope: { type: 'org', id: 'o1' } } }])).to.deep.equal([set.id]);
    expect(await ids([{ set: { role: 'org.member', scope: { type: 'org', id: 'o2' } } }])).to.deep.equal([]);
    expect(await ids([BOB])).to.deep.equal([future.id]);
    expect(await ids([ALICE, MEMBERS, BOB])).to.deep.equal([live.id, set.id, future.id].sort());
    expect(await ids([])).to.deep.equal([]);
  });

  it('holders lists the live subjects of a role at exactly that scope', async () => {
    await grant();
    await grant({ subject: MEMBERS });
    await grant({ subject: BOB, expiresAt: T0 });
    await grant({ subject: { type: 'user', id: 'carol' }, scope: P2 });
    await grant({ subject: { type: 'user', id: 'dora' }, role: 'editor' });
    expect(await store.holders('viewer', { type: 'project', id: 'p1' }, T0)).to.deep.equal([ALICE, MEMBERS]);
    expect(await store.holders('viewer', GLOBAL, T0)).to.deep.equal([]);
  });

  it('byId returns expired rows and null for an unknown id', async () => {
    const a = await grant({ expiresAt: later(-1000) });
    expect((await store.byId(a.id))?.id).to.equal(a.id);
    expect(await store.byId('nope')).to.equal(null);
  });

  it('update changes tags and expiry and keeps the rest', async () => {
    const a = await grant({ tags: ['a'] });
    const b = await inTx(backend, (tx) => store.update(a.id, { tags: ['c', 'b', 'c'] }, BOB, tx));
    expect(b).to.deep.include({ id: a.id, tags: ['b', 'c'], expiresAt: null, grantedBy: ROOT });
    const c = await inTx(backend, (tx) => store.update(a.id, { expiresAt: later(5) }, BOB, tx));
    expect(c!.tags).to.deep.equal(['b', 'c']);
    expect(c!.expiresAt?.getTime()).to.equal(later(5).getTime());
  });

  it('revoke and update of an unknown id fail with not_found', async () => {
    expect((await failure(inTx(backend, (tx) => store.revoke('nope', ROOT, tx)))).code).to.equal('not_found');
    expect((await failure(inTx(backend, (tx) => store.update('nope', { tags: [] }, ROOT, tx)))).code).to.equal('not_found');
  });

  it('find filters by scope, subject, role and expiry, and pages', async () => {
    const rows: Assignment[] = [];
    for (let i = 0; i < 5; i++) rows.push(await grant({ subject: { type: 'user', id: `u${i}` } }));
    const expired = await grant({ subject: BOB, expiresAt: T0 });
    const other = await grant({ scope: P2, role: 'editor' });
    expect((await store.find({ at: T0 })).total).to.equal(6);
    expect((await store.find({ at: T0, includeExpired: true })).total).to.equal(7);
    expect((await store.find({ at: T0, scope: P2 })).items.map((r) => r.id)).to.deep.equal([other.id]);
    expect((await store.find({ at: T0, role: 'editor' })).items.map((r) => r.id)).to.deep.equal([other.id]);
    expect((await store.find({ at: T0, subject: BOB, includeExpired: true })).items.map((r) => r.id)).to.deep.equal([expired.id]);
    expect((await store.find({ at: T0, subject: BOB })).total).to.equal(0);
    const page = await store.find({ at: T0, scope: P1 }, { limit: 2, offset: 1 });
    expect(page.total).to.equal(5);
    expect(page.items.map((r) => r.id)).to.deep.equal([rows[1].id, rows[2].id]);
  });

  it('forgetScope removes the rows at the scope, not rows whose subject is a set at it', async () => {
    const atOrg = await grant({ scope: O1, role: 'org.member' });
    const setSubject = await grant({ subject: MEMBERS, scope: P1 });
    const elsewhere = await grant({ scope: P2 });
    const gone = await inTx(backend, (tx) => store.forgetScope(O1, tx));
    expect(gone!.map((r) => r.id)).to.deep.equal([atOrg.id]);
    expect(await store.byId(atOrg.id)).to.equal(null);
    expect(await store.byId(setSubject.id)).to.not.equal(null);
    expect(await store.byId(elsewhere.id)).to.not.equal(null);
  });

  it('a rollback undoes assign, re-grant, update, revoke and forgetScope', async () => {
    const a = await grant({ tags: ['a'] });
    const before = JSON.stringify(await store.find({ at: T0, includeExpired: true }));
    await inTx(
      backend,
      async (tx) => {
        await store.assign({ subject: BOB, role: 'viewer', scope: P1 }, ROOT, tx);
        await store.assign({ subject: ALICE, role: 'viewer', scope: P1, tags: ['z'] }, ROOT, tx);
        await store.update(a.id, { expiresAt: later(1) }, ROOT, tx);
        await store.revoke(a.id, ROOT, tx);
        await store.assign({ subject: ALICE, role: 'viewer', scope: P1 }, ROOT, tx);
        await store.forgetScope(P1, tx);
      },
      false,
    );
    expect(JSON.stringify(await store.find({ at: T0, includeExpired: true }))).to.equal(before);
    expect((await store.byId(a.id))?.tags).to.deep.equal(['a']);
  });

  it('version changes on every write and on a rollback', async () => {
    const seen = new Set([await store.version()]);
    const a = await grant();
    seen.add(await store.version());
    await inTx(backend, (tx) => store.update(a.id, { tags: ['t'] }, ROOT, tx));
    seen.add(await store.version());
    await inTx(backend, (tx) => store.revoke(a.id, ROOT, tx), false);
    seen.add(await store.version());
    expect(seen.size).to.equal(4);
  });

  it('refuses a transaction that is not a memory transaction', async () => {
    let err: unknown;
    try {
      await store.assign({ subject: ALICE, role: 'viewer', scope: P1 }, ROOT, { driver: {} });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect((await store.find({ at: T0 })).total).to.equal(0);
  });
});

describe('MemoryLinkStore', () => {
  let backend: MemoryAuthzAdminBackend;
  let assignments: MemoryAssignmentStore;
  let links: MemoryLinkStore;
  const create = (scope: ResourceRef = P1, role = 'viewer', extra: { tags?: string[]; expiresAt?: Date | null } = {}) => inTx(backend, (tx) => links.create({ scope, expiresAt: extra.expiresAt ?? null, attributes: { org_only: true }, createdBy: ROOT }, { role, tags: extra.tags }, ROOT, tx)) as Promise<{ link: { id: string; scope: ResourceRef }; token: string }>;

  beforeEach(() => {
    backend = new MemoryAuthzAdminBackend();
    assignments = new MemoryAssignmentStore();
    links = new MemoryLinkStore(assignments);
  });

  it('create returns the link and a 32-byte base64url token, and assigns the role to link:<id>', async () => {
    const { link, token } = await create(P1, 'viewer', { tags: ['code', 'code'] });
    expect(token).to.match(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).to.have.length(32);
    expect(link).to.deep.equal({ id: link.id, scope: P1, expiresAt: null, attributes: { org_only: true }, createdBy: ROOT });
    expect(JSON.stringify(link)).to.not.include(token);
    const granted = await assignments.forSubjects([{ type: 'link', id: link.id }], T0);
    expect(granted).to.have.length(1);
    expect(granted[0]).to.deep.include({ role: 'viewer', scope: P1, tags: ['code'], grantedBy: ROOT });
  });

  it('two links get different tokens', async () => {
    const a = await create();
    const b = await create();
    expect(a.token).to.not.equal(b.token);
  });

  it('byToken finds the link by the hash of its token; a wrong, short or revoked token is null', async () => {
    const { link, token } = await create();
    await create(P2);
    expect((await links.byToken(token))?.id).to.equal(link.id);
    expect(await links.byToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).to.equal(null);
    expect(await links.byToken('x')).to.equal(null);
    expect(await links.byToken('')).to.equal(null);
    await inTx(backend, (tx) => links.revoke(link.id, ROOT, tx));
    expect(await links.byToken(token)).to.equal(null);
  });

  it('keeps no token: neither the store nor what it returns holds it', async () => {
    const { token } = await create();
    expect(JSON.stringify(Object.values(links))).to.not.include(token);
    expect(JSON.stringify(await links.find({}))).to.not.include(token);
  });

  it('byToken returns an expired link (the link ceiling refuses it), byId too', async () => {
    const { link, token } = await create(P1, 'viewer', { expiresAt: later(-1) });
    expect((await links.byToken(token))?.id).to.equal(link.id);
    expect((await links.byId(link.id))?.id).to.equal(link.id);
  });

  it('revoke removes the link and its assignment; unknown ids fail with not_found', async () => {
    const { link } = await create();
    await inTx(backend, (tx) => links.revoke(link.id, ROOT, tx));
    expect(await links.byId(link.id)).to.equal(null);
    expect(await assignments.forSubjects([{ type: 'link', id: link.id }], T0)).to.deep.equal([]);
    expect((await failure(inTx(backend, (tx) => links.revoke(link.id, ROOT, tx)))).code).to.equal('not_found');
  });

  it('update changes expiry and attributes', async () => {
    const { link } = await create();
    const u = await inTx(backend, (tx) => links.update(link.id, { expiresAt: later(9), attributes: { org_only: false } }, ROOT, tx));
    expect(u!.expiresAt?.getTime()).to.equal(later(9).getTime());
    expect(u!.attributes).to.deep.equal({ org_only: false });
    const v = await inTx(backend, (tx) => links.update(link.id, { expiresAt: null }, ROOT, tx));
    expect(v!).to.deep.include({ expiresAt: null, attributes: { org_only: false } });
    expect((await failure(inTx(backend, (tx) => links.update('nope', {}, ROOT, tx)))).code).to.equal('not_found');
  });

  it('find filters by scope and pages', async () => {
    const a = await create(P1);
    const b = await create(P1);
    await create(P2);
    expect((await links.find({})).total).to.equal(3);
    const page = await links.find({ scope: P1 }, { limit: 1, offset: 1 });
    expect(page.total).to.equal(2);
    expect(page.items.map((l) => l.id)).to.deep.equal([b.link.id]);
    expect(page.items[0]).to.not.have.property('tokenHash');
    expect(a.link.id).to.not.equal(b.link.id);
  });

  it('forgetScope removes the links at the scope and their assignments', async () => {
    const a = await create(P1);
    const b = await create(P2);
    const gone = await inTx(backend, (tx) => links.forgetScope(P1, tx));
    expect(gone!.map((l) => l.id)).to.deep.equal([a.link.id]);
    expect(await links.byId(a.link.id)).to.equal(null);
    expect(await assignments.forSubjects([{ type: 'link', id: a.link.id }], T0)).to.deep.equal([]);
    expect(await links.byId(b.link.id)).to.not.equal(null);
  });

  it('a rollback undoes create, update, revoke and forgetScope in both stores', async () => {
    const { link, token } = await create();
    const before = JSON.stringify([await links.find({}), await assignments.find({ at: T0, includeExpired: true })]);
    await inTx(
      backend,
      async (tx) => {
        await links.create({ scope: P2, attributes: {} }, { role: 'viewer' }, ROOT, tx);
        await links.update(link.id, { attributes: { x: 1 } }, ROOT, tx);
        await links.revoke(link.id, ROOT, tx);
        await links.forgetScope(P2, tx);
      },
      false,
    );
    expect(JSON.stringify([await links.find({}), await assignments.find({ at: T0, includeExpired: true })])).to.equal(before);
    expect((await links.byToken(token))?.id).to.equal(link.id);
  });

  it('preloads links with fixed tokens and writes their link:<id> assignments', async () => {
    const seeded = new MemoryLinkStore(assignments, {
      links: [
        { link: { id: 'l1', scope: P1, expiresAt: later(5), attributes: { org_only: true }, createdBy: ROOT }, token: 'tok-l1', role: 'viewer', tags: ['b', 'a', 'a'] },
        { link: { id: 'l2', scope: P2, attributes: {} }, token: 'tok-l2', role: 'editor' },
      ],
    });
    expect(await seeded.byToken('tok-l1')).to.deep.equal({ id: 'l1', scope: P1, expiresAt: later(5), attributes: { org_only: true }, createdBy: ROOT });
    expect((await seeded.byToken('tok-l2'))?.id).to.equal('l2');
    expect(await seeded.byToken('tok-l3')).to.equal(null);
    expect(JSON.stringify(Object.values(seeded))).to.not.include('tok-l1');
    const [grant] = await assignments.forSubjects([{ type: 'link', id: 'l1' }], T0);
    expect(grant).to.deep.include({ subject: { type: 'link', id: 'l1' }, role: 'viewer', scope: P1, tags: ['a', 'b'], expiresAt: null, grantedBy: ROOT });
    expect((await assignments.forSubjects([{ type: 'link', id: 'l2' }], T0))[0]).to.deep.include({ role: 'editor', scope: P2, tags: [] });
    await inTx(backend, (tx) => seeded.revoke('l1', ROOT, tx));
    expect(await assignments.forSubjects([{ type: 'link', id: 'l1' }], T0)).to.deep.equal([]);
  });

  it('refuses preloaded links it cannot hold', () => {
    const link = { id: 'l1', scope: P1, attributes: {} };
    const other = new (class extends MemoryAssignmentStore {})();
    expect(
      () =>
        new MemoryLinkStore(assignments, {
          links: [
            { link, token: 't', role: 'viewer' },
            { link, token: 'u', role: 'viewer' },
          ],
        }),
    ).to.throw(AuthzConfigError, /twice/);
    expect(() => new MemoryLinkStore(assignments, { links: [{ link, token: '', role: 'viewer' }] })).to.throw(AuthzConfigError, /token/);
    expect(() => new MemoryLinkStore(other, { links: [{ link, token: 't', role: 'viewer' }] })).to.not.throw();
    const foreign = Object.create(AdminAssignmentStore.prototype) as AdminAssignmentStore;
    expect(() => new MemoryLinkStore(foreign, { links: [{ link, token: 't', role: 'viewer' }] })).to.throw(AuthzConfigError, /MemoryAssignmentStore/);
  });

  it('version changes on every write', async () => {
    const v0 = await links.version();
    const { link } = await create();
    const v1 = await links.version();
    await inTx(backend, (tx) => links.revoke(link.id, ROOT, tx));
    const v2 = await links.version();
    expect(new Set([v0, v1, v2]).size).to.equal(3);
  });
});

describe('MemoryRuleStore', () => {
  let backend: MemoryAuthzAdminBackend;
  let rules: MemoryRuleStore;
  const rule = (r: Partial<Omit<RuleDef, 'source'>> = {}): Omit<RuleDef, 'source'> => ({ id: 'r1', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor', ...r });
  const put = (r: Omit<RuleDef, 'source'>, commit = true) => inTx(backend, (tx) => rules.put(r, ROOT, tx), commit);

  beforeEach(() => {
    backend = new MemoryAuthzAdminBackend();
    rules = new MemoryRuleStore();
  });

  it('put inserts and replaces by id; byId returns the rule with the memory source', async () => {
    await put(rule());
    expect(await rules.byId('r1')).to.deep.equal({ ...rule(), source: 'memory' });
    await put(rule({ minRole: 'viewer' }));
    expect((await rules.byId('r1'))?.minRole).to.equal('viewer');
    expect((await rules.find({})).total).to.equal(1);
    expect(await rules.byId('nope')).to.equal(null);
  });

  it('assertStorable accepts every rule', () => {
    expect(() => rules.assertStorable(rule({ resource: { attr: 'resource.name', glob: 'a*b*' } }))).to.not.throw();
  });

  it('forPath returns the live rules whose scope is on the path', async () => {
    await put(rule({ id: 'at-org', scope: O1 }));
    await put(rule({ id: 'at-p1', scope: P1 }));
    await put(rule({ id: 'at-p2', scope: P2 }));
    await put(rule({ id: 'at-f1', scope: F1 }));
    await put(rule({ id: 'global', scope: GLOBAL }));
    await put(rule({ id: 'expired', scope: P1, expiresAt: T0 }));
    await put(rule({ id: 'future', scope: P1, expiresAt: later(1) }));
    const ids = (await rules.forPath([GLOBAL, { type: 'org', id: 'o1' }, P1], T0)).map((r) => r.id).sort();
    expect(ids).to.deep.equal(['at-org', 'at-p1', 'future', 'global']);
    expect((await rules.byId('expired'))?.id).to.equal('expired');
  });

  it('delete removes a rule; an unknown id fails with not_found', async () => {
    await put(rule());
    await inTx(backend, (tx) => rules.delete('r1', tx));
    expect(await rules.byId('r1')).to.equal(null);
    expect((await failure(inTx(backend, (tx) => rules.delete('r1', tx)))).code).to.equal('not_found');
  });

  it('find filters by scope and pages; forgetScope removes the rules at the scope', async () => {
    await put(rule({ id: 'a' }));
    await put(rule({ id: 'b' }));
    await put(rule({ id: 'c', scope: P2 }));
    const page = await rules.find({ scope: P1 }, { limit: 1, offset: 1 });
    expect(page).to.deep.include({ total: 2 });
    expect(page.items.map((r) => r.id)).to.deep.equal(['b']);
    const gone = await inTx(backend, (tx) => rules.forgetScope(P1, tx));
    expect(gone!.map((r) => r.id)).to.deep.equal(['a', 'b']);
    expect((await rules.find({})).items.map((r) => r.id)).to.deep.equal(['c']);
  });

  it('a rollback undoes put, replace, delete and forgetScope; version changes on every write', async () => {
    await put(rule());
    const v1 = await rules.version();
    const before = JSON.stringify(await rules.find({}));
    await inTx(
      backend,
      async (tx) => {
        await rules.put(rule({ id: 'r2' }), ROOT, tx);
        await rules.put(rule({ minRole: 'viewer' }), ROOT, tx);
        await rules.delete('r1', tx);
        await rules.forgetScope(P1, tx);
      },
      false,
    );
    expect(JSON.stringify(await rules.find({}))).to.equal(before);
    expect(await rules.version()).to.not.equal(v1);
  });
});
