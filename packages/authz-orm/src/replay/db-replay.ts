import { AuthzConfigError, DecisionReplay, PolicyHashSource, ReplayBusy, ReplayInTransaction, SYSTEM, changeLog, parseResourceKey, runWithPrincipal } from '@spinajs/authz';
import type { ReplayOptions, ReplayReport, ResourceRef } from '@spinajs/authz';
import { AttributeHistoryContributors, HistoryContributors, StoredPolicySplicers, replayDecision, replayVerdict } from '@spinajs/authz-ir';
import type { ReplayDeps } from '@spinajs/authz-ir';
import { DI, Injectable, Singleton } from '@spinajs/di';

import { readDecisionRecord } from '../audit/db-decision-log.js';
import { AuthzDecisionLogEntry } from '../audit/decision-log-model.js';
import { changeLogPrecisionMs } from '../changelog/db-changelog.js';
import { readPolicyVersion } from '../changelog/policy-version.js';
import { ChangeLogRecord } from '../changelog/record.js';
import { recordDriver } from '../records.js';
import { REPLAY_MAX_CHANGES_LIMIT, replayConfig } from './schema.js';
import type { ReplayConfig } from './schema.js';

const POLICY_HASH = /^[0-9a-f]{64}$/;

/** The registered contributors, one per changelog kind: two would answer for the same rows. */
function contributors(): HistoryContributors[] {
  const all = DI.resolve(Array.ofType(HistoryContributors)).filter((c) => c instanceof HistoryContributors);
  const kinds = all.map((c) => c.kind);
  const twice = kinds.find((k, i) => kinds.indexOf(k) !== i);
  if (twice !== undefined) throw new AuthzConfigError(`authz replay: two history contributors are registered for the ${twice} changelog kind`);
  return all;
}

function attributeContributor(): AttributeHistoryContributors | undefined {
  const all = DI.resolve(Array.ofType(AttributeHistoryContributors)).filter((c) => c instanceof AttributeHistoryContributors);
  if (all.length > 1) throw new AuthzConfigError('authz replay: two history contributors are registered for the attribute changelog kind');
  return all.at(0);
}

async function depsOf(config: ReplayConfig): Promise<ReplayDeps> {
  const hashes = DI.check(PolicyHashSource) ? await DI.resolve(PolicyHashSource) : undefined;
  const attributes = attributeContributor();
  return {
    ...(attributes === undefined ? {} : { attributes }),
    log: changeLog(),
    // A hash readPolicyVersion would refuse names no stored version.
    loadPolicy: async (h) => (POLICY_HASH.test(h) ? (await readPolicyVersion(h))?.ir : undefined),
    contributors: contributors(),
    splicers: DI.resolve(Array.ofType(StoredPolicySplicers)).filter((s) => s instanceof StoredPolicySplicers),
    limits: { ...config, precisionMs: changeLogPrecisionMs(recordDriver(ChangeLogRecord)) },
    ...(hashes === undefined ? {} : { currentPolicyHash: (domain: string) => hashes.policyHash(domain) }),
  };
}

/**
 * Replays decisions of the database decision log (`authz_decision_log`) against the authz changelog and the stored
 * policy versions, on the primary. Contributors and splicers are the `HistoryContributors` and `StoredPolicySplicers`
 * registrations; `@spinajs/authz-orm/replay` registers the one for ORM relation columns.
 */
@Singleton()
@Injectable(DecisionReplay)
export class DbDecisionReplay extends DecisionReplay {
  private running = 0;

  /**
   * @throws ReplayBusy when `authz.replay.concurrency` replays are running
   * @throws ReplayInTransaction inside a transaction open on the authz connection
   */
  async replay(decisionId: string, options: ReplayOptions = {}): Promise<ReplayReport | undefined> {
    const config = replayConfig();
    // Under REPEATABLE READ (MySQL's default) the changelog would be read from the transaction's snapshot while the
    // stores' current rows, on other connections, stay fresh: the stale pairing the primary-only rule forbids.
    if (recordDriver(ChangeLogRecord).CurrentTransaction !== undefined) throw new ReplayInTransaction();
    if (this.running >= config.concurrency) throw new ReplayBusy(config.concurrency);
    this.running++;
    try {
      return await this.run(decisionId, options, config);
    } finally {
      this.running--;
    }
  }

  private async run(id: string, options: ReplayOptions, config: ReplayConfig): Promise<ReplayReport | undefined> {
    const started = Date.now();
    let read: Awaited<ReturnType<typeof readDecisionRecord>>;
    try {
      read = await readDecisionRecord(id);
    } catch (err) {
      if (!(err instanceof AuthzConfigError)) throw err;
      return unreadable(id, err, config, started);
    }
    if (read === undefined) return undefined;
    const maxChanges = options.maxChanges === undefined ? {} : { maxChanges: Math.min(options.maxChanges, REPLAY_MAX_CHANGES_LIMIT) };
    return replayDecision(read.record, await depsOf(config), { ...options, ...maxChanges, truncated: read.truncated });
  }
}

/** Rule 1 for a row the log cannot read back as a record: what the plain columns hold, and why it is not replayed. */
async function unreadable(id: string, err: AuthzConfigError, config: ReplayConfig, started: number): Promise<ReplayReport | undefined> {
  const row = await runWithPrincipal(SYSTEM, async () => (await AuthzDecisionLogEntry.query().onPrimary().where('id', id).first()) as AuthzDecisionLogEntry | undefined);
  if (row === undefined) throw err;
  const allowed = row.allowed === true || Number(row.allowed) === 1;
  const cached = row.cached === true || Number(row.cached) === 1;
  const verdict = replayVerdict({ recorded: { allowed, cached }, blocked: [{ input: 'record', reason: `the record is not readable: ${err.message}` }], truth: null, unknowns: [] });
  return {
    decision: { id: row.id, at: row.at.toJSDate().toISOString(), domain: row.domain, principal: row.principal, permission: row.permission, resource: resourceOf(row.resource), allowed, cached, policyHash: row.policy_hash, modelVersions: {}, inputsHash: row.inputs_hash },
    currentPolicy: false,
    ...verdict,
    outcome: { recorded: allowed ? 'allow' : 'deny', replayed: null },
    inputsHash: { recorded: row.inputs_hash, replayed: null },
    tree: null,
    reads: [],
    limits: { changes: 0, maxChanges: config.maxChanges, keys: 0, durationMs: Date.now() - started },
  };
}

function resourceOf(key: string): ResourceRef {
  try {
    return parseResourceKey(key);
  } catch {
    return { type: key };
  }
}
