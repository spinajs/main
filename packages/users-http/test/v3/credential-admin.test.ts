import 'mocha';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import { CredentialAdminGuard } from '@spinajs/authn/contracts';
import type { CredentialAdminAction, IdentityRef, Principal } from '@spinajs/authn/contracts';

import { assertCredentialAdmin } from '../../src/services/credential-admin.js';

chai.use(chaiAsPromised);

const ACTOR = { type: 'user', id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', authenticated: true } as unknown as Principal;
const TARGET = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** A container holding only a guard that answers `verdict` and records its calls. */
function guarded(verdict: unknown): { container: IContainer; calls: Array<[Principal, IdentityRef, CredentialAdminAction]> } {
  const calls: Array<[Principal, IdentityRef, CredentialAdminAction]> = [];
  class Answering extends CredentialAdminGuard {
    public async allowed(actor: Principal, target: IdentityRef, action: CredentialAdminAction) {
      calls.push([actor, target, action]);
      return verdict as Awaited<ReturnType<CredentialAdminGuard['allowed']>>;
    }
  }
  const container = new Container();
  container.register(Answering).as(CredentialAdminGuard);
  return { container, calls };
}

const errorOf = async (p: Promise<unknown>): Promise<Error & { error?: unknown }> => {
  try {
    await p;
  } catch (err) {
    return err as Error & { error?: unknown };
  }
  throw new Error('expected a refusal');
};

describe('users-http v3: assertCredentialAdmin', () => {
  it('refuses with 403 forbidden when no CredentialAdminGuard is registered', async () => {
    const err = await errorOf(assertCredentialAdmin(ACTOR, TARGET, 'sessions', new Container()));
    expect(err).to.be.instanceOf(Forbidden);
    expect(err.error).to.eq('forbidden');
  });

  it('asks the guard about the user with the action, and passes on ok: true', async () => {
    const { container, calls } = guarded({ ok: true });

    await assertCredentialAdmin(ACTOR, TARGET, 'password-reset', container);
    expect(calls).to.deep.eq([[ACTOR, { type: 'user', id: TARGET }, 'password-reset']]);
  });

  it("refuses with the guard's code", async () => {
    for (const code of ['forbidden', 'protected_role', 'escalation']) {
      const err = await errorOf(assertCredentialAdmin(ACTOR, TARGET, 'sessions', guarded({ ok: false, code }).container));
      expect(err, code).to.be.instanceOf(Forbidden);
      expect(err.error, code).to.eq(code);
    }

    const missing = await errorOf(assertCredentialAdmin(ACTOR, TARGET, 'sessions', guarded({ ok: false, code: 'not_found' }).container));
    expect(missing).to.be.instanceOf(ResourceNotFound);
    expect(missing.error).to.eq('not_found');
  });

  it('refuses with 403 forbidden for any answer but ok: true', async () => {
    for (const verdict of [undefined, null, {}, { ok: 'true' }, { ok: 1 }, { ok: false }, { ok: false, code: 'something' }, { ok: false, code: 'toString' }, 'ok']) {
      const err = await errorOf(assertCredentialAdmin(ACTOR, TARGET, 'sessions', guarded(verdict).container));
      expect(err, JSON.stringify(verdict)).to.be.instanceOf(Forbidden);
      expect(err.error, JSON.stringify(verdict)).to.eq('forbidden');
    }
  });

  it('rejects when the guard throws, rather than allowing', async () => {
    class Throwing extends CredentialAdminGuard {
      public async allowed(): Promise<never> {
        throw new Error('store down');
      }
    }
    const container = new Container();
    container.register(Throwing).as(CredentialAdminGuard);

    await expect(assertCredentialAdmin(ACTOR, TARGET, 'sessions', container)).to.be.rejectedWith('store down');
  });
});
