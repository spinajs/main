import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';
import { ActionHook } from '@spinajs/hooks';
import type { BeforeContext } from '@spinajs/hooks';
import { RecordingActionHook } from '@spinajs/hooks/testing';

import { AuthzAdminFailure } from '@spinajs/authz';
import type { AuthzCommand, AuthzCommandResult, ResourceRef } from '@spinajs/authz';
import { adminConfig, installHost, rejection, resetHost, uninstallHost } from '../admin/support.js';
import { PatchCommand, RefuseWhen, hookedAdminDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const p1: ResourceRef = { type: 'project', id: 'p1' };
const grant = (subject: string, role = 'editor'): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id: subject }, role, scope: p1 });
const failure = (r: AuthzCommandResult) => (r as Extract<AuthzCommandResult, { ok: false }>).error;
const roleIs = (role: string) => (input: { command: { role?: string } }) => input.command.role === role;

describe('authz admin hooks', function () {
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
  });

  describe('authz.admin.command', () => {
    it('a refusal on the second of three commands fails the batch there with hook:<code> and writes nothing', async () => {
      const d = await hookedAdminDomain([new RefuseWhen(['authz.admin.command'], 'frozen-role', roleIs('frozen'))]);
      const out = await d.admin.execute(alice, [grant('bob'), grant('dan', 'frozen'), grant('erin')]);
      expect(out).to.have.length(2);
      expect(out[0].ok).to.equal(true);
      expect(out[1].ok).to.equal(false);
      expect(failure(out[1]).code).to.equal('hook:frozen-role');
      expect(d.store.rows.size).to.equal(0);
      expect(d.store.trace.filter((t) => t.startsWith('apply:'))).to.deep.equal([]);
      expect(d.bus.published).to.deep.equal([]);
    });

    it('a command the hook lets pass is applied as before', async () => {
      const d = await hookedAdminDomain([new RefuseWhen(['authz.admin.command'], 'frozen-role', roleIs('frozen'))]);
      const out = await d.admin.execute(alice, [grant('bob'), grant('dan', 'viewer')]);
      expect(out.every((r) => r.ok)).to.equal(true);
      expect(d.store.rows.size).to.equal(2);
    });

    it('a hook that throws fails the command with hook_error', async () => {
      class Broken extends ActionHook {
        readonly actions = ['authz.admin.command'] as const;
        before(): void {
          throw new Error('hook bug');
        }
      }
      const d = await hookedAdminDomain([new Broken()]);
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(failure(out[0]).code).to.equal('hook_error');
      expect(d.store.rows.size).to.equal(0);
    });

    it('a hook that sets expiresAt stores the new expiry', async () => {
      const expiresAt = new Date('2027-01-01T00:00:00.000Z');
      const d = await hookedAdminDomain([new PatchCommand((c: { kind: string }) => (c.kind === 'assignment.grant' ? { ...c, expiresAt } : c))]);
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(out[0].ok).to.equal(true);
      const applied = d.store.applied[0] as Extract<AuthzCommand, { kind: 'assignment.grant' }>;
      expect(applied.expiresAt).to.deep.equal(expiresAt);
    });

    it('validates a changed command again: a hook that changes the role to an unknown one fails validate()', async () => {
      const d = await hookedAdminDomain([new PatchCommand((c) => ({ ...c, role: 'unknown' }))]);
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(failure(out[0]).code).to.equal('unknown_role');
      expect(d.store.rows.size).to.equal(0);
      expect(d.store.trace.filter((t) => t === 'validate:assignment.grant')).to.have.length(2);
    });

    it('still runs the AdminGuard: a hook that escalates the command is refused by the guard', async () => {
      const d = await hookedAdminDomain([new PatchCommand((c) => ({ ...c, role: 'guarded' }))]);
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(failure(out[0]).code).to.equal('escalation');
      expect(d.store.rows.size).to.equal(0);
      expect(d.store.trace.indexOf('guard:assignment.grant')).to.be.greaterThan(d.store.trace.lastIndexOf('validate:assignment.grant'));
    });

    it('checks the actor permission again on the changed command', async () => {
      const d = await hookedAdminDomain([new PatchCommand((c) => ({ ...c, scope: { type: 'doc', id: 'd1' } }))]);
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(out[0].ok).to.equal(true);
      const scopes = d.model.requests.filter((r) => r.permission === 'authz:assignments.manage').map((r) => `${r.resource.type}:${r.resource.id}`);
      expect(scopes).to.deep.equal(['project:p1', 'doc:d1']);
    });

    it('drops a change to a key other than command', async () => {
      class Sneaky extends ActionHook {
        readonly actions = ['authz.admin.command'] as const;
        before(ctx: BeforeContext<'authz.admin.command'>): void {
          (ctx.input as { actor: unknown }).actor = userPrincipal('mallory');
        }
      }
      const d = await hookedAdminDomain([new Sneaky()]);
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(out[0].ok).to.equal(true);
      expect(d.model.requests.every((r) => r.principal.id === 'alice')).to.equal(true);
    });

    it('after hooks see the command that was applied', async () => {
      const rec = new RecordingActionHook(['authz.admin.command']);
      const d = await hookedAdminDomain([rec]);
      await d.admin.execute(alice, [grant('bob')]);
      const after = rec.calls.find((c) => c.phase === 'after');
      expect((after?.input as { command: { kind: string } }).command.kind).to.equal('assignment.grant');
    });
  });

  describe('authz.admin.batch', () => {
    it('a refusal fails the batch with hook:<code> before any command is validated', async () => {
      const d = await hookedAdminDomain([new RefuseWhen(['authz.admin.batch'], 'maintenance')]);
      const err = await rejection(d.admin.execute(alice, [grant('bob'), grant('dan')]));
      expect(err).to.be.instanceOf(AuthzAdminFailure);
      expect((err as AuthzAdminFailure).code).to.equal('hook:maintenance');
      expect(d.store.trace).to.deep.equal([]);
      expect(d.store.rows.size).to.equal(0);
    });

    it('a hook that drops a command from the batch narrows it; the commands left are validated and applied', async () => {
      class Narrow extends ActionHook {
        readonly actions = ['authz.admin.batch'] as const;
        before(ctx: BeforeContext<'authz.admin.batch'>): void {
          ctx.input.commands = ctx.input.commands.slice(0, 1);
        }
      }
      const d = await hookedAdminDomain([new Narrow()]);
      const out = await d.admin.execute(alice, [grant('bob'), grant('dan')]);
      expect(out).to.have.length(1);
      expect(d.store.rows.size).to.equal(1);
    });

    it('does not run for an empty batch', async () => {
      const rec = new RecordingActionHook(['authz.admin.*']);
      const d = await hookedAdminDomain([rec]);
      expect(await d.admin.execute(alice, [])).to.deep.equal([]);
      expect(rec.calls).to.deep.equal([]);
    });
  });

  describe('convenience methods', () => {
    it('assign, revoke and createLink run the command hook', async () => {
      const rec = new RecordingActionHook(['authz.admin.command']);
      const d = await hookedAdminDomain([rec]);
      const row = await d.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'editor', scope: p1 });
      await d.admin.revoke(alice, row.id);
      await d.admin.createLink(alice, { scope: p1, role: 'viewer' });
      const kinds = rec.calls.filter((c) => c.phase === 'before').map((c) => (c.input as { command: { kind: string } }).command.kind);
      expect(kinds).to.deep.equal(['assignment.grant', 'assignment.revoke', 'link.create']);
    });

    it('a refusal makes assign throw an AuthzAdminFailure with hook:<code>', async () => {
      const d = await hookedAdminDomain([new RefuseWhen(['authz.admin.command'], 'no-assign')]);
      const err = await rejection(d.admin.assign(alice, { subject: { type: 'user', id: 'bob' }, role: 'editor', scope: p1 }));
      expect(err).to.be.instanceOf(AuthzAdminFailure);
      expect((err as AuthzAdminFailure).code).to.equal('hook:no-assign');
    });
  });
});
