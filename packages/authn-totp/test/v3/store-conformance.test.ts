import 'mocha';
import { runMfaStoreConformance } from '@spinajs/authn-testing';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DbMfaStore, identityKey } from '@spinajs/authn-orm';
import { DbMfaSecretStore } from '../../src/db.js';
import { MemoryMfaSecretStore } from '../../src/store/index.js';
import { bootSqlite, clearMfaTables, rawQuery } from './support/sqlite.js';
import type { SqliteDb } from './support/sqlite.js';

runMfaStoreConformance('MemoryMfaSecretStore conformance', async () => {
  const store = new MemoryMfaSecretStore();
  return Object.assign(store, { dump: async (id: IdentityRef) => JSON.stringify(store.recoveryCodeHashes(id)) });
});

describe('DbMfaSecretStore conformance (sqlite)', function () {
  this.timeout(60000);
  let db: SqliteDb;

  before(async () => {
    db = await bootSqlite('store_conf');
  });

  after(async () => {
    await db?.dispose();
  });

  runMfaStoreConformance(
    'MFA store conformance (sqlite)',
    async () => {
      await clearMfaTables(db.driver);
      const store = new DbMfaSecretStore(new DbMfaStore());
      return Object.assign(store, {
        dump: async (id: IdentityRef) => {
          const identity = identityKey(id);
          const mfa = await rawQuery(db.driver, 'SELECT * FROM authn_mfa WHERE identity = ?', [identity]);
          const codes = await rawQuery(db.driver, 'SELECT * FROM authn_recovery_code WHERE identity = ?', [identity]);
          return JSON.stringify({ mfa, codes });
        },
      });
    },
    { timeoutMs: 30000 },
  );
});
