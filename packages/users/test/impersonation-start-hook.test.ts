import 'mocha';
import { expect } from 'chai';
import { ImpersonationGuard } from '@spinajs/authn/contracts';
import type { IdentityRef, Principal } from '@spinajs/authn/contracts';
import { DI } from '@spinajs/di';
import { ActionHook, ActionRefused } from '@spinajs/hooks';
import type { BeforeContext } from '@spinajs/hooks';

import { ImpersonationGuardStartHook } from '../src/index.js';

type Answer = Awaited<ReturnType<ImpersonationGuard['allowed']>>;

const ADMIN: Principal = { type: 'user', id: 'admin', authenticated: true, source: 'session', attributes: {} };
const TARGET: IdentityRef = { type: 'user', id: 'bob' };

class AnsweringGuard extends ImpersonationGuard {
  readonly asked: [Principal, IdentityRef][] = [];

  constructor(private readonly answer: Answer) {
    super();
  }

  async allowed(actor: Principal, target: IdentityRef): Promise<Answer> {
    this.asked.push([actor, target]);
    return this.answer;
  }
}

function hookOver(guard: ImpersonationGuard): ImpersonationGuardStartHook {
  const hook = new ImpersonationGuardStartHook();
  Object.defineProperty(hook, 'Guard', { value: guard });
  return hook;
}

const contextOf = (): BeforeContext<'authn.impersonation.start'> => ({
  action: 'authn.impersonation.start',
  input: { session: { id: 's', state: 'active' }, target: TARGET, actor: ADMIN, ctx: { now: new Date(), purpose: 'login' } },
  bag: new Map(),
  depth: 1,
  refuse(code: string, message?: string): never {
    throw new ActionRefused('authn.impersonation.start', code, message);
  },
});

describe('ImpersonationGuardStartHook: the impersonation start check of users', () => {
  it('users registers it as an ActionHook on authn.impersonation.start only', () => {
    expect((DI.getRegisteredTypes(ActionHook) ?? []).map((t) => (t as { name: string }).name)).to.include('ImpersonationGuardStartHook');
    expect(new ImpersonationGuardStartHook().actions).to.deep.eq(['authn.impersonation.start']);
  });

  it('asks the registered ImpersonationGuard about the actor and the target, and lets an allowed start through', async () => {
    const guard = new AnsweringGuard({ ok: true });
    await hookOver(guard).before(contextOf());
    expect(guard.asked).to.deep.eq([[ADMIN, TARGET]]);
  });

  for (const code of ['forbidden', 'protected_role', 'escalation'] as const) {
    it(`refuses with ${code} when the guard answers it`, async () => {
      const err = await hookOver(new AnsweringGuard({ ok: false, code }))
        .before(contextOf())
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).to.be.instanceOf(ActionRefused);
      expect((err as ActionRefused).code).to.eq(code);
    });
  }

  it('refuses with forbidden an answer that is not { ok: true }', async () => {
    const err = await hookOver(new AnsweringGuard({ ok: false } as unknown as Answer))
      .before(contextOf())
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as ActionRefused).code).to.eq('forbidden');
  });
});
