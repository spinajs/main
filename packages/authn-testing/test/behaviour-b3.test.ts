import 'mocha';
import { runAuthnBehaviour } from '../src/behaviour/index.js';
import { generateKeyPair } from '../src/helpers/index.js';
import { ReferenceJwsSigner, ReferenceJwsVerifier } from './reference/jws-verifier.js';

// A17/jws on the reference verifier; both signature algorithms for the signer case.
for (const alg of ['EdDSA', 'ES256'] as const) {
  runAuthnBehaviour(['A17'], () => ({ jws: { verifier: new ReferenceJwsVerifier(), signer: new ReferenceJwsSigner([generateKeyPair(alg)]) } }), {
    title: `reference verifier: A17 jws facet (${alg} signer)`,
    facets: ['A17/jws'],
    claim: ['A17/jws'],
  });
}
