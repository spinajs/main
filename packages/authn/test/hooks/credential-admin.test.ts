import assert from 'node:assert/strict';
import 'mocha';
import { kitHooks } from '@spinajs/authn-testing';
import { Container } from '@spinajs/di';
import { ActionHook, ActionHookFailed, ActionRefused } from '@spinajs/hooks';
import type { ActionName, ActionPattern, AfterContext, BeforeContext } from '@spinajs/hooks';

import { CREDENTIAL_ADMIN_RULE_ORDER, CredentialAdminRule, credentialAdminRuleRegistered, runCredentialAdmin } from '../../src/hooks.js';
import type { CredentialAdminInput, CredentialAdminVerdict } from '../../src/hooks.js';
import type { CredentialAdminAction, IdentityRef, Principal } from '../../src/contracts/index.js';

const ACTOR = Object.freeze({
  type: 'user',
  id: 'admin-1',
  authenticated: true,
  source: 'session',
  attributes: {},
  ceiling: { roles: ['useradmin'] },
  authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date('2026-10-01T10:00:00Z') },
}) as unknown as Principal;
const TARGET: IdentityRef = { type: 'user', id: 'bob-1' };

class AnsweringRule extends CredentialAdminRule {
  readonly calls: [Principal, IdentityRef, CredentialAdminAction][] = [];
  constructor(private readonly verdict: () => unknown) {
    super();
  }
  async allowed(actor: Principal, target: IdentityRef, action: CredentialAdminAction): Promise<CredentialAdminVerdict> {
    this.calls.push([actor, target, action]);
    return this.verdict() as CredentialAdminVerdict;
  }
}

/** An app hook of the default order: records its phases on `authn.admin.credentials`. */
class Watcher extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['*'];
  readonly seen: string[] = [];
  before(ctx: BeforeContext<ActionName>): void {
    this.seen.push(`before:${ctx.action}`);
  }
  after(ctx: AfterContext<ActionName>): void {
    this.seen.push(`after:${ctx.action}:${JSON.stringify(ctx.output)}`);
  }
}

const input = (action: CredentialAdminAction = 'sessions'): CredentialAdminInput => ({ actor: ACTOR, target: TARGET, action });

async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return assert.fail('expected a refusal');
}

describe('authn.admin.credentials: CredentialAdminRule and runCredentialAdmin', () => {
  it('runs the effect once a rule allowed it, and the after hooks see its answer', async () => {
    const rule = new AnsweringRule(() => ({ ok: true }));
    const watcher = new Watcher();
    let ran = 0;
    const out = await runCredentialAdmin(await kitHooks([watcher, rule]), input('password-reset'), async () => {
      ran++;
      return { revoked: 2 };
    });
    assert.deepEqual(out, { revoked: 2 });
    assert.equal(ran, 1);
    assert.equal(rule.calls.length, 1);
    assert.deepEqual(rule.calls[0][1], TARGET);
    assert.equal(rule.calls[0][2], 'password-reset');
    assert.deepEqual(watcher.seen, ['before:authn.admin.credentials', 'after:authn.admin.credentials:{"revoked":2}']);
  });

  it("hands the rule the actor's whole principal, as a copy it cannot change", async () => {
    const rule = new AnsweringRule(() => ({ ok: true }));
    await runCredentialAdmin(await kitHooks([rule]), input(), async () => ({}));
    const [actor] = rule.calls[0];
    assert.notEqual(actor, ACTOR);
    assert.deepEqual(actor, ACTOR);
    assert.equal(Object.isFrozen(actor.authn), true);
  });

  it("refuses with the rule's code and never runs the effect", async () => {
    for (const code of ['forbidden', 'protected_role', 'escalation', 'not_found']) {
      let ran = false;
      const err = await refusalOf(
        runCredentialAdmin(await kitHooks([new AnsweringRule(() => ({ ok: false, code }))]), input(), async () => {
          ran = true;
        }),
      );
      assert.ok(err instanceof ActionRefused, code);
      assert.equal(err.action, 'authn.admin.credentials');
      assert.equal(err.code, code);
      assert.equal(ran, false, code);
    }
  });

  it('refuses forbidden for any answer but ok: true', async () => {
    for (const verdict of [undefined, null, {}, { ok: 'true' }, { ok: 1 }, { ok: false }, { ok: false, code: 'something' }, { ok: false, code: 'toString' }, 'ok']) {
      const err = await refusalOf(runCredentialAdmin(await kitHooks([new AnsweringRule(() => verdict)]), input(), async () => ({})));
      assert.ok(err instanceof ActionRefused, JSON.stringify(verdict));
      assert.equal(err.code, 'forbidden', JSON.stringify(verdict));
    }
  });

  it('refuses forbidden without a rule, also when other hooks match the action', async () => {
    for (const hooks of [await kitHooks([]), await kitHooks([new Watcher()])]) {
      let ran = false;
      const err = await refusalOf(
        runCredentialAdmin(hooks, input(), async () => {
          ran = true;
        }),
      );
      assert.ok(err instanceof ActionRefused);
      assert.equal(err.action, 'authn.admin.credentials');
      assert.equal(err.code, 'forbidden');
      assert.equal(ran, false);
    }
  });

  it('runs before the hooks of the default order, which never see what it refused', async () => {
    const watcher = new Watcher();
    const rule = new AnsweringRule(() => ({ ok: false, code: 'escalation' }));
    assert.equal(rule.order, CREDENTIAL_ADMIN_RULE_ORDER);
    await refusalOf(runCredentialAdmin(await kitHooks([watcher, rule]), input(), async () => ({})));
    assert.deepEqual(watcher.seen, []);
  });

  it('a rule that throws fails the action closed', async () => {
    let ran = false;
    const rule = new AnsweringRule(() => {
      throw new Error('store down');
    });
    const err = await refusalOf(
      runCredentialAdmin(await kitHooks([rule]), input(), async () => {
        ran = true;
      }),
    );
    assert.ok(err instanceof ActionHookFailed);
    assert.equal(err.action, 'authn.admin.credentials');
    assert.equal(ran, false);
  });

  it("a refusal of an action the effect runs is that action's, not this one's", async () => {
    const nested = new ActionRefused('users.delete', 'nope');
    const err = await refusalOf(
      runCredentialAdmin(await kitHooks([new AnsweringRule(() => ({ ok: true }))]), input(), async () => {
        throw nested;
      }),
    );
    assert.equal(err, nested);
  });

  describe('credentialAdminRuleRegistered', () => {
    class UsersRule extends CredentialAdminRule {
      async allowed(): Promise<CredentialAdminVerdict> {
        return { ok: true };
      }
    }

    it('is true while a CredentialAdminRule class is registered as an ActionHook, here or in an ancestor', () => {
      const root = new Container();
      assert.equal(credentialAdminRuleRegistered(root), false);
      root.register(Watcher).as(ActionHook);
      assert.equal(credentialAdminRuleRegistered(root), false);
      root.register(UsersRule).as(ActionHook);
      assert.equal(credentialAdminRuleRegistered(root), true);
      assert.equal(credentialAdminRuleRegistered(root.child()), true);
    });

    it('does not count a rule registered by a factory, whose class it cannot see', () => {
      const root = new Container();
      root.register(() => new UsersRule()).as(ActionHook);
      assert.equal(credentialAdminRuleRegistered(root), false);
    });
  });

  it('wrong shapes do not compile', () => {
    // @ts-expect-error abstract
    const a = () => void new CredentialAdminRule();
    const rule: CredentialAdminRule = new AnsweringRule(() => ({ ok: true }));
    // @ts-expect-error no such action
    const b = () => rule.allowed(ACTOR, TARGET, 'password-change');
    class NoNotFound extends CredentialAdminRule {
      // @ts-expect-error the refusal codes are the four of the rule
      async allowed(): Promise<{ ok: false; code: 'gone' }> {
        return { ok: false, code: 'gone' };
      }
    }
    assert.equal([a, b, NoNotFound].length, 3);
  });
});
