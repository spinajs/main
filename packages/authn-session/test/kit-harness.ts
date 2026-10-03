import { FakeIdentityStore, MemoryPasswordCredentialStore, UnsupportedConfig, fakeSeedPort } from '@spinajs/authn-testing';
import type { Harness, HarnessContext, SessionStoragePort } from '@spinajs/authn-testing';
import type { SessionIssuer } from '@spinajs/authn/contracts';

/** What a store package hands the kit: the issuer over its store, raw access to the stored rows, and cleanup. */
export interface SessionBackend {
  readonly issuer: SessionIssuer;
  readonly storage: SessionStoragePort;
  dispose(): Promise<void>;
}

/** Builds a backend for one kit case from the `authn.session` config the case asks for. */
export type SessionBackendFactory = (sessionConfig: Record<string, unknown>) => Promise<SessionBackend>;

/**
 * Harness factory for `runSessionIssuerConformance`: applies the case's
 * `authn.session` overrides (`expiration` means SlidingCappedExpiration in
 * minutes, kit README) over the shipped defaults.
 */
export function sessionKitHarness(service: string, factory: SessionBackendFactory): (ctx: HarnessContext) => Promise<Harness> {
  return async (ctx) => {
    const { authn, ...rest } = ctx.config;
    const { session, ...otherAuthn } = authn ?? {};
    const unsupported = [...Object.keys(rest).filter((k) => k !== 'env'), ...Object.keys(otherAuthn).map((k) => `authn.${k}`)];
    if (unsupported.length) {
      throw new UnsupportedConfig(unsupported);
    }

    const backend = await factory({
      service,
      expiration: { service: 'SlidingCappedExpiration', ttl: session?.expiration?.ttl ?? 30, maxLifetime: session?.expiration?.maxLifetime ?? 480 },
      pendingTtlSeconds: session?.pendingTtlSeconds ?? 300,
    });

    return {
      sessions: backend.issuer,
      sessionStorage: backend.storage,
      seed: fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore()),
      dispose: () => backend.dispose(),
    };
  };
}
