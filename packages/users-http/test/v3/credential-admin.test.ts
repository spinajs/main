import 'mocha';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import { ActionHook, ActionRefused } from '@spinajs/hooks';
import type { ActionName, ActionPattern, BeforeContext } from '@spinajs/hooks';
import { CredentialAdminRule } from '@spinajs/authn/hooks';
import type { CredentialAdminVerdict } from '@spinajs/authn/hooks';
import type { CredentialAdminAction, IdentityRef, Principal } from '@spinajs/authn/contracts';
import { kitHooks } from '@spinajs/authn-testing';

import { withCredentialAdmin } from '../../src/services/credential-admin.js';

chai.use(chaiAsPromised);

const ACTOR = { type: 'user', id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', authenticated: true, source: 'session', attributes: {} } as unknown as Principal;
const TARGET = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** A rule that answers `verdict` and records its calls. */
class Answering extends CredentialAdminRule {
  readonly calls: Array<[Principal, IdentityRef, CredentialAdminAction]> = [];
  constructor(private readonly verdict: () => unknown) {
    super();
  }
  async allowed(actor: Principal, target: IdentityRef, action: CredentialAdminAction): Promise<CredentialAdminVerdict> {
    this.calls.push([actor, target, action]);
    return this.verdict() as CredentialAdminVerdict;
  }
}

/** An application hook on the action that lets everything through. */
class Watching extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['authn.admin.credentials'];
  before(): void {}
}

/** An application hook on the action, after the rule. */
class Refusing extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['authn.admin.credentials'];
  before(ctx: BeforeContext<ActionName>): void {
    ctx.refuse('not-today');
  }
}

const errorOf = async (p: Promise<unknown>): Promise<Error & { error?: unknown; code?: unknown }> => {
  try {
    await p;
  } catch (err) {
    return err as Error & { error?: unknown; code?: unknown };
  }
  throw new Error('expected a refusal');
};

describe('users-http v3: withCredentialAdmin', () => {
  let ran: number;
  const effect = async () => {
    ran++;
    return 'done';
  };

  beforeEach(() => {
    ran = 0;
  });

  it('refuses with 403 forbidden and runs nothing when no CredentialAdminRule is in the runner', async () => {
    for (const hooks of [await kitHooks([]), await kitHooks([new Watching()])]) {
      const err = await errorOf(withCredentialAdmin(ACTOR, TARGET, 'sessions', effect, hooks));
      expect(err).to.be.instanceOf(Forbidden);
      expect(err.error).to.eq('forbidden');
    }
    expect(ran).to.eq(0);
  });

  it('asks the rule about the user with the action, then runs the effect once and answers its result', async () => {
    const rule = new Answering(() => ({ ok: true }));

    expect(await withCredentialAdmin(ACTOR, TARGET, 'password-reset', effect, await kitHooks([rule]))).to.eq('done');
    expect(ran).to.eq(1);
    expect(rule.calls.map(([actor, target, action]) => [actor.id, target, action])).to.deep.eq([[ACTOR.id, { type: 'user', id: TARGET }, 'password-reset']]);
  });

  it("refuses with the rule's code and runs nothing", async () => {
    for (const code of ['forbidden', 'protected_role', 'escalation']) {
      const err = await errorOf(withCredentialAdmin(ACTOR, TARGET, 'sessions', effect, await kitHooks([new Answering(() => ({ ok: false, code }))])));
      expect(err, code).to.be.instanceOf(Forbidden);
      expect(err.error, code).to.eq(code);
    }

    const missing = await errorOf(withCredentialAdmin(ACTOR, TARGET, 'sessions', effect, await kitHooks([new Answering(() => ({ ok: false, code: 'not_found' }))])));
    expect(missing).to.be.instanceOf(ResourceNotFound);
    expect(missing.error).to.eq('not_found');
    expect(ran).to.eq(0);
  });

  it('refuses with 403 forbidden for any answer but ok: true', async () => {
    for (const verdict of [undefined, null, {}, { ok: 'true' }, { ok: 1 }, { ok: false }, { ok: false, code: 'something' }, { ok: false, code: 'toString' }, 'ok']) {
      const err = await errorOf(withCredentialAdmin(ACTOR, TARGET, 'sessions', effect, await kitHooks([new Answering(() => verdict)])));
      expect(err, JSON.stringify(verdict)).to.be.instanceOf(Forbidden);
      expect(err.error, JSON.stringify(verdict)).to.eq('forbidden');
    }
    expect(ran).to.eq(0);
  });

  it('a rule that throws fails closed: 403 action_refused hook_error', async () => {
    const throwing = new Answering(() => {
      throw new Error('store down');
    });
    const err = await errorOf(withCredentialAdmin(ACTOR, TARGET, 'sessions', effect, await kitHooks([throwing])));
    expect(err).to.be.instanceOf(Forbidden);
    expect(err).to.include({ error: 'action_refused', code: 'hook_error' });
    expect(ran).to.eq(0);
  });

  it("another hook's refusal answers 403 action_refused with its code, once the rule allowed", async () => {
    const err = await errorOf(withCredentialAdmin(ACTOR, TARGET, 'sessions', effect, await kitHooks([new Refusing(), new Answering(() => ({ ok: true }))])));
    expect(err).to.be.instanceOf(Forbidden);
    expect(err).to.include({ error: 'action_refused', code: 'not-today' });
    expect(ran).to.eq(0);
  });

  it("rethrows a refusal of an action the effect runs, for that action's route answer", async () => {
    const nested = new ActionRefused('users.delete', 'nope');
    const err = await errorOf(
      withCredentialAdmin(
        ACTOR,
        TARGET,
        'sessions',
        async () => {
          throw nested;
        },
        await kitHooks([new Answering(() => ({ ok: true }))]),
      ),
    );
    expect(err).to.eq(nested);
  });
});
