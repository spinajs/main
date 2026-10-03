import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FakeIdentityStore, MemoryPasswordCredentialStore, UnsupportedConfig, fakeSeedPort } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HarnessContext, SeedPort } from '@spinajs/authn-testing';

import '../../src/generator.js';
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
