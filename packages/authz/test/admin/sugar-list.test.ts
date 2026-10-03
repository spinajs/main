import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminBackend, AuthzAdminFailure, AuthzAdminReader, AuthzConfigError, AuthzWriteHandler, GLOBAL, MemoryAuthzAdminBackend, SYSTEM, adminActor } from '@spinajs/authz';
import type { AdminContext, AuthzAdminQuery, AuthzCommand, AuthzEvent, AuthzTx, Permission, ResourceRef } from '@spinajs/authz';
import { adminConfig, adminDomain, installHost, rejection, resetHost, setConfig, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const p1: ResourceRef = { type: 'project', id: 'p1' };
const ALICE = { type: 'user', id: 'alice' };

/** Every kind neither the fake assignment handler nor the core's ScopeAttributeHandler claims: records the command, fails on id 'missing'. */
class EchoHandler extends AuthzWriteHandler {
  static seen: AuthzCommand[] = [];
  readonly kinds = ['link.revoke', 'assignment.setTags', 'rule.put', 'rule.delete', 'policy.put', 'policy.delete', 'scope.forget'] as const;

  async validate(c: AuthzCommand): Promise<void> {
    if ('id' in c && c.id === 'missing') throw new AuthzAdminFailure('not_found', 'no such row', 'id');
  }

  permission(): { permission: Permission; resource: ResourceRef } {
    return { permission: 'authz:assignments.manage', resource: p1 };
  }

  async apply(c: AuthzCommand): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    EchoHandler.seen.push(c);
    return { affected: 1, tags: [], events: [] };
  }
}

class FakeReader extends AuthzAdminReader {
  static calls: { q: AuthzAdminQuery; ctx: AdminContext }[] = [];
  readonly kinds = ['assignments', 'links'] as const;

  async list(q: AuthzAdminQuery, ctx: AdminContext): Promise<{ items: readonly unknown[]; total: number }> {
    FakeReader.calls.push({ q, ctx });
    const all = ['a', 'b', 'c'];
    const page = (q as { page?: { limit: number; offset: number } }).page ?? { limit: 50, offset: 0 };
    return { items: all.slice(page.offset, page.offset + page.limit), total: all.length };
  }
}

class OtherReader extends AuthzAdminReader {
  readonly kinds = ['links'] as const;
  async list(): Promise<{ items: readonly unknown[]; total: number }> {
    return { items: [], total: 0 };
  }
}

/** Wraps the rejection of fn, as an ORM driver may. */
class WrappingBackend extends MemoryAuthzAdminBackend {
  async transaction<T>(domain: string, fn: (tx: AuthzTx) => Promise<T>): Promise<T> {
    try {
      return await super.transaction(domain, fn);
    } catch (e) {
      throw new Error('driver: transaction rolled back', { cause: e });
    }
  }
}

/** Never runs the batch. */
class LazyBackend extends MemoryAuthzAdminBackend {
  async transaction<T>(): Promise<T> {
    return undefined as T;
  }
}

async function domain(register?: (d: AdminDomain['container']) => void): Promise<AdminDomain> {
  return adminDomain('test', {
    register(c) {
      c.register(EchoHandler).as(AuthzWriteHandler);
      c.register(FakeReader).as(AuthzAdminReader);
      register?.(c);
    },
  });
}

describe('DefaultAuthzAdmin sugar methods and list', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
    EchoHandler.seen = [];
    FakeReader.calls = [];
  });

  describe('sugar', () => {
    it('assign returns the Assignment the handler wrote', async () => {
      const d = await domain();
      const a = await d.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'editor', scope: p1 });
      expect(a).to.deep.include({ id: 'a1', role: 'editor', scope: p1, subject: { type: 'user', id: 'bob' } });
      expect(d.store.rows.has('a1')).to.equal(true);
    });

    it('assign throws AuthzAdminFailure with the code and field of the failed result', async () => {
      const d = await domain();
      const e = await rejection(d.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'unknown', scope: p1 }));
      expect(e).to.be.instanceOf(AuthzAdminFailure);
      expect((e as AuthzAdminFailure).code).to.equal('unknown_role');
      expect((e as AuthzAdminFailure).field).to.equal('role');
    });

    it('a dry-run assign returns the would-be row and writes nothing', async () => {
      const d = await domain();
      const a = await d.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'editor', scope: p1 }, { dryRun: true });
      expect(a.id).to.equal('a1');
      expect(d.store.rows.size).to.equal(0);
      expect(d.bus.published).to.deep.equal([]);
    });

    it('a replayed assign returns the first row without a second write', async () => {
      const d = await domain();
      const first = await d.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'editor', scope: p1 }, { idempotencyKey: 'k' });
      const again = await d.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'editor', scope: p1 }, { idempotencyKey: 'k' });
      expect(again).to.deep.equal(first);
      expect(d.store.rows.size).to.equal(1);
    });

    it('createLink returns the link and its token', async () => {
      const d = await domain();
      const { link, token } = await d.admin.createLink(alice, { scope: p1, role: 'viewer' });
      expect(link).to.deep.include({ id: 'a1', scope: p1 });
      expect(token).to.equal('tok-a1');
    });

    it('a replayed createLink refuses: the token is shown once', async () => {
      const d = await domain();
      await d.admin.createLink(alice, { scope: p1, role: 'viewer' }, { idempotencyKey: 'k' });
      const e = await rejection(d.admin.createLink(alice, { scope: p1, role: 'viewer' }, { idempotencyKey: 'k' }));
      expect((e as AuthzAdminFailure).code).to.equal('conflict');
      expect(d.store.rows.size).to.equal(1);
    });

    it('a dry-run createLink returns the would-be link with an empty token', async () => {
      const d = await domain();
      const out = await d.admin.createLink(alice, { scope: p1, role: 'viewer' }, { dryRun: true });
      expect(out.link.id).to.equal('a1');
      expect(out.token).to.equal('');
    });

    it('a handler that returns no row makes assign throw AuthzConfigError', async () => {
      class RowlessGrant extends AuthzWriteHandler {
        readonly kinds = ['assignment.grant'] as const;
        async validate(): Promise<void> {}
        permission(): { permission: Permission; resource: ResourceRef } {
          return { permission: 'authz:assignments.manage', resource: p1 };
        }
        async apply(): Promise<{ id: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
          return { id: 'x', affected: 1, tags: [], events: [] };
        }
      }
      const d2 = await adminDomain('rowless', { handlers: false, register: (c) => c.register(RowlessGrant).as(AuthzWriteHandler) });
      const e = await rejection(d2.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'editor', scope: p1 }));
      expect(e).to.be.instanceOf(AuthzConfigError);
    });

    it('a link handler without a token rolls the write back before createLink fails', async () => {
      class TokenlessLink extends AuthzWriteHandler {
        static wrote = 0;
        readonly kinds = ['link.create'] as const;
        async validate(): Promise<void> {}
        permission(): { permission: Permission; resource: ResourceRef } {
          return { permission: 'authz:links.manage', resource: p1 };
        }
        async apply(): Promise<{ id: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
          TokenlessLink.wrote++;
          return { id: 'l1', affected: 1, tags: [], events: [], row: { id: 'l1', scope: p1, attributes: {} } } as never;
        }
      }
      const d = await adminDomain('tokenless', { handlers: false, register: (c) => c.register(TokenlessLink).as(AuthzWriteHandler) });
      const e = await rejection(d.admin.createLink(alice, { scope: p1, role: 'viewer' }));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(TokenlessLink.wrote).to.equal(1);
      expect(d.backend.version('tokenless')).to.equal(0);
      expect(d.bus.published).to.deep.equal([]);
    });

    it('a replayed key of another command kind is a conflict, not a wrong row', async () => {
      const d = await domain();
      await d.admin.createLink(alice, { scope: p1, role: 'viewer' }, { idempotencyKey: 'k' });
      const e = await rejection(d.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'editor', scope: p1 }, { idempotencyKey: 'k' }));
      expect((e as AuthzAdminFailure).code).to.equal('conflict');
      expect(d.store.rows.size).to.equal(1);
    });

    it('stores rows redacted under the idempotency key', async () => {
      const d = await domain();
      await d.admin.createLink(alice, { scope: p1, role: 'viewer' }, { idempotencyKey: 'k' });
      const stored = await d.backend.recall('test', 'user:alice', 'k', d.clock.now());
      expect(stored?.rows).to.deep.equal([{ id: 'a1', scope: p1, attributes: {}, createdBy: { type: 'user', id: 'x' } }]);
      expect(JSON.stringify(stored)).to.not.contain('tok-');
    });

    it('each void sugar method sends its one command', async () => {
      const d = await domain();
      const rule = { id: 'r1', kind: 'restrict', scope: p1 } as const;
      const policy = { id: 'pol1', effect: 'deny', permissions: ['x:y'] } as const;
      await d.admin.revokeLink(alice, 'l1');
      await d.admin.setTags(alice, 'a9', ['code']);
      await d.admin.putRule(alice, rule);
      await d.admin.deleteRule(alice, 'r1');
      await d.admin.putPolicy(alice, policy);
      await d.admin.deletePolicy(alice, 'pol1');
      await d.admin.forgetScope(alice, p1);
      expect(EchoHandler.seen).to.deep.equal([
        { kind: 'link.revoke', id: 'l1' },
        { kind: 'assignment.setTags', id: 'a9', tags: ['code'] },
        { kind: 'rule.put', rule },
        { kind: 'rule.delete', id: 'r1' },
        { kind: 'policy.put', policy },
        { kind: 'policy.delete', id: 'pol1' },
        { kind: 'scope.forget', scope: p1 },
      ]);
    });

    it('revoke sends assignment.revoke and void sugar throws the failure of its command', async () => {
      const d = await domain();
      await d.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'editor', scope: p1 });
      await d.admin.revoke(alice, 'a1');
      expect(d.store.rows.size).to.equal(0);
      const e = await rejection(d.admin.deleteRule(alice, 'missing'));
      expect((e as AuthzAdminFailure).code).to.equal('not_found');
      expect((e as AuthzAdminFailure).field).to.equal('id');
    });

    it('sugar is refused like execute: forbidden without the permission', async () => {
      const d = await domain();
      const e = await rejection(d.admin.forgetScope(bob, p1));
      expect((e as AuthzAdminFailure).code).to.equal('forbidden');
    });
  });

  describe('list', () => {
    it('fails closed without a guard', async () => {
      setConfig(['authz', 'admin'], { backend: 'TestBackend' });
      const d = await domain();
      const e = await rejection(d.admin.list(alice, { kind: 'assignments' }));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.contain('authz.admin.guard.service');
      expect(FakeReader.calls).to.deep.equal([]);
    });

    it('checks authz:<kind>.read at the scope, or GLOBAL, and passes a default page', async () => {
      const d = await domain();
      const out = await d.admin.list(alice, { kind: 'assignments', scope: p1 });
      expect(out).to.deep.equal({ items: ['a', 'b', 'c'], total: 3 });
      await d.admin.list(alice, { kind: 'links' });
      expect(d.model.requests.map((r) => `${r.permission}@${r.resource.type}`)).to.deep.equal(['authz:assignments.read@project', 'authz:links.read@$global']);
      expect((FakeReader.calls[0].q as { page: unknown }).page).to.deep.equal({ limit: 50, offset: 0 });
      expect(adminActor(FakeReader.calls[0].ctx)).to.equal(alice);
    });

    it('refuses an actor without the read permission, and a conditional one', async () => {
      const d = await domain();
      expect(((await rejection(d.admin.list(bob, { kind: 'assignments', scope: p1 }))) as AuthzAdminFailure).code).to.equal('forbidden');
      expect(((await rejection(d.admin.list(carol, { kind: 'assignments', scope: p1 }))) as AuthzAdminFailure).code).to.equal('forbidden');
      expect(FakeReader.calls).to.deep.equal([]);
    });

    it('SYSTEM passes the read check', async () => {
      const d = await domain();
      expect((await d.admin.list(SYSTEM, { kind: 'assignments' })).total).to.equal(3);
    });

    it('maps list.<kind> through authz.admin.permissions', async () => {
      adminConfig({ permissions: { 'list.*': { project: 'app:grants.read' } } });
      const d = await domain();
      await d.admin.list(alice, { kind: 'assignments', scope: p1 });
      await d.admin.list(alice, { kind: 'links' });
      expect(d.model.requests.map((r) => r.permission)).to.deep.equal(['app:grants.read', 'authz:links.read']);
    });

    it('answers not_found when no reader serves the kind', async () => {
      const d = await domain();
      const e = await rejection(d.admin.list(alice, { kind: 'policies' }));
      expect((e as AuthzAdminFailure).code).to.equal('not_found');
    });

    it('refuses an unknown query kind and a query that is not plain data (invalid_query)', async () => {
      const d = await domain();
      const e = await rejection(d.admin.list(alice, { kind: 'tuples' } as unknown as AuthzAdminQuery));
      expect((e as AuthzAdminFailure).code).to.equal('invalid_query');
      expect((e as AuthzAdminFailure).field).to.equal('kind');
      const f = await rejection(d.admin.list(alice, { kind: 'links', scope: { type: 'project', id: 'p1', fn: () => 1 } } as unknown as AuthzAdminQuery));
      expect((f as AuthzAdminFailure).code).to.equal('invalid_query');
      expect(d.model.requests).to.deep.equal([]);
    });

    it('writes no audit entry for a read', async () => {
      const d = await domain();
      await d.admin.list(alice, { kind: 'assignments' });
      expect(d.audit.of('admin')).to.deep.equal([]);
    });

    it('refuses a reader answer whose total is not a count', async () => {
      class BadTotal extends AuthzAdminReader {
        readonly kinds = ['policies'] as const;
        async list(): Promise<{ items: readonly unknown[]; total: number }> {
          return { items: [], total: -1 };
        }
      }
      const d = await domain((c) => c.register(BadTotal).as(AuthzAdminReader));
      expect(await rejection(d.admin.list(alice, { kind: 'policies' }))).to.be.instanceOf(AuthzConfigError);
    });

    it('refuses two readers of one kind', async () => {
      const d = await domain((c) => c.register(OtherReader).as(AuthzAdminReader));
      expect(await rejection(d.admin.list(alice, { kind: 'links' }))).to.be.instanceOf(AuthzConfigError);
    });

    it('caps the page limit at 500 and refuses a malformed page', async () => {
      const d = await domain();
      await d.admin.list(alice, { kind: 'assignments', page: { limit: 10_000, offset: 1 } });
      expect((FakeReader.calls[0].q as { page: unknown }).page).to.deep.equal({ limit: 500, offset: 1 });
      for (const page of [{ limit: 0, offset: 0 }, { limit: 1.5, offset: 0 }, { limit: 10, offset: -1 }]) {
        const e = await rejection(d.admin.list(alice, { kind: 'assignments', page }));
        expect((e as AuthzAdminFailure).code).to.equal('invalid_query');
      }
      expect(((await rejection(d.admin.list(alice, { kind: 'attributes' } as unknown as AuthzAdminQuery))) as AuthzAdminFailure).field).to.equal('scope');
    });
  });

  describe('task 1 review fixes', () => {
    it('handlers receive a frozen copy of each command (M1)', async () => {
      const d = await domain();
      const tags = ['code'];
      const cmd = { kind: 'assignment.setTags', id: 'a9', tags } as AuthzCommand;
      await d.admin.execute(alice, [cmd]);
      const seen = EchoHandler.seen[0];
      expect(seen).to.not.equal(cmd);
      expect(Object.isFrozen(seen)).to.equal(true);
      expect(Object.isFrozen((seen as unknown as { tags: string[] }).tags)).to.equal(true);
      expect(Object.isFrozen(cmd)).to.equal(false);
    });

    it('refuses a command that is not plain data (M1)', async () => {
      const d = await domain();
      const e = await rejection(d.admin.execute(alice, [{ kind: 'scope.forget', scope: p1, fn: () => 1 } as unknown as AuthzCommand]));
      expect((e as AuthzAdminFailure).code).to.equal('invalid_batch');
    });

    it('a dry run never returns a link token (M2)', async () => {
      const d = await domain();
      const out = await d.admin.execute(alice, [{ kind: 'link.create', scope: p1, role: 'viewer' }], { dryRun: true });
      expect(out).to.deep.equal([{ ok: true, kind: 'link.create', id: 'a1', affected: 1 }]);
    });

    it('accepts a backend that wraps the rollback (M3)', async () => {
      adminConfig({ backend: 'WrappingBackend' });
      const d = await domain((c) => c.register(WrappingBackend).as(AuthzAdminBackend));
      const failed = await d.admin.execute(alice, [{ kind: 'assignment.grant', subject: ALICE, role: 'guarded', scope: p1 }]);
      expect(failed[0].ok).to.equal(false);
      const dry = await d.admin.execute(alice, [{ kind: 'assignment.grant', subject: ALICE, role: 'editor', scope: p1 }], { dryRun: true });
      expect(dry[0].ok).to.equal(true);
      expect(d.store.rows.size).to.equal(0);
    });

    it('rejects when the backend never ran the batch (M3)', async () => {
      adminConfig({ backend: 'LazyBackend' });
      const d = await domain((c) => c.register(LazyBackend).as(AuthzAdminBackend));
      const e = await rejection(d.admin.execute(alice, [{ kind: 'assignment.grant', subject: ALICE, role: 'editor', scope: p1 }]));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.contain('LazyBackend');
    });

    it('an event that cannot be prepared does not fail a committed batch (M4)', async () => {
      class CyclicEvents extends AuthzWriteHandler {
        readonly kinds = ['scope.forget'] as const;
        async validate(): Promise<void> {}
        permission(): { permission: Permission; resource: ResourceRef } {
          return { permission: 'authz:assignments.manage', resource: GLOBAL };
        }
        async apply(): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
          const data: Record<string, unknown> = {};
          Object.defineProperty(data, 'boom', { enumerable: true, get: () => { throw new Error('unreadable'); } });
          return { affected: 1, tags: ['x'], events: [{ type: 'Odd', data } as unknown as AuthzEvent] };
        }
      }
      const d = await adminDomain('cyclic', { register: (c) => c.register(CyclicEvents).as(AuthzWriteHandler) });
      const out = await d.admin.execute(alice, [{ kind: 'scope.forget', scope: p1 }]);
      expect(out[0].ok).to.equal(true);
      expect(d.bus.published).to.have.length(1);
    });
  });
});
