import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import type { AuthnContext, IdentityRef, PrincipalRef } from '@spinajs/authn/contracts';

export const CLI_ACTOR: PrincipalRef = Object.freeze({ type: 'system', id: 'cli' });

export const OWNER_TYPES = ['user', 'service', 'agent'];

export function cliContext(): AuthnContext {
  return { now: new Date(), purpose: 'request', userAgent: 'spinajs-cli' };
}

export function ownerArg(type: string, id: string): IdentityRef {
  if (!OWNER_TYPES.includes(type)) {
    throw new Error(`owner type must be one of ${OWNER_TYPES.join(', ')}, not ${JSON.stringify(type)}`);
  }
  return { type, id };
}

/** A public JWK given inline as JSON, or a file holding JSON or a PEM public key; private keys are refused. */
export function readPublicJwk(opts: { jwk?: string; file?: string }): unknown {
  if ((opts.jwk === undefined) === (opts.file === undefined)) {
    throw new Error('give the key with exactly one of --jwk or --file');
  }
  const text = opts.jwk ?? readFileSync(opts.file!, 'utf8');
  if (text.includes('-----BEGIN')) {
    if (!text.includes('-----BEGIN PUBLIC KEY-----') || text.includes('PRIVATE KEY')) {
      throw new Error('the PEM file must hold a public key (SPKI), never a private key');
    }
    return createPublicKey(text).export({ format: 'jwk' });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('the key is neither JSON nor a PEM public key');
  }
}
