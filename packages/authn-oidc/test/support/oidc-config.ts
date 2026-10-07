import { OIDC_SIGNING_ALGORITHMS } from '../../src/contracts.js';
import { buildOidcOptions } from '../../src/options/options.js';
import type { BuildOidcOptionsExtra, ConfiguredOidc, OidcOptions } from '../../src/options/options.js';

/** `raw` as the schema would hand it over: defaults filled. test/config-schema.test.ts pins this function to the schema. */
export function withSchemaDefaults(raw: unknown): ConfiguredOidc {
  const input = (raw ?? {}) as { providers?: Record<string, Record<string, unknown>>; redirects?: Record<string, string> };
  const providers = Object.fromEntries(
    Object.entries(input.providers ?? {}).map(([name, p]) => [
      name,
      { clockSkewSeconds: 30, algorithms: [...OIDC_SIGNING_ALGORITHMS], requiredClaims: {}, authorizationParams: {}, ...p, linking: { jit: false, byVerifiedEmail: false, ...(p.linking as object | undefined) } },
    ]),
  );
  return { providers, redirects: { success: '/', failure: '/', ...input.redirects } } as unknown as ConfiguredOidc;
}

/** The old `readOidcOptions(raw, env, extra)` entry the build tests use, over defaulted input. */
export function readOidcOptions(raw: unknown, env: string | undefined, extra: BuildOidcOptionsExtra = {}): OidcOptions {
  return buildOidcOptions(withSchemaDefaults(raw), env, extra);
}
