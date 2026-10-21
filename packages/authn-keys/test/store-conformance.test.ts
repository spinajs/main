import 'mocha';
import { runKeyStoreConformance } from '@spinajs/authn-testing';
import { MemoryKeyStore, OrmKeyStore } from '../src/registry/index.js';
import { bootSqlite, clearKeys } from './db.js';

runKeyStoreConformance('MemoryKeyStore conformance', async () => new MemoryKeyStore());

describe('OrmKeyStore conformance', function () {
  this.timeout(60000);

  before(async () => {
    await bootSqlite();
  });

  runKeyStoreConformance(
    'OrmKeyStore conformance (sqlite)',
    async () => {
      await clearKeys();
      return new OrmKeyStore();
    },
    { timeoutMs: 30000 },
  );
});
