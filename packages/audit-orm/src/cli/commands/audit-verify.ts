import { audit, trailConfig } from '@spinajs/audit';
import type { AuditPinnedHead, AuditTamper, AuditUncoveredRow, AuditVerifyReport } from '@spinajs/audit';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

import { isTableTrail } from '../../own-tables.js';
import { distinctConnections } from '../../ship/services.js';
import { TableAuditStore } from '../../table-store.js';
import { trailTableOn } from '../../trail-tables.js';

const REASONS: Record<AuditTamper['reason'], string> = {
  payload: 'payload does not match its data_hash',
  seal: 'a sealed field or a hash was changed',
  count: 'a sealed event is gone, or a row was written into its range after it was sealed',
  chain: 'a seal is gone or was replaced',
};
const MAX_LISTED = 20;
const HEAD = /^(\d+):([0-9a-f]{64})$/;

function listed<T>(items: readonly T[], show: (item: T) => string): string {
  const more = items.length > MAX_LISTED ? `, … and ${items.length - MAX_LISTED} more` : '';
  return items.slice(0, MAX_LISTED).map(show).join(', ') + more;
}

const uncovered = (u: AuditUncoveredRow): string => `seq ${u.seq} (${u.reason === 'late' ? 'committed or inserted after its range was sealed' : 'in a pruned range'}, seal ${u.fromSeq}..${u.toSeq})`;

const TAMPERED = 1;
const SUSPECT = 2;
const FAILED = 3;
const UNVERIFIABLE = 4;

function doubtsOf(r: AuditVerifyReport): string[] {
  const doubts: [number, string][] = [
    [r.uncovered.length, 'row(s) not covered by their seal'],
    [r.unexplainedRedactions.length, 'payload(s) blanked without an erasure record'],
    [r.earlyPrunes.length, 'seal(s) pruned earlier than retention here explains'],
    [r.staleUnsealed, 'row(s) older than the sealing window not sealed'],
  ];
  const counted = doubts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  return r.keylessHead ? [...counted, 'the newest seal is keyless although audit.seal.keys is set'] : counted;
}

function resultOf(r: AuditVerifyReport): string {
  if (r.tampered) return `result: TAMPERED at seq ${r.tampered.seq} (${REASONS[r.tampered.reason]}), seal ${r.tampered.fromSeq}..${r.tampered.toSeq}`;
  if (r.unverifiable) return `result: CANNOT VERIFY, seal ${r.unverifiable.fromSeq}..${r.unverifiable.toSeq} is signed with key ${JSON.stringify(r.unverifiable.keyId)}, which is not in audit.seal.keys here`;
  const doubts = doubtsOf(r);
  return doubts.length > 0 ? `result: SUSPECT, ${doubts.join(', ')}` : 'result: intact';
}

function exitCodeOf(r: AuditVerifyReport): number {
  if (r.tampered) return TAMPERED;
  if (r.unverifiable) return UNVERIFIABLE;
  return doubtsOf(r).length > 0 ? SUSPECT : 0;
}

function linesOf(r: AuditVerifyReport): string[] {
  const lines = [`trail ${r.trail}: table ${r.table} on connection ${r.connection}`, `seals: ${r.seals} checked, ${r.prunedSeals} pruned`, `events: ${r.intact} intact, ${r.redacted} redacted, ${r.unsealed} not sealed yet`];
  if (r.staleUnsealed > 0) lines.push(`not sealed, older than the sealing window: ${r.staleUnsealed} row(s)`);
  if (r.uncovered.length > 0) lines.push(`not covered by their seal: ${listed(r.uncovered, uncovered)}`);
  if (r.unexplainedRedactions.length > 0) lines.push(`redacted without an erasure record: ${listed(r.unexplainedRedactions, (seq) => `seq ${seq}`)}`);
  if (r.earlyPrunes.length > 0) lines.push(`pruned earlier than retention here explains: ${listed(r.earlyPrunes, (p) => `seal ${p.fromSeq}..${p.toSeq}`)}`);
  if (r.head) lines.push(`head: seq ${r.head.toSeq}, hash ${r.head.hash}`);
  lines.push(resultOf(r));
  return lines;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function pinnedOf(head: string | undefined): AuditPinnedHead | undefined {
  if (head === undefined) return undefined;
  const match = HEAD.exec(head);
  if (!match) throw new Error(`audit: --head ${head} is not <toSeq>:<hash>, the seq and the 64 hex digits the sealer logged`);
  return { toSeq: Number(match[1]), hash: match[2] };
}

interface Sources {
  readonly sources: (string | undefined)[];
  /** Connections whose table could not be looked for, with the reason. */
  readonly failed: string[];
}

/** The connections that hold a sealed table trail's table, each sealed on its own; one call without a source for any other trail. */
async function sourcesOf(name: string): Promise<Sources> {
  const trail = trailConfig(name);
  if (trail.integrity !== 'sealed' || trail.archiveConnection !== undefined || !isTableTrail(trail, TableAuditStore)) return { sources: [undefined], failed: [] };
  const held: string[] = [];
  const failed: string[] = [];
  // spinajs-orm-ignore ORM102: one metadata query per connection
  for (const driver of distinctConnections()) {
    const name = driver.Options.Name;
    try {
      if ((await trailTableOn(driver, trail.table)) === 'trail') held.push(name);
    } catch (e) {
      failed.push(`connection ${name}: ${messageOf(e)}`);
    }
  }
  return { sources: held.length === 0 && failed.length === 0 ? [undefined] : held, failed };
}

@Command('audit:verify', 'Recomputes the seals of a sealed audit trail on every connection that holds its table; exit code 0 intact, 1 tampered on any connection, else 4 when a seal is signed with a key not configured here, 3 when one could not be verified, 2 suspect (rows no seal covers, payloads blanked without an erasure record, prunes retention does not explain, old unsealed rows, a keyless newest seal although keys are set)')
@Argument('trail', true, 'trail name')
@Option('-s, --source <connection>', false, 'verify only this connection; default: every connection that holds the trail table')
@Option('--head <toSeq:hash>', false, 'a head the sealer logged, kept outside the database; the chain must pass through it, and is protected up to it only')
export class AuditVerifyCommand extends CliCommand {
  @Autoinject(Container)
  public Container: IContainer;

  /** The Cli boots only the command, so the ORM is resolved when the command runs; tests set it. */
  public Orm?: Orm;

  protected out(line: string): void {
    process.stdout.write(`${line}\n`);
  }

  protected err(line: string): void {
    process.stderr.write(`${line}\n`);
  }

  public async execute(trail: string, options: { source?: string; head?: string } = {}): Promise<void> {
    const codes: number[] = [];
    try {
      const pinned = pinnedOf(options.head);
      if (!this.Orm) {
        const orm = await this.Container.resolve(Orm);
        if (!(orm instanceof Orm)) throw new Error('audit: the ORM could not be resolved');
        this.Orm = orm;
      }
      await this.Orm.Migrator.ready();
      const { sources, failed } = options.source !== undefined ? { sources: [options.source], failed: [] } : await sourcesOf(trail);
      for (const line of failed) this.err(line);
      codes.push(...failed.map(() => FAILED));
      if (pinned && sources.length > 1) throw new Error(`audit: trail ${JSON.stringify(trail)} is on ${sources.length} connections (${sources.join(', ')}); pass --source with --head`);
      // spinajs-orm-ignore ORM102: one verification per connection
      for (const source of sources) codes.push(await this.verifyOne(trail, source, pinned, sources.length > 1));
    } catch (e) {
      this.err(messageOf(e));
      codes.push(FAILED);
    }
    const code = codes.includes(TAMPERED) ? TAMPERED : Math.max(0, ...codes);
    if (code !== 0) process.exitCode = code;
  }

  /** One connection's report; its error is reported and recorded without stopping the others. */
  private async verifyOne(trail: string, source: string | undefined, pinned: AuditPinnedHead | undefined, named: boolean): Promise<number> {
    try {
      const report = await audit().trail(trail).verify(source, pinned);
      for (const line of linesOf(report)) this.out(line);
      return exitCodeOf(report);
    } catch (e) {
      this.err(named && source !== undefined ? `connection ${source}: ${messageOf(e)}` : messageOf(e));
      return FAILED;
    }
  }
}
