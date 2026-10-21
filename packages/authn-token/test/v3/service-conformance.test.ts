import 'mocha';
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FakeIdentityStore, runTokenServiceConformance } from '@spinajs/authn-testing';
import { AuthnAudit } from '@spinajs/authn/audit';

import '../../src/generator.js';
import { NoTokenProfilesPolicy } from '../../src/service/index.js';
import type { TokenCacheConfig } from '../../src/service/index.js';
import { bootV3Db, insertUserRow, shutdownV3Db, v3Connection } from './db.js';
import { tokenServiceOver } from './services.js';

const CACHE_PATH = ['authn', 'token', 'cache'];

for (const [label, cache] of [
  ['validation cache on', { ttlSeconds: 10, maxEntries: 10_000 }],
  ['validation cache off', { ttlSeconds: 0, maxEntries: 10_000 }],
] as const satisfies readonly (readonly [string, TokenCacheConfig])[]) {
  describe(`DbTokenService conformance, ${label}`, function () {
    this.timeout(60000);
    let saved: unknown;

    before(async () => {
      await bootV3Db();
      saved = DI.get(Configuration)!.get(CACHE_PATH);
      DI.get(Configuration)!.set(CACHE_PATH, cache);
    });

    after(async () => {
      DI.get(Configuration)!.set(CACHE_PATH, saved);
      await shutdownV3Db();
    });

    runTokenServiceConformance(
      `token service conformance (sqlite, ${label})`,
      async () => {
        await v3Connection().del().from('rbac_access_tokens');
        const identities = new FakeIdentityStore();
        const service = await tokenServiceOver({ identities, profiles: new NoTokenProfilesPolicy(), auditor: AuthnAudit.over([]) });
        return {
          service,
          owners: {
            make: async () => {
              const owner = identities.add({ login: randomUUID() });
              await insertUserRow(owner.id);
              return owner;
            },
          },
        };
      },
      { timeoutMs: 30000 },
    );
  });
}
