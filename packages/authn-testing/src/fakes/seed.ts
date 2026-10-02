import type { SeedPort } from '../harness/ports.js';
import type { FakeIdentityStore } from './identity.js';
import { fakeHash } from './passwords.js';
import type { MemoryPasswordCredentialStore } from './passwords.js';

/** SeedPort over the fakes; passwords stored as fakeHash. */
export function fakeSeedPort(identities: FakeIdentityStore, passwords: MemoryPasswordCredentialStore): SeedPort {
  return {
    async user(spec) {
      const ref = identities.add({ login: spec.login, email: spec.email, status: spec.status });
      if (spec.password !== undefined) {
        await passwords.set(ref, fakeHash(spec.password));
      }
      return ref;
    },
    async setStatus(id, status) {
      identities.setStatus(id, status);
    },
  };
}
