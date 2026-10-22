import 'mocha';
import { expect } from 'chai';
import type { ActionName, BeforeContext } from '@spinajs/hooks';
import { EmailVerification } from '@spinajs/email-verification';
import type { EmailCheckResult } from '@spinajs/email-verification';

import { EmailDomainHook } from '../../src/email-domains/hook.js';

class StubVerification extends EmailVerification {
  public calls: string[] = [];
  public async check(email: string): Promise<EmailCheckResult> {
    this.calls.push(email);
    return email.endsWith('@mailinator.com') ? { allowed: false, code: 'email_domain_refused', domain: 'mailinator.com', source: 'list', reason: 'listed' } : { allowed: true, domain: email.split('@')[1] };
  }
}

function beforeCtx(action: string, input: Record<string, unknown>) {
  let refused: string | undefined;
  const ctx = {
    action,
    input,
    bag: new Map(),
    depth: 1,
    refuse: (code: string): never => {
      refused = code;
      throw new Error(`refused:${code}`);
    },
  } as unknown as BeforeContext<ActionName>;
  return { ctx, refused: () => refused };
}

/** The decorators define accessors on the prototype, so a plain assignment cannot replace them. */
function inject(target: object, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

describe('EmailDomainHook', () => {
  const apply = { registration: true, usersCreate: true, emailChange: true };
  let stub: StubVerification;
  let hook: EmailDomainHook;

  beforeEach(() => {
    stub = new StubVerification();
    hook = new EmailDomainHook();
    // Property injection is bypassed here; the http test covers DI and config.
    inject(hook, { Verification: stub, Apply: apply, Enabled: true });
  });

  it('refuses a registration with a refused domain', async () => {
    const { ctx, refused } = beforeCtx('authn.registration', { login: 'a', email: 'a@mailinator.com' });
    let thrown: unknown;
    try {
      await hook.before(ctx);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).to.eq('refused:email_domain_refused');
    expect(refused()).to.eq('email_domain_refused');
  });

  it('lets an allowed registration through', async () => {
    const { ctx, refused } = beforeCtx('authn.registration', { login: 'a', email: 'a@example.com' });
    await hook.before(ctx);
    expect(refused()).to.eq(undefined);
  });

  it('checks users.create with data.Email', async () => {
    const { ctx, refused } = beforeCtx('users.create', { data: { Email: 'b@mailinator.com' }, roles: [], user: {} });
    try {
      await hook.before(ctx);
    } catch {
      /* refused */
    }
    expect(refused()).to.eq('email_domain_refused');
  });

  it('checks users.update only when the email changes', async () => {
    await hook.before(beforeCtx('users.update', { user: { Email: 'c@mailinator.com' }, data: { Email: 'c@mailinator.com' } }).ctx);
    await hook.before(beforeCtx('users.update', { user: { Email: 'c@example.com' }, data: { Login: 'x' } }).ctx);
    expect(stub.calls).to.deep.eq([]);
    const changed = beforeCtx('users.update', { user: { Email: 'c@example.com' }, data: { Email: 'c@mailinator.com' } });
    try {
      await hook.before(changed.ctx);
    } catch {
      /* refused */
    }
    expect(changed.refused()).to.eq('email_domain_refused');
  });

  it('skips a path switched off in apply', async () => {
    inject(hook, { Apply: { ...apply, usersCreate: false } });
    await hook.before(beforeCtx('users.create', { data: { Email: 'b@mailinator.com' } }).ctx);
    expect(stub.calls).to.deep.eq([]);
  });

  it('does nothing while emailVerification is disabled', async () => {
    inject(hook, { Enabled: false });
    await hook.before(beforeCtx('authn.registration', { login: 'a', email: 'a@mailinator.com' }).ctx);
    expect(stub.calls).to.deep.eq([]);
  });

  it('declares exactly the three actions', () => {
    expect([...hook.actions]).to.deep.eq(['authn.registration', 'users.create', 'users.update']);
  });
});
