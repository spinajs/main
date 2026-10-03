import type { AuthenticationStrategy, AuthnEventSink } from '@spinajs/authn/contracts';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, UnsupportedConfig, fakeSeedPort, generateKeyPair, throttleParams } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HarnessContext, KitKeyPair } from '@spinajs/authn-testing';
import { signChallenge } from '../src/challenge/index.js';
import { LocalJwsSigner, StrictJwsVerifier } from '../src/jws/index.js';
import type { PrivateJwk } from '../src/jws/index.js';
import { DbKeyNonceStore, MemoryKeyNonceStore } from '../src/nonce/index.js';
import type { KeyNonceStore } from '../src/nonce/index.js';
import { keysOptions } from '../src/options/index.js';
import type { KeysOptions } from '../src/options/index.js';
import { DefaultKeyRegistry, MemoryKeyStore, OrmKeyStore } from '../src/registry/index.js';
import type { KeyStore } from '../src/registry/index.js';
import { HttpSignatureStrategy, JwsAssertionStrategy, KeyChallengeStrategy, assertionIssuer } from '../src/strategies/index.js';
import { bootSqlite, clearKeys } from './db.js';

export type StoreKind = 'memory' | 'sqlite';

export const KIT_AUDIENCE = 'kit-keys-aud';

const SUPPORTED = ['authn.throttle', 'authn.keys.assertion'];

function leafKeys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    return [prefix];
  }
  return Object.entries(o).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

function checkConfig(config: ConfigOverrides): void {
  const unsupported = leafKeys(config).filter((k) => k !== '' && !SUPPORTED.some((s) => k === s || k.startsWith(`${s}.`)));
  if (unsupported.length > 0) {
    throw new UnsupportedConfig(unsupported);
  }
}

export const privateJwkOf = (kp: KitKeyPair, kid = kp.kid): PrivateJwk => {
  const j = kp.privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kty: j.kty, crv: j.crv, kid, x: j.x, ...(j.y ? { y: j.y } : {}), d: j.d };
};

export interface KeysParts {
  readonly options: KeysOptions;
  readonly store: KeyStore;
  readonly nonces: KeyNonceStore;
  readonly secrets: MemorySecretStore;
  readonly throttle: FakeBackoffThrottle;
  readonly events: RecordingEventSink;
  readonly sinks: AuthnEventSink[];
  readonly identities: FakeIdentityStore;
  readonly sessions: MemorySessionIssuer;
  readonly registry: DefaultKeyRegistry;
  readonly verifier: StrictJwsVerifier;
  readonly strategies: readonly AuthenticationStrategy[];
  readonly service: FakeAuthnService;
}

/** Everything one case needs, sharing one identity store, throttle and sink list (lane notes D13). */
export async function keysParts(config: ConfigOverrides, kind: StoreKind): Promise<KeysParts> {
  checkConfig(config);
  const options = keysOptions({ assertion: { audience: KIT_AUDIENCE, ...config.authn?.keys?.assertion } });
  let store: KeyStore;
  let nonces: KeyNonceStore;
  if (kind === 'sqlite') {
    await bootSqlite();
    await clearKeys();
    store = new OrmKeyStore();
    nonces = new DbKeyNonceStore();
  } else {
    store = new MemoryKeyStore();
    nonces = new MemoryKeyNonceStore();
  }
  const secrets = new MemorySecretStore();
  const params = throttleParams(config);
  const throttle = new FakeBackoffThrottle(params);
  const events = new RecordingEventSink();
  const sinks: AuthnEventSink[] = [events];
  const identities = new FakeIdentityStore();
  const sessions = new MemorySessionIssuer();
  const registry = new DefaultKeyRegistry(store, secrets, throttle, sinks, options);
  const verifier = new StrictJwsVerifier();
  const strategies = [new JwsAssertionStrategy(registry, verifier, nonces, options), new HttpSignatureStrategy(registry, nonces, options), new KeyChallengeStrategy(registry, secrets)];
  const service = new FakeAuthnService({
    strategies,
    throttle,
    identities,
    links: new MemoryLinkStore(),
    linking: { jit: false, byVerifiedEmail: false },
    policy: new EnrolledMfaPolicy([]),
    steps: [],
    sessions,
    sinks,
    principals: new RecordingPrincipalFactory(),
  });
  return { options, store, nonces, secrets, throttle, events, sinks, identities, sessions, registry, verifier, strategies, service };
}

export async function keysHarness(ctx: HarnessContext, kind: StoreKind = 'memory'): Promise<Harness> {
  const p = await keysParts(ctx.config, kind);
  return {
    service: p.service,
    seed: fakeSeedPort(p.identities, new MemoryPasswordCredentialStore()),
    sessions: p.sessions,
    throttle: { throttle: p.throttle, params: throttleParams(ctx.config) },
    events: p.events,
    secrets: p.secrets,
    keys: p.registry,
    keyProofs: { sign: async (challenge, purpose, key) => signChallenge(challenge, purpose, key.privateKey, key.alg) },
    assertion: { audience: KIT_AUDIENCE, issuerOf: assertionIssuer },
    jws: { verifier: p.verifier, signer: new LocalJwsSigner([privateJwkOf(generateKeyPair('EdDSA'))]) },
  };
}
