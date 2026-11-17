import * as chai from 'chai';
import 'mocha';
import { trailConfig } from '@spinajs/audit';
import type { AuditEvent } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { AuditVerifyCommand } from '../../src/cli/commands/audit-verify.js';
import { AuditSealTableMigration, TableAuditStore, insertRows, sealAudit, storedColumns } from '../../src/index.js';
import { TestDb } from '../../src/testing.js';
import { event, setTrail, tableRows } from '../support/events.js';

const expect = chai.expect;
const TABLE = 'audit_sealed';

class Captured extends AuditVerifyCommand {
  readonly lines: string[] = [];
  readonly errors: string[] = [];
  protected override out(line: string): void {
    this.lines.push(line);
  }
  protected override err(line: string): void {
    this.errors.push(line);
  }
}

describe('audit:verify', function () {
  this.timeout(60000);
  let db: TestDb;
  let orm: Orm;
  let exitCode: typeof process.exitCode;
  const driver = () => db.driver('sqlite');
  const append = async (...events: AuditEvent[]): Promise<void> => DI.resolve(TableAuditStore).append({ trail: trailConfig('sealed'), events });
  const run = async (trail: string, options: { source?: string; head?: string } = {}): Promise<Captured> => {
    const command = Object.assign(new Captured(), { Orm: orm });
    await command.execute(trail, options);
    return command;
  };

  before(async () => {
    db = await TestDb.open();
    orm = await DI.resolve(Orm);
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
    setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: db.connectionName('sqlite'), integrity: 'sealed' });
    await db.migrate('sqlite', TABLE);
    await new AuditSealTableMigration().down(driver());
    await new AuditSealTableMigration().up(driver());
  });

  afterEach(async () => {
    process.exitCode = exitCode;
    setTrail('sealed', undefined);
    await db.drop('sqlite', TABLE);
    await new AuditSealTableMigration().down(driver());
  });

  it('prints the report of an intact trail and leaves the exit code alone', async () => {
    await append(event(1), event(2));
    await sealAudit({ settleMs: 0 });
    await append(event(3, { at: new Date() }));
    const [seal] = await tableRows(driver(), 'audit_seal', 'id');

    const command = await run('sealed', { source: db.connectionName('sqlite'), head: `2:${String(seal.hash)}` });
    expect(command.lines).to.deep.eq([`trail sealed: table ${TABLE} on connection ${db.connectionName('sqlite')}`, 'seals: 1 checked, 0 pruned', 'events: 2 intact, 0 redacted, 1 not sealed yet', `head: seq 2, hash ${String(seal.hash)}`, 'result: intact']);
    expect([command.errors, process.exitCode]).to.deep.eq([[], undefined]);
  });

  it('names the tampered event and exits with code 1', async () => {
    await append(event(1), event(2));
    await sealAudit({ settleMs: 0 });
    await driver()
      .update()
      .in(TABLE)
      .update({ data: JSON.stringify({ version: 99 }) })
      .where('seq', 2);

    const command = await run('sealed');
    expect(command.lines[command.lines.length - 1]).to.eq('result: TAMPERED at seq 2 (payload does not match its data_hash), seal 1..2');
    expect(process.exitCode).to.eq(1);
  });

  it('ends with SUSPECT and exit code 2 for a payload blanked without an erasure record', async () => {
    await append(event(1), event(2));
    await sealAudit({ settleMs: 0 });
    await driver().update().in(TABLE).update({ data: '' }).where('seq', 2);

    const command = await run('sealed');
    expect(command.lines.filter((l) => l.startsWith('redacted') || l.startsWith('result'))).to.deep.eq(['redacted without an erasure record: seq 2', 'result: SUSPECT, 1 payload(s) blanked without an erasure record']);
    expect(process.exitCode).to.eq(2);
  });

  it('ends with SUSPECT and exit code 2 for a row its seal does not cover', async () => {
    await append(event(1), event(2), event(3));
    await driver().del().from(TABLE).where('seq', 2);
    await sealAudit({ settleMs: 0 });
    await insertRows(driver(), TABLE, [{ seq: 2, ...storedColumns(event(5)) }]);

    const command = await run('sealed');
    expect(command.lines.filter((l) => l.startsWith('not covered') || l.startsWith('result'))).to.deep.eq(['not covered by their seal: seq 2 (committed or inserted after its range was sealed, seal 1..3)', 'result: SUSPECT, 1 row(s) not covered by their seal']);
    expect(process.exitCode).to.eq(2);
  });

  it('verifies every connection that holds the trail table, and fails when one is tampered', async () => {
    const other = db.connectionName('pglite');
    await db.migrate('pglite', TABLE);
    await new AuditSealTableMigration().down(db.driver('pglite'));
    await new AuditSealTableMigration().up(db.driver('pglite'));
    try {
      await append(event(1));
      await DI.resolve(TableAuditStore).append({ trail: trailConfig('sealed'), events: [event(2)], connection: other });
      await sealAudit({ settleMs: 0 });
      await db.driver('pglite').del().from(TABLE).where('seq', 1);

      const command = await run('sealed');
      expect(command.lines.filter((l) => l.startsWith('trail') || l.startsWith('result'))).to.deep.eq([`trail sealed: table ${TABLE} on connection ${db.connectionName('sqlite')}`, 'result: intact', `trail sealed: table ${TABLE} on connection ${other}`, 'result: TAMPERED at seq 1 (a sealed event is gone, or a row was written into its range after it was sealed), seal 1..1']);
      expect(process.exitCode).to.eq(1);

      process.exitCode = undefined;
      expect((await run('sealed', { head: `1:${'0'.repeat(64)}` })).errors).to.deep.eq([`audit: trail "sealed" is on 2 connections (${db.connectionName('sqlite')}, ${other}); pass --source with --head`]);
      expect(process.exitCode).to.eq(3);

      // A connection that cannot be verified does not hide another one's evidence.
      process.exitCode = undefined;
      await driver().del().from(TABLE).where('seq', 1);
      await new AuditSealTableMigration().down(db.driver('pglite'));
      const both = await run('sealed');
      expect(both.lines.filter((l) => l.startsWith('result'))).to.deep.eq(['result: TAMPERED at seq 1 (a sealed event is gone, or a row was written into its range after it was sealed), seal 1..1']);
      expect(both.errors.map((e) => e.startsWith(`connection ${other}: `))).to.deep.eq([true]);
      expect(process.exitCode).to.eq(1);
    } finally {
      await db.drop('pglite', TABLE);
      await new AuditSealTableMigration().down(db.driver('pglite'));
    }
  });

  it('ends with SUSPECT and exit code 2 for old unsealed rows and for a prune retention here does not explain', async () => {
    await append(event(1));
    const stale = await run('sealed');
    expect(stale.lines.filter((l) => l.startsWith('not sealed,') || l.startsWith('result'))).to.deep.eq(['not sealed, older than the sealing window: 1 row(s)', 'result: SUSPECT, 1 row(s) older than the sealing window not sealed']);
    expect(process.exitCode).to.eq(2);

    process.exitCode = undefined;
    await sealAudit({ settleMs: 0 });
    await driver().update().in('audit_seal').update({ pruned_at: new Date() }).where('from_seq', 1);
    await driver().del().from(TABLE).where('seq', 1);
    const pruned = await run('sealed');
    expect(pruned.lines.filter((l) => l.startsWith('pruned') || l.startsWith('result'))).to.deep.eq(['pruned earlier than retention here explains: seal 1..1', 'result: SUSPECT, 1 seal(s) pruned earlier than retention here explains']);
    expect(process.exitCode).to.eq(2);
  });

  it('turns an error into one line and exit code 3', async () => {
    const command = await run('default');
    expect(command.errors).to.deep.eq(['audit: trail "default" is not sealed, so it has nothing to verify (audit.trails.default.integrity)']);
    expect([command.lines, process.exitCode]).to.deep.eq([[], 3]);

    process.exitCode = undefined;
    expect((await run('sealed', { head: '2:abc' })).errors).to.deep.eq(['audit: --head 2:abc is not <toSeq>:<hash>, the seq and the 64 hex digits the sealer logged']);
    expect(process.exitCode).to.eq(3);
  });
});
