import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, UnsupportedConfig, fakeSeedPort, throttleParams } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HarnessContext, SeedPort } from '@spinajs/authn-testing';

import '../../src/generator.js';
import { JwtBearerStrategy } from '../../src/jwt/JwtBearerStrategy.js';
import { DbTokenService, NoTokenProfilesPolicy, UsersTableTokenOwnerResolver } from '../../src/service/index.js';
import { insertUserRow, v3Connection } from './db.js';

const SUPPORTED = ['authn.token.maxTtlDays', 'authn.token.agentMaxTtlMinutes'];

function leafKeys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    return [prefix];
  }
  return Object.entries(o).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

function leafValue(config: ConfigOverrides, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], config);
}

/**
 * Tokens and seed over the sqlite database of `bootV3Db()`, which the caller boots. Each case gets
 * a fresh identity store and an empty token table.
 */
export async function tokenHarness(ctx: HarnessContext): Promise<Harness> {
  const unsupported = leafKeys(ctx.config).filter((k) => k !== '' && !SUPPORTED.includes(k));
  if (unsupported.length > 0) {
    throw new UnsupportedConfig(unsupported);
  }

  // Before the config changes, so a failure here leaves no changed config behind.
  await v3Connection().del().from('rbac_access_tokens');

  const configuration = DI.get(Configuration)!;
  const saved = SUPPORTED.map((path) => [path, configuration.get(path)] as const);
  for (const path of SUPPORTED) {
    const value = leafValue(ctx.config, path);
    if (value !== undefined) {
      configuration.set(path, value);
    }
  }

  const identities = new FakeIdentityStore();
  const base = fakeSeedPort(identities, new MemoryPasswordCredentialStore());
  const seed: SeedPort = {
    async user(spec) {
      const ref = await base.user(spec);
      await insertUserRow(ref.id);
      return ref;
    },
    setStatus: (id, status) => base.setStatus(id, status),
  };

  return {
    tokens: new DbTokenService(new UsersTableTokenOwnerResolver(), new NoTokenProfilesPolicy(), identities),
    seed,
    async dispose() {
      for (const [path, value] of saved) {
        configuration.set(path, value);
      }
    },
  };
}

const JWT_ISSUERS = 'authn.jwt.issuers';
const JWT_SUPPORTED = [JWT_ISSUERS, 'authn.linking.jit', 'authn.linking.byVerifiedEmail'];

/**
 * A `service` over the kit's fakes with a fresh JwtBearerStrategy, built after `authn.jwt.issuers` is
 * applied; `dispose()` puts the issuers back.
 */
export async function jwtHarness(ctx: HarnessContext): Promise<Harness> {
  const unsupported = leafKeys(ctx.config).filter((k) => k !== '' && !JWT_SUPPORTED.includes(k) && !k.startsWith('authn.throttle.'));
  if (unsupported.length > 0) {
    throw new UnsupportedConfig(unsupported);
  }

  const configuration = DI.get(Configuration)!;
  const saved = configuration.get(JWT_ISSUERS);
  const restore = () => configuration.set(JWT_ISSUERS, saved);
  const issuers = leafValue(ctx.config, JWT_ISSUERS);
  if (issuers !== undefined) {
    configuration.set(JWT_ISSUERS, issuers);
  }

  let strategy: JwtBearerStrategy;
  try {
    strategy = new JwtBearerStrategy();
    await strategy.resolve();
  } catch (err) {
    restore();
    throw err;
  }

  const linking = { jit: ctx.config.authn?.linking?.jit ?? false, byVerifiedEmail: ctx.config.authn?.linking?.byVerifiedEmail ?? false };
  const identities = new FakeIdentityStore({ jit: linking.jit });
  const links = new MemoryLinkStore();
  const service = new FakeAuthnService({
    strategies: [strategy],
    throttle: new FakeBackoffThrottle(throttleParams(ctx.config)),
    identities,
    links,
    linking,
    policy: new EnrolledMfaPolicy([]),
    steps: [],
    sessions: new MemorySessionIssuer(),
    sinks: [new RecordingEventSink()],
    principals: new RecordingPrincipalFactory(),
  });

  return {
    service,
    links,
    seed: fakeSeedPort(identities, new MemoryPasswordCredentialStore()),
    async dispose() {
      restore();
    },
  };
}
