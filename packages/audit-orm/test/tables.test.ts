import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, AuditStore, audit } from '@spinajs/audit';
import type { AuditReader } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { AuditPruneFailed, insertRows, pruneAudit, storedColumns } from '../src/index.js';
import { TestDb } from '../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const BOOKS = { Driver: 'orm-driver-sqlite', Name: 'books', Filename: ':memory:' };
const SHARED = 'audit: trails "default" and "reads" both use table "audit_event"; give each trail its own table';
const old = (action: string) => storedColumns({ id: action, at: new Date('2020-01-01T00:00:00.000Z'), kind: 'custom', action, outcome: 'ok', actor: 'system:test', data: {} });

class BrokenStore extends AuditStore {
  constructor() {
    super();
    throw new Error('this store cannot be built');
  }

  append(): Promise<void> {
    return Promise.resolve();
  }

  reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(undefined);
  }
}

describe('one table per trail', function () {
  this.timeout(60000);

  describe('two table trails on one table', () => {
    let db: TestDb;

    before(async () => {
      // `reads` names another connection, but its events may sit in `audit_event` on any connection, as the default trail's do.
      db = await TestDb.open({ trails: { reads: { connection: 'books', retentionDays: 30 }, own: { table: 'audit_own', onFailure: 'reject', retentionDays: 30 }, ghost: { store: 'BrokenStore' } } }, { connections: [BOOKS] });
      DI.register(BrokenStore).as(AuditStore);
      await db.migrate('sqlite', 'audit_own');
    });

    after(async () => {
      await db?.close();
    });

    it('refuses only the colliding trails, and prunes the others', async () => {
      await insertRows(db.driver('sqlite'), 'audit_event', [old('kept')]);
      await insertRows(db.driver('sqlite'), 'audit_own', [old('pruned')]);
      await audit().record({ kind: 'custom', action: 'own' }, { trail: 'own', mode: 'confirmed' });

      await expect(audit().record({ kind: 'custom', action: 'x' }, { trail: 'reads', mode: 'confirmed' })).to.be.rejectedWith(AuditConfigError, SHARED);
      await expect(audit().record({ kind: 'custom', action: 'x' }, { mode: 'confirmed', onFailure: 'reject' })).to.be.rejectedWith(AuditConfigError, SHARED);
      await expect(audit().trail('reads').since(0)).to.be.rejectedWith(AuditConfigError, SHARED);

      const err: unknown = await pruneAudit().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).to.be.instanceOf(AuditPruneFailed);
      expect(err instanceof AuditPruneFailed ? [err.deleted, err.failed.map((f) => f.trail)] : undefined).to.deep.eq([1, ['reads']]);
      expect((await db.rows('sqlite', 'audit_event')).map((r) => r.action)).to.deep.eq(['kept']);
      expect((await db.rows('sqlite', 'audit_own')).map((r) => r.action)).to.deep.eq(['own']);
    });

    it('catches a trail added at run time on the next write', async () => {
      const config = DI.get(Configuration);
      config?.set(['audit', 'trails', 'late'], { table: 'audit_own' });
      await expect(audit().record({ kind: 'custom', action: 'x' }, { trail: 'own', mode: 'confirmed' })).to.be.rejectedWith(AuditConfigError, 'audit: trails "own" and "late" both use table "audit_own"; give each trail its own table');
      config?.set(['audit', 'trails', 'late', 'table'], 'audit_late');
      await audit().record({ kind: 'custom', action: 'again' }, { trail: 'own', mode: 'confirmed' });
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
