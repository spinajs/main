import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { KeyAlgorithm } from '@spinajs/authn/contracts';
import { KEY_ALGORITHMS } from '../jwk/keys.js';

/** `authn.keys` (design §22.5) after defaults. */
export interface KeysOptions {
  readonly algorithms: readonly KeyAlgorithm[];
  readonly challenge: { readonly ttlSeconds: number };
  readonly assertion: {
    readonly typ: string;
    /** Required once a strategy that reads assertions is listed. */
    readonly audience: string | null;
    readonly maxLifetimeSeconds: number;
    readonly skewSeconds: number;
  };
  readonly httpSignature: {
    readonly maxAgeSeconds: number;
    readonly skewSeconds: number;
    readonly requiredComponents: readonly string[];
  };
}

/** A18 and A17 cap both lifetimes at 300 s; config may only lower them. */
export const MAX_LIFETIME_SECONDS = 300;

export const DEFAULT_KEYS_OPTIONS: KeysOptions = Object.freeze({
  algorithms: KEY_ALGORITHMS,
  challenge: Object.freeze({ ttlSeconds: 120 }),
  assertion: Object.freeze({ typ: 'spinajs-client+jwt', audience: null, maxLifetimeSeconds: MAX_LIFETIME_SECONDS, skewSeconds: 30 }),
  httpSignature: Object.freeze({ maxAgeSeconds: MAX_LIFETIME_SECONDS, skewSeconds: 30, requiredComponents: Object.freeze(['@method', '@target-uri', 'content-digest']) }),
});

export type KeysOptionsInput = {
  readonly algorithms?: readonly KeyAlgorithm[];
  readonly challenge?: Partial<KeysOptions['challenge']>;
  readonly assertion?: Partial<KeysOptions['assertion']>;
  readonly httpSignature?: Partial<KeysOptions['httpSignature']>;
};

const fail = (what: string): never => {
  throw new Error(`authn.keys: ${what}`);
};

const seconds = (v: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number => (Number.isInteger(v) && v >= min && v <= max ? v : fail(`${name} must be an integer from ${min} to ${max}`));

/** Defaults merged under `input` (arrays replace); throws on a value the design does not allow, so boot fails. */
export function keysOptions(input: KeysOptionsInput = {}): KeysOptions {
  const d = DEFAULT_KEYS_OPTIONS;
  const algorithms = input.algorithms ?? d.algorithms;
  if (!Array.isArray(algorithms) || algorithms.length === 0 || algorithms.some((a) => !KEY_ALGORITHMS.includes(a))) {
    fail(`algorithms must be a non-empty list of ${KEY_ALGORITHMS.join(', ')}`);
  }
  const assertion = { ...d.assertion, ...input.assertion };
  const httpSignature = { ...d.httpSignature, ...input.httpSignature };
  if (typeof assertion.typ !== 'string' || assertion.typ.length === 0) {
    fail('assertion.typ must be a non-empty string');
  }
  if (assertion.audience !== null && (typeof assertion.audience !== 'string' || assertion.audience.length === 0)) {
    fail('assertion.audience must be a non-empty string or null');
  }
  if (!Array.isArray(httpSignature.requiredComponents) || httpSignature.requiredComponents.some((c) => typeof c !== 'string')) {
    fail('httpSignature.requiredComponents must be a list of strings');
  }
  return Object.freeze({
    algorithms: Object.freeze([...new Set(algorithms)]),
    challenge: Object.freeze({ ttlSeconds: seconds({ ...d.challenge, ...input.challenge }.ttlSeconds, 'challenge.ttlSeconds', 1, 3600) }),
    assertion: Object.freeze({
      typ: assertion.typ,
      audience: assertion.audience,
      maxLifetimeSeconds: seconds(assertion.maxLifetimeSeconds, 'assertion.maxLifetimeSeconds', 1, MAX_LIFETIME_SECONDS),
      skewSeconds: seconds(assertion.skewSeconds, 'assertion.skewSeconds', 0, MAX_LIFETIME_SECONDS),
    }),
    httpSignature: Object.freeze({
      maxAgeSeconds: seconds(httpSignature.maxAgeSeconds, 'httpSignature.maxAgeSeconds', 1, MAX_LIFETIME_SECONDS),
      skewSeconds: seconds(httpSignature.skewSeconds, 'httpSignature.skewSeconds', 0, MAX_LIFETIME_SECONDS),
      requiredComponents: Object.freeze([...httpSignature.requiredComponents]),
    }),
  });
}

/** `authn.keys` from the app configuration when one is registered, else the defaults. */
export function configuredKeysOptions(): KeysOptions {
  return keysOptions(DI.get(Configuration)?.get<KeysOptionsInput>(['authn', 'keys'], {}) ?? {});
}
