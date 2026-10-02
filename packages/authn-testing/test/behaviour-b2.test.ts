import 'mocha';
import { runAuthnBehaviour } from '../src/behaviour/index.js';
import type { HarnessContext } from '../src/behaviour/index.js';
import { FakeIdentityStore, FakeMfaStep, MemoryPasswordCredentialStore, MemorySecretStore, fakeSeedPort } from '../src/fakes/index.js';
import type { Harness } from '../src/harness/index.js';
import { UnsupportedConfig } from '../src/harness/index.js';
import { referenceHarness } from './reference/harness.js';

const seedFakes = () => fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore());

/** A10/step over FakeMfaStep, the reference semantics of the MFA step facet (design §2.13). */
function mfaStepHarness(ctx: HarnessContext, step = new FakeMfaStep()): Harness {
  if (Object.keys(ctx.config).length > 0) {
    throw new UnsupportedConfig(Object.keys(ctx.config));
  }
  return { seed: seedFakes(), mfa: { step, enrol: async (id) => step.enrol(id), code: async (id) => step.nextCode(id) } };
}

/** A11/store over MemorySecretStore (or a mutant of it). */
function secretStoreHarness(ctx: HarnessContext, make: () => MemorySecretStore = () => new MemorySecretStore()): Harness {
  if (Object.keys(ctx.config).length > 0) {
    throw new UnsupportedConfig(Object.keys(ctx.config));
  }
  const secrets = make();
  return { seed: seedFakes(), secrets, secretStorage: { rows: async () => secrets.rows() } };
}

runAuthnBehaviour(['A10'], (ctx) => mfaStepHarness(ctx), { title: 'kit fakes: FakeMfaStep', facets: ['A10/step'], claim: ['A10/step'] });

runAuthnBehaviour(['A11'], (ctx) => secretStoreHarness(ctx), { title: 'kit fakes: MemorySecretStore', facets: ['A11/store'], claim: ['A11/store'] });

runAuthnBehaviour(['A10', 'A13'], (ctx) => referenceHarness(ctx), { title: 'reference: A10 and A13 core facets', facets: ['A10/core', 'A13/core'], claim: ['A10/core', 'A13/core'] });
