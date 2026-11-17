import * as chai from 'chai';
import 'mocha';
import { trailConfig } from '@spinajs/audit';
import type { AuditEvent } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { AuditVerifyCommand } from '../../src/cli/commands/audit-verify.js';
import { AuditSealTableMigration, TableAuditStore, sealAudit } from '../../src/index.js';
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
    await append(event(3));
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

  it('lists a payload blanked without an erasure record and exits with code 1', async () => {
    await append(event(1), event(2));
    await sealAudit({ settleMs: 0 });
    await driver().update().in(TABLE).update({ data: '' }).where('seq', 2);

    const command = await run('sealed');
    expect(command.lines.filter((l) => l.startsWith('redacted') || l.startsWith('result'))).to.deep.eq(['redacted without an erasure record: seq 2', 'result: SUSPECT, 1 payload(s) blanked without an erasure record']);
    expect(process.exitCode).to.eq(1);
  });

  it('turns an error into one line and exit code 1', async () => {
    const command = await run('default');
    expect(command.errors).to.deep.eq(['audit: trail "default" is not sealed, so it has nothing to verify (audit.trails.default.integrity)']);
    expect([command.lines, process.exitCode]).to.deep.eq([[], 1]);

    process.exitCode = undefined;
    expect((await run('sealed', { head: '2:abc' })).errors).to.deep.eq(['audit: --head 2:abc is not <toSeq>:<hash>, the seq and the 64 hex digits the sealer logged']);
    expect(process.exitCode).to.eq(1);
  });
});
