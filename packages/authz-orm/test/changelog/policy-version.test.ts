import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, changeLog } from '@spinajs/authz';
import type { ChangeEntry } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import { createHash } from 'node:crypto';

import { AUTHZ_CHANGELOG_CONFIGURATION_SCHEMA, CHANGELOG_RETENTION_DAYS_DEFAULT, changeLogRetentionDays, pruneChangeLog, readPolicyVersion, recordPolicyVersion } from '../../src/index.js';
import { CHANGELOG_RETENTION_SCHEDULE, ChangeLogRetentionTask } from '../../src/scheduler.js';
import { createChangeLogTables, dropChangeLogTables } from '../support/changelog.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

const IR = '{"version":1,"types":{}}';
const HASH = createHash('sha256').update(IR).digest('hex');
const DAY = 24 * 60 * 60 * 1000;

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('policy versions and changelog retention (sqlite)', function () {
  this.timeout(60000);
  let db: TestDb;
  let driver: OrmDriver;

  const append = (entries: ChangeEntry[]) => driver.transaction(() => changeLog().append(entries));

  before(async () => {
    db = await TestDb.open();
    driver = db.driver('sqlite');
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await createChangeLogTables(db, 'sqlite');
  });

  afterEach(async () => {
    await dropChangeLogTables(db, 'sqlite');
  });

  it('records a policy version once, keeping the first instant and the IR text verbatim', async () => {
    const first = new Date('2026-10-01T00:00:00.000Z');
    expect(await readPolicyVersion(HASH)).to.equal(undefined);
    expect(await recordPolicyVersion(HASH, IR, first)).to.equal(true);
    expect(await recordPolicyVersion(HASH, '{"other":true}', new Date('2026-10-02T00:00:00.000Z'))).to.equal(false);

    const stored = await readPolicyVersion(HASH);
    expect(stored).to.deep.equal({ policyHash: HASH, ir: IR, firstSeenAt: first });
  });

  it('refuses a hash that is not sha256 hex and an empty IR', async () => {
    expect(await rejection(recordPolicyVersion('abc', IR))).to.be.instanceOf(AuthzConfigError);
    expect(await rejection(recordPolicyVersion(HASH.toUpperCase(), IR))).to.be.instanceOf(AuthzConfigError);
    expect(await rejection(recordPolicyVersion(HASH, ''))).to.be.instanceOf(AuthzConfigError);
    expect(await rejection(readPolicyVersion('abc'))).to.be.instanceOf(AuthzConfigError);
  });

  it('prunes the changes older than the retention, and only those', async () => {
    const now = new Date('2026-11-04T00:00:00.000Z');
    await append([
      { kind: 'tuple', op: 'add', key: 'old', at: new Date(now.getTime() - 401 * DAY) },
      { kind: 'tuple', op: 'add', key: 'edge', at: new Date(now.getTime() - 399 * DAY) },
      { kind: 'tuple', op: 'add', key: 'new', at: now },
    ]);

    expect(await pruneChangeLog(400, now)).to.equal(1);
    expect((await changeLog().since(0)).map((c) => c.key)).to.deep.equal(['edge', 'new']);
    expect(await rejection(pruneChangeLog(0, now))).to.be.instanceOf(AuthzConfigError);
  });

  it('reads authz.changelog.retentionDays, 400 by default', () => {
    expect(AUTHZ_CHANGELOG_CONFIGURATION_SCHEMA.$configurationModule).to.equal('authz.changelog');
    expect(CHANGELOG_RETENTION_DAYS_DEFAULT).to.equal(400);
    const cfg = DI.get(Configuration) as Configuration;
    const before = cfg.get<unknown>(['authz', 'changelog']);
    try {
      cfg.set(['authz', 'changelog'], {});
      expect(changeLogRetentionDays()).to.equal(400);
      cfg.set(['authz', 'changelog'], { retentionDays: 30 });
      expect(changeLogRetentionDays()).to.equal(30);
    } finally {
      cfg.set(['authz', 'changelog'], before);
    }
  });

  it('the scheduled task prunes with the configured retention and reports the count', async () => {
    await append([{ kind: 'rule', op: 'put', key: 'ancient', at: new Date(Date.now() - 1000 * DAY) }]);
    const results: unknown[] = [];
    const out = await new ChangeLogRetentionTask().execute({ result: (r: unknown) => results.push(r) } as never);

    expect(CHANGELOG_RETENTION_SCHEDULE).to.equal('authz.changelog.retention');
    expect(out).to.deep.equal({ deleted: 1, retentionDays: changeLogRetentionDays() });
    expect(results).to.deep.equal([out]);
  });
});
