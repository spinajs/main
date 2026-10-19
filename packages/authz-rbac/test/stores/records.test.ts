import * as chai from 'chai';
import 'mocha';

import { AUTHZ_CONNECTION, AuthzConfigError } from '@spinajs/authz';
import { extractModelDescriptor } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { AdminIdempotencyRecord, AssignmentRecord, LinkRecord, MembershipRecord, RuleRecord, RuleSubjectRecord, VersionRecord, deleteFrom, fromDateTime, recordDriver, recordValues, toDateTime } from '../../src/index.js';
import { bootDb, DB_KINDS } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const RECORDS = [AssignmentRecord, MembershipRecord, RuleRecord, RuleSubjectRecord, LinkRecord, VersionRecord, AdminIdempotencyRecord];

describe('authz records', () => {
  it('map every authz table on the authz connection', () => {
    expect(RECORDS.map((r) => [r.name, extractModelDescriptor(r)!.TableName, extractModelDescriptor(r)!.Connection])).to.deep.eq([
      ['AssignmentRecord', 'authz_assignment', 'authz'],
      ['MembershipRecord', 'authz_subject_membership', 'authz'],
      ['RuleRecord', 'authz_rule', 'authz'],
      ['RuleSubjectRecord', 'authz_rule_subject', 'authz'],
      ['LinkRecord', 'authz_link', 'authz'],
      ['VersionRecord', 'authz_version', 'authz'],
      ['AdminIdempotencyRecord', 'authz_admin_idempotency', 'authz'],
    ]);
  });

  it('key each table by its primary key columns', () => {
    expect(RECORDS.map((r) => extractModelDescriptor(r)!.PrimaryKey)).to.deep.eq([['id'], ['member_key', 'set_key'], ['id'], ['rule_id', 'list', 'subject_type', 'subject_id', 'subject_role'], ['id'], ['domain'], ['domain', 'actor', 'idem_key']]);
  });

  it('convert dates between Date and DateTime, null staying null', () => {
    const d = new Date('2026-10-01T12:00:00.250Z');
    expect(toDateTime(d).toMillis()).to.eq(d.getTime());
    expect(fromDateTime(toDateTime(d))).to.deep.eq(d);
    expect(toDateTime(null)).to.eq(null);
    expect(toDateTime(undefined)).to.eq(null);
    expect(fromDateTime(null)).to.eq(null);
  });
});

for (const kind of DB_KINDS) {
  describe(`authz records (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'records');
    });

    after(async () => {
      await db?.dispose();
    });

    it('run on the driver db.Aliases.authz names', () => {
      expect(db.orm.Connections.get(AUTHZ_CONNECTION)).to.equal(db.driver);
      for (const r of RECORDS) expect(recordDriver(r), r.name).to.equal(db.driver);
    });

    it('name db.Aliases.authz when no connection answers to the alias', () => {
      db.orm.Connections.delete(AUTHZ_CONNECTION);
      try {
        expect(() => recordDriver(VersionRecord)).to.throw(AuthzConfigError, 'VersionRecord: no ORM connection answers to "authz"; set db.Aliases.authz');
      } finally {
        db.orm.Connections.set(AUTHZ_CONNECTION, db.driver);
      }
    });

    it('hydrate datetimes as DateTime, JSON columns as values and the version as a string', async () => {
      const at = new Date('2026-10-01T12:00:00.250Z');
      await db.driver.insert().into('authz_rule').values({ id: 'r1', kind: 'restrict', scope_type: 'project', scope_id: 'p1', definition: '{"allow":[{"type":"user","id":"a"}]}', expires_at: at, created_by: null, created_at: at });
      await db.driver.insert().into('authz_version').values({ domain: 'records', version: 7 });

      const [rule] = await RuleRecord.where('id', 'r1');
      expect(DateTime.isDateTime(rule.expires_at)).to.eq(true);
      expect(fromDateTime(rule.expires_at)).to.deep.eq(at);
      expect(rule.definition).to.deep.eq({ allow: [{ type: 'user', id: 'a' }] });
      const [version] = await VersionRecord.where('domain', 'records');
      expect(version.version).to.eq('7');

      await deleteFrom(RuleRecord).where('id', 'r1');
      await deleteFrom(VersionRecord).where('domain', 'records');
      expect(await RuleRecord.where('id', 'r1')).to.deep.eq([]);
    });

    it('write through the column converters', async () => {
      const at = new Date('2026-10-02T08:00:00.000Z');
      await LinkRecord.insert(recordValues<LinkRecord>({ id: 'l1', token_hash: 'v1:records', scope_type: 'project', scope_id: 'p1', attributes: { a: 1 }, expires_at: null, revoked_at: null, created_by: null, created_at: toDateTime(at) }));

      const [link] = await LinkRecord.where('id', 'l1');
      expect(link.attributes).to.deep.eq({ a: 1 });
      expect(link.expires_at).to.eq(null);
      expect(fromDateTime(link.created_at)).to.deep.eq(at);

      await LinkRecord.update(recordValues<LinkRecord>({ attributes: { a: 2 }, revoked_at: toDateTime(at) })).where('id', 'l1');
      const [updated] = await LinkRecord.where('id', 'l1');
      expect(updated.attributes).to.deep.eq({ a: 2 });
      expect(fromDateTime(updated.revoked_at)).to.deep.eq(at);

      await deleteFrom(LinkRecord).where('id', 'l1');
    });
  });
}

describe('record datetimes', () => {
  it('toDateTime gives the instant in UTC, as a record reads it back, and fromDateTime the Date', () => {
    const at = new Date('2026-10-19T12:00:00.123Z');
    const dt = toDateTime(at);

    expect(dt.zoneName).to.eq('UTC');
    expect(dt.toMillis()).to.eq(at.getTime());
    expect(fromDateTime(dt)).to.deep.eq(at);
    expect(toDateTime(null)).to.eq(null);
    expect(fromDateTime(undefined)).to.eq(null);
  });
});
