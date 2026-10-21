import { IdentityRegistrar } from '@spinajs/authn/contracts';
import type { IdentityRef, PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { FakeIdentityStore } from './identity.js';

/** Registers into a FakeIdentityStore with an unverified address; a taken email or login answers `exists` (A35). */
export class FakeIdentityRegistrar extends IdentityRegistrar {
  constructor(
    private readonly identities: FakeIdentityStore,
    private readonly passwords: PasswordCredentialStore,
    private readonly hash: (password: string) => Promise<string>,
  ) {
    super();
  }

  public async register(data: { readonly login: string; readonly email: string; readonly password: string }): Promise<{ readonly status: 'created' | 'exists'; readonly id: IdentityRef }> {
    const taken = (await this.identities.findByLogin(data.email)) ?? (await this.identities.findByLogin(data.login));
    if (taken) {
      return { status: 'exists', id: taken };
    }
    const id = this.identities.add({ login: data.login, email: data.email, status: { addressVerified: false } });
    await this.passwords.set(id, await this.hash(data.password));
    return { status: 'created', id };
  }
}
