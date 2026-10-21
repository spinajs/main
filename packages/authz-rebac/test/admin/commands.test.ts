import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';
import { AuthzConfigError } from '@spinajs/authz';
import type { AuthzAdminQuery, AuthzCommand, AuthzCommandOf } from '@spinajs/authz';

import { RebacScopeForgetter, RebacTupleHandler, RebacTupleReader } from '../../src/index.js';
import type { TupleDeleteCommand, TupleWriteCommand, TuplesAdminQuery } from '../../src/index.js';
import { d1, d2, ref, set, tuple, user } from '../support/world.js';
import { AuthzAdminFailure, failure, installHost, ok, rebacDomain, remove, resetHost, uninstallHost, write } from './support.js';
import type { RebacDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const dave = userPrincipal('dave');

describe('authz-rebac: tuple commands through AuthzAdmin', function () {
  this.timeout(20_000);
  let d: RebacDomain;

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    d = await rebacDomain();
  });

  it('types the commands and the query as AuthzCommand and AuthzAdminQuery', () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const yes = <_T extends true>(): void => {};
    yes<Equal<AuthzCommandOf<'tuple.write'>, TupleWriteCommand>>();
    yes<Equal<AuthzCommandOf<'tuple.delete'>, TupleDeleteCommand>>();
    yes<Equal<Extract<AuthzAdminQuery, { kind: 'tuples' }>, TuplesAdminQuery>>();
    const c: AuthzCommand = { kind: 'tuple.write', tuple: tuple(d1, 'viewer', user('dave')) };
    expect(c.kind).to.equal('tuple.write');
  });

  describe('tuple.write', () => {
    it('stores the tuple, tags the change and emits TupleChanged', async () => {
      const [r] = ok(await d.admin.execute(alice, [write(tuple(d1, 'viewer', user('dave')))]));
      expect(r).to.deep.equal({ ok: true, kind: 'tuple.write', affected: 1 });
      expect(d.store.has(tuple(d1, 'viewer', user('dave')))).to.equal(true);
      expect([...d.bus.published[0].tags].sort()).to.deep.equal(['model:rebac', 'rebac', 'rebac:doc']);
      expect(d.sink.events.map((e) => [e.type, e.data, e.actor])).to.deep.equal([['TupleChanged', { object: d1, relation: 'viewer', subject: user('dave'), op: 'write' }, { type: 'user', id: 'alice' }]]);
      expect(d.audit.entries.filter((e) => e.kind === 'admin').map((e) => [e.permission, e.resource])).to.deep.equal([['authz:tuples.manage', d1]]);
    });

    it('changes the next decision', async () => {
      expect(await d.service.can(dave, 'doc:read', d1)).to.equal(false);
      ok(await d.admin.execute(alice, [write(tuple(d1, 'viewer', user('dave')))]));
      expect(await d.service.can(dave, 'doc:read', d1)).to.equal(true);
    });

    it('writing a stored tuple is a no-op with affected 0', async () => {
      ok(await d.admin.execute(alice, [write(tuple(d1, 'viewer', user('dave')))]));
      const [r] = ok(await d.admin.execute(alice, [write(tuple(d1, 'viewer', user('dave')))]));
      expect(r.affected).to.equal(0);
    });

    it('checks authz:tuples.manage on the tuple object', async () => {
      ok(await d.admin.execute(bob, [write(tuple(d1, 'viewer', user('dave')))]));
      expect(failure(await d.admin.execute(bob, [write(tuple(d2, 'viewer', user('dave')))]))).to.deep.equal({ at: 0, code: 'forbidden' });
    });

    it('refuses a tuple the namespaces do not admit', async () => {
      expect(failure(await d.admin.execute(alice, [write(tuple(ref('note', 'n1'), 'owner', user('dave')))]))).to.deep.include({ code: 'unknown_relation' });
      expect(failure(await d.admin.execute(alice, [write(tuple(d1, 'read', user('dave')))]))).to.deep.include({ code: 'unknown_relation', field: 'tuple.relation' });
      expect(failure(await d.admin.execute(alice, [write(tuple(d1, 'owner', set('group', 'eng', 'member')))]))).to.deep.include({ code: 'subject_not_allowed', field: 'tuple.subject' });
      expect(d.store.has(tuple(d1, 'owner', set('group', 'eng', 'member')))).to.equal(false);
    });

    it('refuses a malformed tuple', async () => {
      const bad = { kind: 'tuple.write', tuple: { object: { type: 'doc' }, relation: 'viewer', subject: user('dave') } } as unknown as AuthzCommand;
      expect(failure(await d.admin.execute(alice, [bad]))).to.deep.include({ code: 'invalid_command', field: 'tuple' });
    });

    it('a later failure in the batch rolls the write back', async () => {
      const out = await d.admin.execute(alice, [write(tuple(d1, 'viewer', user('dave'))), write(tuple(d1, 'read', user('dave')))]);
      expect(failure(out).at).to.equal(1);
      expect(d.store.has(tuple(d1, 'viewer', user('dave')))).to.equal(false);
    });

    it('needs a TupleStore registered in the domain', async () => {
      await resetHost();
      const bare = await rebacDomain('bare', { without: ['store'] });
      let error: unknown;
      await bare.admin.execute(alice, [write(tuple(d1, 'viewer', user('dave')))]).catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
    });
  });

  describe('tuple.delete', () => {
    beforeEach(async () => {
      await resetHost();
      d = await rebacDomain('test', { tuples: [tuple(d1, 'viewer', user('dave'))] });
    });

    it('removes the tuple and takes the access away', async () => {
      expect(await d.service.can(dave, 'doc:read', d1)).to.equal(true);
      const [r] = ok(await d.admin.execute(alice, [remove(tuple(d1, 'viewer', user('dave')))]));
      expect(r).to.deep.equal({ ok: true, kind: 'tuple.delete', affected: 1 });
      expect(d.sink.events.map((e) => e.data.op)).to.deep.equal(['delete']);
      expect(await d.service.can(dave, 'doc:read', d1)).to.equal(false);
    });

    it('removing a missing tuple is a no-op with affected 0 and no event', async () => {
      const [r] = ok(await d.admin.execute(alice, [remove(tuple(d1, 'viewer', user('erin')))]));
      expect(r.affected).to.equal(0);
      expect(d.sink.events).to.deep.equal([]);
    });
  });

  describe('the tuples query', () => {
    beforeEach(async () => {
      await resetHost();
      d = await rebacDomain('test', { tuples: [tuple(d1, 'viewer', user('dave')), tuple(d1, 'owner', user('alice')), tuple(d2, 'viewer', set('group', 'eng', 'member'))] });
    });

    it('lists by object, namespace, relation and subject, with pages', async () => {
      expect((await d.admin.list(alice, { kind: 'tuples' })).total).to.equal(3);
      expect((await d.admin.list(alice, { kind: 'tuples', scope: d1 })).items).to.deep.equal([tuple(d1, 'owner', user('alice')), tuple(d1, 'viewer', user('dave'))]);
      expect((await d.admin.list(alice, { kind: 'tuples', scope: { type: 'doc' }, relation: 'viewer' })).total).to.equal(2);
      expect((await d.admin.list(alice, { kind: 'tuples', subject: set('group', 'eng', 'member') })).items).to.deep.equal([tuple(d2, 'viewer', set('group', 'eng', 'member'))]);
      const page = await d.admin.list(alice, { kind: 'tuples', page: { limit: 1, offset: 1 } });
      expect(page).to.deep.equal({ items: [tuple(d1, 'viewer', user('dave'))], total: 3 });
    });

    it('checks authz:tuples.read at the scope', async () => {
      expect((await d.admin.list(bob, { kind: 'tuples', scope: d1 })).total).to.equal(2);
      let error: unknown;
      await d.admin.list(bob, { kind: 'tuples' }).catch((e: unknown) => (error = e));
      expect((error as AuthzAdminFailure).code).to.equal('forbidden');
    });

    it('refuses a malformed filter', async () => {
      let error: unknown;
      await d.admin.list(alice, { kind: 'tuples', relation: 7 } as unknown as AuthzAdminQuery).catch((e: unknown) => (error = e));
      expect((error as AuthzAdminFailure).code).to.equal('invalid_query');
    });
  });

  describe('scope.forget', () => {
    it('removes the tuples whose object is the scope', async () => {
      await resetHost();
      d = await rebacDomain('test', { tuples: [tuple(d1, 'viewer', user('dave')), tuple(d2, 'viewer', user('dave'))] });
      ok(await d.admin.execute(alice, [{ kind: 'scope.forget', scope: d1 }]));
      expect(d.store.has(tuple(d1, 'viewer', user('dave')))).to.equal(false);
      expect(d.store.has(tuple(d2, 'viewer', user('dave')))).to.equal(true);
    });
  });

  it('registers the handler, the reader and the forgetter in root DI', () => {
    expect(new RebacTupleHandler().kinds).to.deep.equal(['tuple.write', 'tuple.delete']);
    expect(new RebacTupleReader().kinds).to.deep.equal(['tuples']);
    expect(new RebacScopeForgetter()).to.be.instanceOf(RebacScopeForgetter);
  });
});
