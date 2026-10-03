import type { AuthnEventSink } from '@spinajs/authn/contracts';
import { FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, RecordingEventSink, UnsupportedConfig, fakeSeedPort, throttleParams } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HarnessContext } from '@spinajs/authn-testing';
import { signChallenge } from '../src/challenge/index.js';
import { keysOptions } from '../src/options/index.js';
import type { KeysOptions } from '../src/options/index.js';
import { DefaultKeyRegistry, MemoryKeyStore, OrmKeyStore } from '../src/registry/index.js';
import type { KeyStore } from '../src/registry/index.js';
import { bootSqlite, clearKeys } from './db.js';

export type StoreKind = 'memory' | 'sqlite';

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

export interface KeysParts {
  readonly options: KeysOptions;
  readonly store: KeyStore;
  readonly secrets: MemorySecretStore;
  readonly throttle: FakeBackoffThrottle;
  readonly events: RecordingEventSink;
  readonly sinks: AuthnEventSink[];
  readonly identities: FakeIdentityStore;
  readonly registry: DefaultKeyRegistry;
}

export async function keysParts(ctx: HarnessContext, kind: StoreKind): Promise<KeysParts> {
  checkConfig(ctx.config);
  const assertion = ctx.config.authn?.keys?.assertion;
  const options = keysOptions({ assertion: { audience: 'kit-keys-aud', ...assertion } });
  let store: KeyStore;
  if (kind === 'sqlite') {
    await bootSqlite();
    await clearKeys();
    store = new OrmKeyStore();
  } else {
    store = new MemoryKeyStore();
  }
  const secrets = new MemorySecretStore();
  const throttle = new FakeBackoffThrottle(throttleParams(ctx.config));
  const events = new RecordingEventSink();
  const sinks: AuthnEventSink[] = [events];
  const registry = new DefaultKeyRegistry(store, secrets, throttle, sinks, options);
  return { options, store, secrets, throttle, events, sinks, identities: new FakeIdentityStore(), registry };
}

/** The N7 harness (lane notes D13); later tasks add the service, assertion and jws ports. */
export async function keysHarness(ctx: HarnessContext, kind: StoreKind = 'memory'): Promise<Harness> {
  const p = await keysParts(ctx, kind);
  return {
    seed: fakeSeedPort(p.identities, new MemoryPasswordCredentialStore()),
    throttle: { throttle: p.throttle, params: throttleParams(ctx.config) },
    events: p.events,
    secrets: p.secrets,
    keys: p.registry,
    keyProofs: { sign: async (challenge, purpose, key) => signChallenge(challenge, purpose, key.privateKey, key.alg) },
  };
}
