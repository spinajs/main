import assert from 'node:assert/strict';
import 'mocha';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthnAudit } from '@spinajs/authn';
import { AuthnEventSink, PasswordService } from '@spinajs/authn/contracts';
import type { AuthnEvent, IdentityRef } from '@spinajs/authn/contracts';
import { EmailVerification } from '@spinajs/email-verification';
import type { EmailCheckResult } from '@spinajs/email-verification';
import { DefaultHooks, Hooks } from '@spinajs/hooks';

import { User } from '../../src/index.js';
import { TestPasswordService } from '../support/password-service.js';
import { ConfigScope, registerRootRbac, removeAccounts, resetAuthnCaseServices, startUsersHttpApp, stopUsersHttpApp, usersHttpApp } from '../support/http-app.js';

const PASSWORD = 'Registration-Pass-1';
const REFUSED = 'burner@mailinator.com';

class StubVerification extends EmailVerification {
  public async resolve(): Promise<void> {
    // No store, verifier or config: the stub answers alone.
  }
  public async check(email: string): Promise<EmailCheckResult> {
    return email.endsWith('@mailinator.com') ? { allowed: false, code: 'email_domain_refused', domain: 'mailinator.com', source: 'list', reason: 'listed' } : { allowed: true, domain: email.split('@')[1] };
  }
}

const verifications: IdentityRef[] = [];

class RecordingPasswords extends TestPasswordService {
  public async requestVerification(id: IdentityRef) {
    verifications.push(id);
    return { status: 'accepted' } as const;
  }
}

const events: AuthnEvent[] = [];

class CollectingSink extends AuthnEventSink {
  public async publish(e: AuthnEvent): Promise<void> {
    events.push(e);
  }
}

const rowsWithEmail = async (email: string) => (await User.query().withDeleted().where('Email', email)).length;

describe('users.emailDomains over POST /auth/register', function () {
  this.timeout(120000);

  const scope = new ConfigScope();

  before(async () => {
    DI.register(StubVerification).as(EmailVerification);
    DI.register(RecordingPasswords).as(PasswordService);
    DI.register(CollectingSink).as(AuthnEventSink);
    await startUsersHttpApp({ register: registerRootRbac });
    scope.set(['users', 'registration'], { enabled: true, activate: true });
  });

  after(async () => {
    scope.restore();
    await stopUsersHttpApp();
    for (const [base, type] of [
      [EmailVerification, StubVerification],
      [PasswordService, RecordingPasswords],
      [AuthnEventSink, CollectingSink],
    ] as [unknown, unknown][]) {
      DI.unregister(type as Class<unknown>);
      DI.uncache(base as Class<unknown>);
    }
  });

  beforeEach(() => {
    resetAuthnCaseServices();
    events.length = 0;
    verifications.length = 0;
    for (const base of [Hooks, DefaultHooks, AuthnAudit, EmailVerification] as unknown as Class<unknown>[]) DI.uncache(base);
  });

  const register = (login: string, email: string) => usersHttpApp().send({ method: 'POST', path: '/auth/register', body: { login, email, password: PASSWORD } });

  it('a refused domain answers 400 { code }, creates no user, requests no mail and audits hook:email_domain_refused', async () => {
    const res = await register('burner', REFUSED);

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal((res.body as { code?: string }).code, 'email_domain_refused');
    assert.equal(await rowsWithEmail(REFUSED), 0);
    assert.deepEqual(verifications, []);
    assert.ok(events.some((e) => e.type === 'identity.register' && e.outcome === 'failure' && e.reason === 'hook:email_domain_refused'), JSON.stringify(events));
  });

  it('an allowed domain registers the account and requests the verification mail', async () => {
    const res = await register('regular', 'regular@example.test');

    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(await rowsWithEmail('regular@example.test'), 1);
    assert.equal(verifications.length, 1);
    await removeAccounts(verifications);
  });

  it('with apply.registration off the route lets the domain through, and users.create refuses it inside the registrar as a taken address', async () => {
    scope.set(['users', 'emailDomains', 'apply', 'registration'], false);
    try {
      const res = await register('burner2', REFUSED);

      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(await rowsWithEmail(REFUSED), 0);
      assert.deepEqual(verifications, []);
      assert.ok(events.some((e) => e.type === 'identity.register' && e.reason === 'hook:email_domain_refused'), JSON.stringify(events));
    } finally {
      scope.restore();
      scope.set(['users', 'registration'], { enabled: true, activate: true });
    }
  });
});
