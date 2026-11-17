import { setTimeout as sleep } from 'node:timers/promises';

import { DecisionReplay, ReplayBusy, ReplayInTransaction, resourceKey } from '@spinajs/authz';
import type { ReplayOptions, ReplayReport, ReplayTreeNode, ReplayVerdict } from '@spinajs/authz';
import { Argument, Command, Option, SystemTask } from '@spinajs/cli';

import '../../replay/index.js';
import { AuthzOrmCliCommand } from '../base.js';

interface ReplayCliOptions {
  readonly format?: string;
  readonly maxChanges?: string;
  readonly failOn?: string;
}

const FORMATS = ['text', 'json'] as const;
const FAIL_ON = ['divergent', 'unreplayable', 'never'] as const;
// --fail-on fails at its verdict and every one after it.
const SEVERITY: Record<ReplayVerdict | 'never', number> = { faithful: 0, divergent: 1, unreplayable: 2, never: 3 };

function choice<T extends string>(value: string | undefined, fallback: T, allowed: readonly T[], flag: string): T {
  const v = value === undefined ? fallback : allowed.find((a) => a === value);
  if (v === undefined) throw new Error(`authz:replay: ${flag} must be one of ${allowed.join(', ')}`);
  return v;
}

function maxChangesOf(raw: string | undefined): Pick<ReplayOptions, 'maxChanges'> {
  if (raw === undefined) return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`authz:replay: --max-changes must be a positive integer, not ${raw}`);
  return { maxChanges: n };
}

@SystemTask('reads the decision log and the authz changelog to replay one logged decision')
@Command('authz:replay', 'Replays a logged authorization decision at its instant and explains it')
@Argument('decisionId', true, 'the id of the decision (UUIDv7, the decisionId of its 403)')
@Option({ flags: '-f, --format <format>', defaultValue: 'text', choices: [...FORMATS] })
@Option('--max-changes <n>', false, 'changes after the decision to scan (default authz.replay.maxChanges)')
@Option({ flags: '--fail-on <verdict>', defaultValue: 'divergent', choices: [...FAIL_ON] })
export class ReplayCommand extends AuthzOrmCliCommand {
  /** Set by tests; else the registered `DecisionReplay` (`DbDecisionReplay`). */
  public Replay?: DecisionReplay;

  /** How long to wait before asking again while `authz.replay.concurrency` replays run in this process. */
  public RetryMs = 1000;

  public async execute(decisionId: string, options: ReplayCliOptions = {}): Promise<void> {
    await this.command(
      () => ({ format: choice(options.format, 'text', FORMATS, '--format'), failOn: choice(options.failOn, 'divergent', FAIL_ON, '--fail-on'), replay: maxChangesOf(options.maxChanges) }),
      async ({ format, failOn, replay }) => {
        const report = await this.replayOnce(decisionId, replay);
        if (report === undefined) throw new Error(`authz:replay: no decision ${decisionId} in the decision log`);
        if (format === 'json') this.out(JSON.stringify(report, null, 2));
        else this.print(report);
        if (SEVERITY[report.replay] >= SEVERITY[failOn]) this.fail(`authz:replay: the decision is ${report.replay} (--fail-on ${failOn})`);
      },
    );
  }

  private async replayOnce(id: string, options: ReplayOptions): Promise<ReplayReport | undefined> {
    const replay = (this.Replay ??= await this.Container.resolve(DecisionReplay));
    for (;;) {
      try {
        return await replay.replay(id, options);
      } catch (e) {
        if (e instanceof ReplayInTransaction) throw new Error(`authz:replay: refused: ${e.message}`);
        if (!(e instanceof ReplayBusy)) throw e;
        await sleep(this.RetryMs);
      }
    }
  }

  private print(r: ReplayReport): void {
    const d = r.decision;
    this.out(r.evidence === undefined ? r.replay : `${r.replay} (evidence: ${r.evidence})`);
    this.out(`decision ${d.id} at ${d.at} in ${d.domain}: ${d.principal} ${d.permission} ${resourceKey(d.resource)}`);
    this.out(`outcome recorded ${r.outcome.recorded}, replayed ${r.outcome.replayed ?? 'none'}`);
    this.out(`policy ${d.policyHash}${r.currentPolicy ? ' (current)' : ''}; ${r.limits.changes} changes scanned, ${r.limits.keys} keys`);
    if (r.missing.length > 0) this.out('missing:');
    for (const m of r.missing) this.out(`  ${m.input}${m.key === undefined ? '' : ` ${m.key}`}: ${m.reason}`);
    if (r.divergence.length > 0) this.out('divergence:');
    for (const v of r.divergence) this.out(`  ${v.part}${v.key === undefined ? '' : ` ${v.key}`}: recorded ${v.recorded}, replayed ${v.replayed}`);
    if (r.tree !== null) {
      this.out('tree:');
      this.tree(r.tree, 1);
    }
  }

  private tree(node: ReplayTreeNode, depth: number): void {
    this.out(`${'  '.repeat(depth)}${node.label} = ${node.truth} (${node.source})`);
    for (const c of node.children) this.tree(c, depth + 1);
  }
}
