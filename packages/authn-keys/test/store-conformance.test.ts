import 'mocha';
import { InProcessCredentialChangeBus } from '@spinajs/authn/bus';
import { runKeyStoreConformance } from '@spinajs/authn-testing';
import { CachedKeyStore, MemoryKeyStore, OrmKeyStore } from '../src/registry/index.js';
import { bootSqlite, clearKeys } from './db.js';

const CACHE = { ttlSeconds: 10, maxEntries: 10_000 };

runKeyStoreConformance('MemoryKeyStore conformance', async () => new MemoryKeyStore());

runKeyStoreConformance('CachedKeyStore over MemoryKeyStore conformance', async () => new CachedKeyStore(new MemoryKeyStore(), CACHE, new InProcessCredentialChangeBus()));

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

  runKeyStoreConformance(
    'CachedKeyStore over OrmKeyStore conformance (sqlite)',
    async () => {
      await clearKeys();
      return new CachedKeyStore(new OrmKeyStore(), CACHE, new InProcessCredentialChangeBus());
    },
    { timeoutMs: 30000 },
  );
});
