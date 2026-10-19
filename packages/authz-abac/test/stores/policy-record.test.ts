import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONNECTION, AuthzConfigError } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import { ConnectionMismatch, NotAnOrmDriver, OrmConnectionMissing, TransactionRequired } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { AUTHZ_POLICY_TABLE, PolicyRecord, requirePolicyTransaction } from '../../src/index.js';
import type { PolicyValues } from '../../src/index.js';
import { DB_KINDS, bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const CREATED = DateTime.fromISO('2026-10-01T12:00:00.250Z');
const EXPIRES = DateTime.fromISO('2026-12-01T00:00:00.000Z');

const FULL: PolicyValues = { id: 'full', effect: 'deny', permissions: ['file:read', 'file:write'], resource_types: ['file'], principal_types: ['user'], actor_types: ['agent'], scope_type: 'org', scope_id: 'o1', condition: { attr: 'resource.status', eq: 'locked' }, fields: { hide: ['email'] }, reason: 'locked', priority: 100, expires_at: EXPIRES, created_by: 'user:alice', created_at: CREATED };
const BARE: PolicyValues = { id: 'bare', effect: 'permit', permissions: ['file:read'], resource_types: null, principal_types: null, actor_types: null, scope_type: '$global', scope_id: '', condition: null, fields: null, reason: null, priority: null, expires_at: null, created_by: null, created_at: CREATED };

function refusal(fn: () => unknown): AuthzConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzConfigError);
    return e as AuthzConfigError;
  }
  throw new Error('did not throw');
}

for (const kind of DB_KINDS) {
  describe(`authz-abac: PolicyRecord (${kind})`, function () {
    this.timeout(60_000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'policy_record');
    });

    after(async () => {
      await db?.dispose();
    });

    beforeEach(async () => {
      await db.driver.del().from(AUTHZ_POLICY_TABLE);
    });

    const inTx = <T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> => db.driver.transaction(() => fn({ driver: db.driver })) as Promise<T>;

    it('hydrates JSON columns as values, datetimes as DateTime and priority as a number', async () => {
      await PolicyRecord.insert(FULL as Partial<PolicyRecord>);

      const [row] = await PolicyRecord.where('id', 'full');
      expect(row.permissions).to.deep.equal(['file:read', 'file:write']);
      expect(row.resource_types).to.deep.equal(['file']);
      expect(row.principal_types).to.deep.equal(['user']);
      expect(row.actor_types).to.deep.equal(['agent']);
      expect(row.condition).to.deep.equal({ attr: 'resource.status', eq: 'locked' });
      expect(row.fields).to.deep.equal({ hide: ['email'] });
      expect(row.priority).to.equal(100);
      expect(DateTime.isDateTime(row.expires_at)).to.equal(true);
      expect(row.expires_at.toMillis()).to.equal(EXPIRES.toMillis());
      expect(row.created_at.toMillis()).to.equal(CREATED.toMillis());
    });

    it('writes null as SQL NULL and reads it back as null', async () => {
      await PolicyRecord.insert(BARE as Partial<PolicyRecord>);

      const [raw] = await rawQuery(db.driver, `SELECT resource_types, principal_types, actor_types, condition, fields, reason, priority, expires_at, created_by FROM ${AUTHZ_POLICY_TABLE} WHERE id = 'bare'`);
      expect(raw).to.deep.equal({ resource_types: null, principal_types: null, actor_types: null, condition: null, fields: null, reason: null, priority: null, expires_at: null, created_by: null });
      const [row] = await PolicyRecord.where('id', 'bare');
      expect([row.resource_types, row.principal_types, row.actor_types, row.condition, row.fields, row.reason, row.priority, row.expires_at, row.created_by]).to.deep.equal([null, null, null, null, null, null, null, null, null]);
    });

    it('requirePolicyTransaction gives the driver of a transaction on the authz connection and refuses anything else, with the ORM error as cause', async () => {
      await inTx(async (tx) => {
        expect(requirePolicyTransaction(tx, 'test')).to.equal(db.driver);
      });

      const notADriver = refusal(() => requirePolicyTransaction({ driver: {} }, 'test'));
      expect(notADriver.message).to.equal('test: AuthzTx.driver must be the OrmDriver of an AuthzAdmin transaction');
      expect(notADriver.cause).to.be.instanceOf(NotAnOrmDriver);

      const noTransaction = refusal(() => requirePolicyTransaction({ driver: db.driver }, 'test'));
      expect(noTransaction.message).to.equal('test: stores write only inside an AuthzAdmin transaction, and none is in scope');
      expect(noTransaction.cause).to.be.instanceOf(TransactionRequired);

      await db.second.transaction(async (driver: OrmDriver) => {
        const elsewhere = refusal(() => requirePolicyTransaction({ driver }, 'test'));
        expect(elsewhere.message).to.equal('test: the AuthzTx runs on connection "abac-policy_record-second", but authz_policy is on connection "abac-policy_record" (db.Aliases.authz)');
        expect(elsewhere.cause).to.be.instanceOf(ConnectionMismatch);
      });
    });

    it('requirePolicyTransaction names db.Aliases.authz when no connection answers to the alias', async () => {
      await inTx(async (tx) => {
        db.orm.Connections.delete(AUTHZ_CONNECTION);
        try {
          const missing = refusal(() => requirePolicyTransaction(tx, 'test'));
          expect(missing.message).to.equal('test: no ORM connection answers to "authz"; set db.Aliases.authz');
          expect(missing.cause).to.be.instanceOf(OrmConnectionMissing);
        } finally {
          db.orm.Connections.set(AUTHZ_CONNECTION, db.driver);
        }
      });
    });
  });
}
