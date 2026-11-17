import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, audit } from '@spinajs/audit';
import { insertRows, pruneAudit, storedColumns } from '../src/index.js';
import { TestDb } from '../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const SHARED = 'audit: trails "a" and "b" both use table "audit_twin" on connection "sqlite"; give each trail its own table';

describe('one table per trail and connection', function () {
  this.timeout(60000);

  describe('two table trails on one table', () => {
    let db: TestDb;

    before(async () => {
      // `default` is an alias of the sqlite connection here, so both trails name the same table on one connection.
      db = await TestDb.open({ trails: { a: { table: 'audit_twin', connection: 'sqlite', retentionDays: 1, onFailure: 'reject' }, b: { table: 'audit_twin', connection: 'default' } } });
      await db.migrate('sqlite', 'audit_twin');
    });

    after(async () => {
      await db?.close();
    });

    it('refuses writes and reads of every table trail, and deletes nothing', async () => {
      const old = { id: 'e1', at: new Date('2020-01-01T00:00:00.000Z'), kind: 'custom' as const, action: 'old', outcome: 'ok' as const, actor: 'system:test', data: {} };
      await insertRows(db.driver('sqlite'), 'audit_twin', [storedColumns(old)]);

      await expect(audit().record({ kind: 'custom', action: 'x' }, { trail: 'a', mode: 'confirmed' })).to.be.rejectedWith(AuditConfigError, SHARED);
      await expect(audit().record({ kind: 'custom', action: 'x' }, { mode: 'confirmed', onFailure: 'reject' })).to.be.rejectedWith(AuditConfigError, SHARED);
      await expect(audit().trail('b').since(0)).to.be.rejectedWith(AuditConfigError, SHARED);
      await expect(pruneAudit()).to.be.rejectedWith(AuditConfigError, SHARED);
      expect((await db.rows('sqlite', 'audit_twin')).map((r) => r.action)).to.deep.eq(['old']);
    });
  });

  describe('a trail of another store on the default table', () => {
    let db: TestDb;

    before(async () => {
      db = await TestDb.open({ trails: { logged: { store: 'LogAuditStore', retentionDays: 1 } } });
    });

    after(async () => {
      await db?.close();
    });

    it('is not refused', async () => {
      await audit().record({ kind: 'custom', action: 'kept' }, { mode: 'confirmed', onFailure: 'reject' });
      await audit().record({ kind: 'custom', action: 'logged' }, { trail: 'logged', mode: 'confirmed', onFailure: 'reject' });
      expect(await pruneAudit()).to.eq(0);
      expect((await db.rows('sqlite', 'audit_event')).map((r) => r.action)).to.deep.eq(['kept']);
    });
  });
});
