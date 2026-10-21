import 'mocha';
import { randomUUID } from 'node:crypto';
import { FakeIdentityStore, runTokenServiceConformance } from '@spinajs/authn-testing';
import { AuthnAudit } from '@spinajs/authn/audit';

import '../../src/generator.js';
import { NoTokenProfilesPolicy } from '../../src/service/index.js';
import { bootV3Db, insertUserRow, shutdownV3Db, v3Connection } from './db.js';
import { tokenServiceOver } from './services.js';

describe('DbTokenService conformance', function () {
  this.timeout(60000);

  before(async () => {
    await bootV3Db();
  });

  after(async () => {
    await shutdownV3Db();
  });

  runTokenServiceConformance(
    'token service conformance (sqlite)',
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
