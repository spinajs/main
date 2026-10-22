import { AuthnAudit } from '@spinajs/authn/audit';
import type { AuthenticationStrategy, AuthnEventSink, NonceStore } from '@spinajs/authn/contracts';
import { MemoryNonceStore } from '@spinajs/authn/nonces';
import { DbNonceStore } from '@spinajs/authn-orm';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, ScriptedActionHook, UnsupportedConfig, fakeSeedPort, generateKeyPair, kitHooks, throttleParams } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HarnessContext, KitKeyPair } from '@spinajs/authn-testing';
import { signChallenge } from '../src/challenge/index.js';
import { LocalJwsSigner, StrictJwsVerifier } from '../src/jws/index.js';
import type { PrivateJwk } from '../src/jws/index.js';
import { keysOptionsFor } from './support/keys-options.js';
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
  readonly nonces: NonceStore;
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
  /** Present when the parts were built with hooks. */
  readonly hook?: ScriptedActionHook;
}

/** Everything one case needs, sharing one identity store, throttle and sink list (lane notes D13). */
/** With `hooks`, the registry runs one ScriptedActionHook on every action (A38). */
export async function keysParts(config: ConfigOverrides, kind: StoreKind, hooks = false): Promise<KeysParts> {
  checkConfig(config);
  const options = keysOptionsFor({ assertion: { audience: KIT_AUDIENCE, ...config.authn?.keys?.assertion } });
  let store: KeyStore;
  let nonces: NonceStore;
  if (kind === 'sqlite') {
    await bootSqlite();
    await clearKeys();
    store = new OrmKeyStore();
    nonces = new DbNonceStore();
  } else {
    store = new MemoryKeyStore();
    nonces = new MemoryNonceStore();
  }
  const secrets = new MemorySecretStore();
  const params = throttleParams(config);
  const throttle = new FakeBackoffThrottle(params);
  const events = new RecordingEventSink();
  const sinks: AuthnEventSink[] = [events];
  const identities = new FakeIdentityStore();
  const sessions = new MemorySessionIssuer();
  const hook = hooks ? new ScriptedActionHook() : undefined;
  const registry = new DefaultKeyRegistry({ store, secrets, throttle, audit: AuthnAudit.over(sinks), options, ...(hook ? { hooks: await kitHooks([hook]) } : {}) });
  const verifier = new StrictJwsVerifier();
  const strategies = [new JwsAssertionStrategy({ registry, verifier, nonces, options }), new HttpSignatureStrategy({ registry, nonces, options }), new KeyChallengeStrategy({ registry, secrets, options })];
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
  return { options, store, nonces, secrets, throttle, events, sinks, identities, sessions, registry, verifier, strategies, service, ...(hook ? { hook } : {}) };
}

export async function keysHarness(ctx: HarnessContext, kind: StoreKind = 'memory', hooks = false): Promise<Harness> {
  const p = await keysParts(ctx.config, kind, hooks);
  return {
    service: p.service,
    seed: fakeSeedPort(p.identities, new MemoryPasswordCredentialStore()),
    sessions: p.sessions,
    throttle: { throttle: p.throttle, params: throttleParams(ctx.config) },
    events: p.events,
    secrets: p.secrets,
    keys: p.registry,
    keyProofs: { sign: async (challenge, purpose, key) => signChallenge(challenge, purpose, KIT_AUDIENCE, key.privateKey, key.alg) },
    assertion: { audience: KIT_AUDIENCE, issuerOf: assertionIssuer },
    jws: { verifier: p.verifier, signer: new LocalJwsSigner([privateJwkOf(generateKeyPair('EdDSA'))]) },
    ...(p.hook ? { flowHooks: p.hook } : {}),
  };
}
