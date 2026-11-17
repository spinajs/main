import { audit } from '@spinajs/audit';
import type { AuditPinnedHead, AuditTamper, AuditUncoveredRow, AuditVerifyReport } from '@spinajs/audit';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

const REASONS: Record<AuditTamper['reason'], string> = {
  payload: 'payload does not match its data_hash',
  seal: 'a sealed field or a hash was changed',
  count: 'a sealed event is gone or one was inserted',
  chain: 'a seal is gone or was replaced',
};
const MAX_LISTED = 20;
const HEAD = /^(\d+):([0-9a-f]{64})$/;

function listed<T>(items: readonly T[], show: (item: T) => string): string {
  const more = items.length > MAX_LISTED ? `, … and ${items.length - MAX_LISTED} more` : '';
  return items.slice(0, MAX_LISTED).map(show).join(', ') + more;
}

const uncovered = (u: AuditUncoveredRow): string => `seq ${u.seq} (${u.reason === 'late' ? 'committed or inserted after its range was sealed' : 'in a pruned range'}, seal ${u.fromSeq}..${u.toSeq})`;

function resultOf(r: AuditVerifyReport): string {
  if (r.tampered) return `result: TAMPERED at seq ${r.tampered.seq} (${REASONS[r.tampered.reason]}), seal ${r.tampered.fromSeq}..${r.tampered.toSeq}`;
  if (r.unexplainedRedactions.length > 0) return `result: SUSPECT, ${r.unexplainedRedactions.length} payload(s) blanked without an erasure record`;
  return 'result: intact';
}

function linesOf(r: AuditVerifyReport): string[] {
  const lines = [`trail ${r.trail}: table ${r.table} on connection ${r.connection}`, `seals: ${r.seals} checked, ${r.prunedSeals} pruned`, `events: ${r.intact} intact, ${r.redacted} redacted, ${r.unsealed} not sealed yet`];
  if (r.uncovered.length > 0) lines.push(`not covered by their seal: ${listed(r.uncovered, uncovered)}`);
  if (r.unexplainedRedactions.length > 0) lines.push(`redacted without an erasure record: ${listed(r.unexplainedRedactions, (seq) => `seq ${seq}`)}`);
  if (r.head) lines.push(`head: seq ${r.head.toSeq}, hash ${r.head.hash}`);
  lines.push(resultOf(r));
  return lines;
}

function pinnedOf(head: string | undefined): AuditPinnedHead | undefined {
  if (head === undefined) return undefined;
  const match = HEAD.exec(head);
  if (!match) throw new Error(`audit: --head ${head} is not <toSeq>:<hash>, the seq and the 64 hex digits the sealer logged`);
  return { toSeq: Number(match[1]), hash: match[2] };
}

@Command('audit:verify', 'Recomputes the seals of a sealed audit trail; exit code 1 when a sealed event or a seal does not match, or a payload was blanked without an erasure record')
@Argument('trail', true, 'trail name')
@Option('-s, --source <connection>', false, 'connection that holds the trail table; default: the connection of the trail')
@Option('--head <toSeq:hash>', false, 'a head the sealer logged, kept outside the database; the chain must pass through it')
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
    try {
      const pinned = pinnedOf(options.head);
      if (!this.Orm) {
        const orm = await this.Container.resolve(Orm);
        if (!(orm instanceof Orm)) throw new Error('audit: the ORM could not be resolved');
        this.Orm = orm;
      }
      await this.Orm.Migrator.ready();
      const report = await audit().trail(trail).verify(options.source, pinned);
      for (const line of linesOf(report)) this.out(line);
      if (report.tampered || report.unexplainedRedactions.length > 0) process.exitCode = 1;
    } catch (e) {
      this.err(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  }
}
