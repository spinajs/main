import type { KeyAlgorithm } from '@spinajs/authn/contracts';

/** `authn.keys` as the schema validates and defaults it. */
export interface KeysConfig {
  readonly algorithms: readonly KeyAlgorithm[];
  readonly challenge: { readonly ttlSeconds: number; readonly audience: string | null };
  readonly assertion: { readonly typ: string; readonly audience: string | null; readonly maxLifetimeSeconds: number; readonly skewSeconds: number };
  readonly httpSignature: { readonly maxAgeSeconds: number; readonly skewSeconds: number; readonly requiredComponents: readonly string[] };
}

/** `authn.keys` (design §22.5) after defaults. */
export interface KeysOptions {
  readonly algorithms: readonly KeyAlgorithm[];
  readonly challenge: {
    readonly ttlSeconds: number;
    /** What clients put in a challenge's signing input; default: assertion.audience. Challenges need one of them. */
    readonly audience: string | null;
  };
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

const derived = new WeakMap<object, KeysOptions>();

const RANGES: readonly (readonly [block: 'challenge' | 'assertion' | 'httpSignature', key: string, min: number, max: number])[] = [
  ['challenge', 'ttlSeconds', 1, 3600],
  ['assertion', 'maxLifetimeSeconds', 1, 300],
  ['assertion', 'skewSeconds', 0, 300],
  ['httpSignature', 'maxAgeSeconds', 1, 300],
  ['httpSignature', 'skewSeconds', 0, 300],
];

// The schema is the gate; this floor holds for values that never went through it (explicit Options, runtime
// Configuration.set): a NaN or missing bound switches the lifetime and skew checks off.
function checkRanges(config: KeysConfig): void {
  for (const [block, key, min, max] of RANGES) {
    const value: unknown = (config[block] as unknown as Record<string, unknown> | undefined)?.[key];
    if (!(Number.isInteger(value) && (value as number) >= min && (value as number) <= max)) {
      throw new Error(`authn.keys.${block}.${key} must be an integer from ${min} to ${max}`);
    }
  }
}

/**
 * The options of a validated `authn.keys`: frozen, with the challenge audience falling back to the assertion audience.
 * Cached per config object, so a reloaded configuration gives fresh options. Takes options it returned as they are.
 */
export function keysOptionsOf(config: KeysConfig): KeysOptions {
  let options = derived.get(config);
  if (!options) {
    checkRanges(config);
    options = Object.freeze({
      algorithms: Object.freeze([...config.algorithms]),
      challenge: Object.freeze({ ttlSeconds: config.challenge.ttlSeconds, audience: config.challenge.audience ?? config.assertion.audience }),
      assertion: Object.freeze({ ...config.assertion }),
      httpSignature: Object.freeze({ ...config.httpSignature, requiredComponents: Object.freeze([...config.httpSignature.requiredComponents]) }),
    });
    derived.set(config, options);
    derived.set(options, options);
  }
  return options;
}
