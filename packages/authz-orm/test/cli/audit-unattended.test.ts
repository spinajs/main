import * as chai from 'chai';
import 'mocha';

import { AUDIT_CONNECTION, AuthzAudit_2026_10_01_00_00_00 } from '../../src/audit/index.js';
import { AuditUnattendedCommand } from '../../src/cli/commands/audit-unattended.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  return {
    out,
    err,
    code: () => process.exitCode,
    restore: () => {
      console.log = log;
      console.error = error;
      process.exitCode = exitCode;
    },
  };
}

describe('authz:audit-unattended', function () {
  this.timeout(60000);
  const migration = new AuthzAudit_2026_10_01_00_00_00();
  let db: TestDb;
  let io: ReturnType<typeof capture>;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    // The alias is the same driver: Orm.dispose would disconnect it twice.
    db?.orm.Connections.delete(AUDIT_CONNECTION);
    await db?.close();
  });

  beforeEach(() => {
    db.orm.Connections.set(AUDIT_CONNECTION, db.driver());
    io = capture();
  });

  afterEach(async () => {
    io.restore();
    await migration.down(db.driver());
  });

  const run = () => Object.assign(new AuditUnattendedCommand(), { Orm: db.orm }).execute();

  const insert = async (rows: Array<[resource: string | null, reason: string]>) => {
    let n = 0;
    for (const [resource, reason] of rows) {
      await db
        .driver()
        .insert()
        .into('authz_audit')
        .values({ id: `r${++n}`, at: new Date(), kind: 'deny', principal: 'unattended:unattended', permission: 'x:read', resource, reason });
    }
  };

  it('counts unattended queries per resource type, the most frequent first', async () => {
    await migration.up(db.driver());
    await insert([
      ['doc:1', 'unattended'],
      ['file:9', 'unattended'],
      ['doc:2', 'unattended'],
      ['we%3Aird:1', 'unattended'],
      [null, 'unattended'],
      ['project:3', 'no_access'],
    ]);
    await run();
    expect(io.out).to.deep.equal(['resource types queried without a principal:', '  doc  2', '  (none)  1', '  file  1', '  we:ird  1']);
    expect(io.err).to.deep.equal([]);
    expect(io.code()).to.equal(undefined);
  });

  it('says so when no row has the reason unattended', async () => {
    await migration.up(db.driver());
    await insert([['project:3', 'no_access']]);
    await run();
    expect(io.out).to.deep.equal(['no unattended queries in the audit log']);
    expect(io.code()).to.equal(undefined);
  });

  it('reports that DbDecisionAudit is not enabled when the table is absent', async () => {
    await run();
    expect(io.err).to.have.length(1);
    expect(io.err[0]).to.contain('authz_audit').and.to.contain('DbDecisionAudit is not enabled');
    expect(io.code()).to.equal(1);
  });

  it('reads the authz-audit connection, not the default one, and fails when the ORM does not map it', async () => {
    await migration.up(db.driver());
    await insert([['doc:1', 'unattended']]);
    db.orm.Connections.delete(AUDIT_CONNECTION);
    await run();
    expect(io.out).to.deep.equal([]);
    expect(io.err).to.have.length(1);
    expect(io.err[0]).to.contain('"authz-audit"').and.to.contain('db.Aliases');
    expect(io.code()).to.equal(1);
  });
});
