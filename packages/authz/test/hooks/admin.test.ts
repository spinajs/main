import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';
import { ActionHook } from '@spinajs/hooks';
import type { BeforeContext } from '@spinajs/hooks';
import { RecordingActionHook } from '@spinajs/hooks/testing';

import { ActionRefused, DefaultHooks, Hooks } from '@spinajs/hooks';
import type { ActionName, InputOf, OutputOf, RunOptions } from '@spinajs/hooks';

import { AuthzAdminFailure } from '@spinajs/authz';
import type { AuthzCommand, AuthzCommandResult, ResourceRef } from '@spinajs/authz';
import { adminConfig, installHost, rejection, resetHost, setConfig, uninstallHost } from '../admin/support.js';
import { PatchCommand, RefuseWhen, hookedAdminDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const frank = userPrincipal('frank');
const p1: ResourceRef = { type: 'project', id: 'p1' };
const grant = (subject: string, role = 'editor'): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id: subject }, role, scope: p1 });
const failure = (r: AuthzCommandResult) => (r as Extract<AuthzCommandResult, { ok: false }>).error;
interface Loose {
  commands: AuthzCommand[];
}
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

    it('after runs once the command passed validation and the hook phase, before the guard and the commit', async () => {
      const rec = new RecordingActionHook(['authz.admin.command']);
      const d = await hookedAdminDomain([rec]);
      await d.admin.execute(alice, [grant('bob')]);
      const after = rec.calls.find((c) => c.phase === 'after');
      expect((after?.input as { command: { kind: string } }).command.kind).to.equal('assignment.grant');
    });
  });

  describe('a hook cannot widen a command', () => {
    it('refuses a command moved to a scope the actor cannot manage, and writes nothing', async () => {
      const d = await hookedAdminDomain([new PatchCommand((c) => ({ ...c, scope: { type: 'project', id: 'p2' } }))]);
      const out = await d.admin.execute(frank, [grant('bob')]);
      expect(failure(out[0]).code).to.equal('forbidden');
      expect(d.store.rows.size).to.equal(0);
    });

    it('refuses a command whose kind was changed to one the actor cannot run, and writes nothing', async () => {
      const d = await hookedAdminDomain([new PatchCommand(() => ({ kind: 'link.create', scope: p1, role: 'viewer' }))]);
      const out = await d.admin.execute(frank, [grant('bob')]);
      expect(failure(out[0]).code).to.equal('forbidden');
      expect(d.store.rows.size).to.equal(0);
    });

    it('lets frank through when the hook changes nothing', async () => {
      const d = await hookedAdminDomain([new PatchCommand((c) => c)]);
      expect((await d.admin.execute(frank, [grant('bob')]))[0].ok).to.equal(true);
    });

    for (const [name, edit] of [
      ['pushes onto the batch', (input: Loose) => input.commands.push(grant('mallory'))],
      ['replaces an element of the batch', (input: Loose) => (input.commands[0] = grant('mallory', 'guarded'))],
      ['edits a command of the batch in place', (input: Loose) => ((input.commands[0] as unknown as { role: string }).role = 'guarded')],
    ] as const) {
      it(`fails the batch with hook_error when a batch hook ${name}`, async () => {
        class Edit extends ActionHook {
          readonly actions = ['authz.admin.batch'] as const;
          before(ctx: BeforeContext<'authz.admin.batch'>): void {
            edit(ctx.input as unknown as Loose);
          }
        }
        const d = await hookedAdminDomain([new Edit()]);
        const err = await rejection(d.admin.execute(alice, [grant('bob')]));
        expect((err as AuthzAdminFailure).code).to.equal('hook_error');
        expect(d.store.rows.size).to.equal(0);
      });
    }

    it('fails the command with hook_error when a command hook edits it in place', async () => {
      class Edit extends ActionHook {
        readonly actions = ['authz.admin.command'] as const;
        before(ctx: BeforeContext<'authz.admin.command'>): void {
          (ctx.input.command as unknown as { role: string }).role = 'guarded';
        }
      }
      const d = await hookedAdminDomain([new Edit()]);
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(failure(out[0]).code).to.equal('hook_error');
      expect(d.store.rows.size).to.equal(0);
    });

    class Replace extends ActionHook {
      readonly actions = ['authz.admin.batch'] as const;

      constructor(private readonly replacement: unknown) {
        super();
      }

      before(ctx: BeforeContext<'authz.admin.batch'>): void {
        (ctx.input as unknown as { commands: unknown }).commands = this.replacement;
      }
    }

    it('validates a batch the hook replaced as it validates the caller batch', async () => {
      const d = await hookedAdminDomain([new Replace([grant('mallory', 'unknown')])]);
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(failure(out[0]).code).to.equal('unknown_role');
    });

    it('refuses a replaced batch longer than authz.admin.maxBatch', async () => {
      adminConfig({ maxBatch: 2 });
      const d = await hookedAdminDomain([new Replace([grant('a'), grant('b'), grant('c')])]);
      const err = await rejection(d.admin.execute(alice, [grant('bob')]));
      expect((err as AuthzAdminFailure).code).to.equal('invalid_batch');
      expect(d.store.rows.size).to.equal(0);
    });

    it('refuses a replaced batch that is not an array', async () => {
      const d = await hookedAdminDomain([new Replace('not a batch')]);
      const err = await rejection(d.admin.execute(alice, [grant('bob')]));
      expect((err as AuthzAdminFailure).code).to.equal('invalid_batch');
      expect(d.store.rows.size).to.equal(0);
    });

    it('tells a replay and a dry run from a fresh commit in the after output', async () => {
      const rec = new RecordingActionHook(['authz.admin.batch']);
      const d = await hookedAdminDomain([rec]);
      await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1' });
      await d.admin.execute(alice, [grant('bob')], { idempotencyKey: 'k1' });
      await d.admin.execute(alice, [grant('dan')], { dryRun: true });
      const outputs = rec.calls.filter((c) => c.phase === 'after').map((c) => c.output as { replayed: boolean; dryRun: boolean });
      expect(outputs.map((o) => [o.replayed, o.dryRun])).to.deep.equal([
        [false, false],
        [true, false],
        [false, true],
      ]);
    });
  });

  describe('an in-place change of a Date inside the command', () => {
    it('is checked again: validate() and the permission check run on the changed command', async () => {
      class Stretch extends ActionHook {
        readonly actions = ['authz.admin.command'] as const;
        before(ctx: BeforeContext<'authz.admin.command'>): void {
          const { command } = ctx.input as unknown as { command: { expiresAt: Date } };
          command.expiresAt.setFullYear(2100);
        }
      }
      const d = await hookedAdminDomain([new Stretch()]);
      const out = await d.admin.execute(alice, [{ ...grant('bob'), expiresAt: new Date('2027-01-01T00:00:00.000Z') } as AuthzCommand]);
      expect(out[0].ok).to.equal(true);
      expect(d.store.trace.filter((t) => t === 'validate:assignment.grant')).to.have.length(2);
      expect((d.store.applied[0] as { expiresAt: Date }).expiresAt.getFullYear()).to.equal(2100);
    });
  });

  describe('a command no hook changed', () => {
    it('is validated and permission-checked once', async () => {
      const d = await hookedAdminDomain([new RecordingActionHook(['authz.admin.command'])]);
      expect((await d.admin.execute(alice, [grant('bob')]))[0].ok).to.equal(true);
      expect(d.store.trace.filter((t) => t === 'validate:assignment.grant')).to.have.length(1);
      expect(d.model.requests.filter((r) => r.permission === 'authz:assignments.manage')).to.have.length(1);
    });
  });

  describe('the admin permission check', () => {
    it('goes through authz.check: with the switch on a refusal makes the admin call forbidden', async () => {
      setConfig(['authz', 'hooks', 'check'], true);
      const d = await hookedAdminDomain([new RefuseWhen(['authz.check'], 'frozen')]);
      const out = await d.admin.execute(alice, [grant('bob')]);
      expect(failure(out[0]).code).to.equal('forbidden');
      expect(d.store.rows.size).to.equal(0);
    });
  });

  describe('errors of other actions', () => {
    it('are not relabelled as hook failures', async () => {
      // The fake handler's validate() throws the refusal of users.create for role swap.
      const d = await hookedAdminDomain([new PatchCommand((c) => ({ ...c, role: 'swap' }))]);
      const err = await rejection(d.admin.execute(alice, [grant('bob')]));
      expect(err).to.be.instanceOf(ActionRefused);
      expect((err as ActionRefused).action).to.equal('users.create');
    });
  });

  describe('without a matching hook', () => {
    class SpyHooks extends DefaultHooks {
      static runs: string[] = [];

      public async run<A extends ActionName>(action: A, input: InputOf<A>, impl: (input: InputOf<A>) => Promise<OutputOf<A>>, opts: RunOptions<A>): Promise<OutputOf<A>> {
        SpyHooks.runs.push(action);
        return super.run(action, input, impl, opts);
      }
    }

    it('the admin calls Hooks.run when a hook matches (control)', async () => {
      SpyHooks.runs = [];
      const d = await hookedAdminDomain([new RecordingActionHook(['authz.admin.batch'])], { register: (c) => c.register(SpyHooks).as(Hooks) });
      await d.admin.execute(alice, [grant('bob')]);
      expect(SpyHooks.runs).to.include('authz.admin.batch');
    });

    it('the admin runs no batch hooks, and on each command only the built-in ListSupportHook', async () => {
      SpyHooks.runs = [];
      const d = await hookedAdminDomain([new RecordingActionHook(['authz.check'])], { register: (c) => c.register(SpyHooks).as(Hooks) });
      expect((await d.admin.execute(alice, [grant('bob'), grant('dan')])).every((r) => r.ok)).to.equal(true);
      expect(SpyHooks.runs).to.deep.equal(['authz.admin.command', 'authz.admin.command']);
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
