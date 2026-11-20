import { inputsHashOf, resourceKey } from '@spinajs/authz';
import type { ChangeLog, DecisionRecord, ReplayMissing, ReplayOptions, ReplayRead, ReplayReport } from '@spinajs/authz';

import { policyHash } from '../canonical.js';
import { IREvaluator } from '../eval/evaluator.js';
import type { ExplainNode, Truth } from '../eval/explain.js';
import type { PolicyIR } from '../ir.js';
import type { HistoryContributor } from './contributor.js';
import { conditionReads, instantOf, policyProblems, recordProblems, replayContext, replayWindow } from './context.js';
import type { ReplayContext } from './context.js';
import { ReplayBudgetExceeded, ReplayHistory } from './history-scan.js';
import { HistoricalTupleSource } from './source.js';
import { replayVerdict } from './verdict.js';
import type { VerdictInput } from './verdict.js';

export interface ReplayLimits {
  maxChanges: number;
  maxKeys: number;
  maxDepth: number;
  maxCalls: number;
  clockSkewMs: number;
  commitLagMs: number;
  timeoutMs: number;
  /** `ReplayHistoryLimits.precisionMs`. */
  precisionMs?: number;
}

export interface ReplayDeps {
  log: ChangeLog;
  /** The canonical IR text stored under the hash, or undefined. */
  loadPolicy(policyHash: string): Promise<string | undefined>;
  contributors: readonly HistoryContributor[];
  limits: ReplayLimits;
  /** `PolicyHashSource.policyHash(domain)`, for `ReplayReport.currentPolicy`. */
  currentPolicyHash?(domain: string): string | undefined;
  /** The reader's clock (`ReplayHistoryLimits.now`). */
  now?: () => number;
}

export interface ReplayDecisionOptions extends ReplayOptions {
  /** Keys the log cut to their column width (`readDecisionRecord`). */
  truncated?: readonly string[];
}

type Outcome = Omit<VerdictInput, 'recorded'> & { tree: ExplainNode | null; reads: ReplayRead[]; history?: ReplayHistory };

interface Run {
  history?: ReplayHistory;
  reads: ReplayRead[];
  /** Changes the scan had read when it ran past `maxChanges`. */
  scanned?: number;
}

const blocked = (missing: readonly ReplayMissing[]): Outcome => ({ blocked: missing, truth: null, unknowns: [], tree: null, reads: [] });

/**
 * Re-evaluates a logged decision with the IR reference evaluator against the state and the policy at its instant
 * (sections 3.4 to 3.6 of the L3 plan). Rejects only when `options.signal` aborts; every other limit is a verdict.
 */
export async function replayDecision(record: DecisionRecord, deps: ReplayDeps, options: ReplayDecisionOptions = {}): Promise<ReplayReport> {
  const started = Date.now();
  const maxChanges = options.maxChanges ?? deps.limits.maxChanges;
  const timeout = AbortSignal.timeout(deps.limits.timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const run: Run = { reads: [] };
  let outcome: Outcome;
  try {
    outcome = await evaluate(record, deps, { maxChanges, signal, truncated: options.truncated ?? [] }, run);
  } catch (e) {
    if (options.signal?.aborted) throw options.signal.reason;
    outcome = { ...blocked([]), unknowns: [stopped(e, timeout, deps.limits.timeoutMs)], reads: run.reads, ...(run.history === undefined ? {} : { history: run.history }) };
    if (e instanceof ReplayBudgetExceeded && e.limit === 'maxChanges') run.scanned = e.count;
  }
  return reportOf(record, deps, outcome, { maxChanges, started, scanned: run.scanned });
}

/** A limit the replay ran into; anything else is a fault and rethrown. */
function stopped(e: unknown, timeout: AbortSignal, timeoutMs: number): ReplayMissing {
  if (e instanceof ReplayBudgetExceeded) return { input: 'history-budget', key: e.limit, reason: `the replay read ${e.count} ${e.limit === 'maxChanges' ? 'changes' : 'keys'}, past its ${e.limit}` };
  if (timeout.aborted) return { input: 'timeout', reason: `the replay ran past timeoutMs ${timeoutMs}` };
  throw e;
}

function reportOf(record: DecisionRecord, deps: ReplayDeps, outcome: Outcome, o: { maxChanges: number; started: number; scanned?: number }): ReplayReport {
  const verdict = replayVerdict({ ...outcome, recorded: { allowed: record.allowed, cached: record.cached, ...(record.reason === undefined ? {} : { reason: record.reason }) } });
  const { inputs: _inputs, facts: _facts, ...decision } = record;
  return {
    decision,
    currentPolicy: deps.currentPolicyHash?.(record.domain) === record.policyHash,
    ...verdict,
    outcome: { recorded: record.allowed ? 'allow' : 'deny', replayed: outcome.truth },
    inputsHash: { recorded: record.inputsHash, replayed: outcome.inputsHash?.replayed ?? null },
    tree: outcome.tree,
    reads: unique(outcome.reads),
    limits: { changes: outcome.history?.changes ?? o.scanned ?? 0, maxChanges: o.maxChanges, keys: outcome.history?.keys ?? 0, durationMs: Date.now() - o.started },
  };
}

async function evaluate(record: DecisionRecord, deps: ReplayDeps, o: { maxChanges: number; signal: AbortSignal; truncated: readonly string[] }, run: Run): Promise<Outcome> {
  const problems = recordProblems(record, o.truncated);
  if (problems.length > 0) return blocked(problems);
  const ir = await policyAt(record, deps);
  if (!('types' in ir)) return blocked([ir]);
  const narrowing = policyProblems(record, ir);
  if (narrowing.length > 0) return blocked(narrowing);
  const replayed = policyHash(ir);
  if (replayed !== record.policyHash) return { ...blocked([]), policyHash: { recorded: record.policyHash, replayed } };

  const t = instantOf(record);
  const limits = deps.limits;
  const kinds = [...new Set(deps.contributors.map((c) => c.kind))];
  const historyLimits = { maxChanges: o.maxChanges, maxKeys: limits.maxKeys, window: replayWindow(record, limits), ...(limits.precisionMs === undefined ? {} : { precisionMs: limits.precisionMs }), ...(deps.now === undefined ? {} : { now: deps.now }) };
  const history = (run.history = await ReplayHistory.load(deps.log, t, kinds, historyLimits, o.signal));
  const source = new HistoricalTupleSource(ir, t, deps.contributors, history);
  const ctx = replayContext(record);
  let result;
  try {
    result = await new IREvaluator(ir, source, { maxDepth: limits.maxDepth, maxCalls: limits.maxCalls }).check({ principal: ctx.principal, permission: record.permission, resource: record.resource.id == null ? { type: record.resource.type } : { type: record.resource.type, id: record.resource.id }, context: ctx.context, at: ctx.at });
  } finally {
    run.reads.push(...source.reads);
  }
  const unheld = unheldReads(result.tree, ir, ctx);
  let truth: Truth = unheld.length > 0 ? 'unknown' : result.truth;
  const unknowns = [...unheld, ...unknownsOf(result.tree, run.reads)];
  // Without facts the companions are unknown, and they can grant or deny.
  if (record.facts === undefined && truth !== 'unknown' && truth !== (record.allowed ? 'allow' : 'deny')) {
    truth = 'unknown';
    unknowns.push({ input: 'principal-facts', reason: 'the record has no principal facts: its companions are unknown' });
  }
  return { blocked: [], truth, unknowns: unique(unknowns), tree: result.tree, reads: run.reads, history, ...(record.inputs === undefined ? {} : { inputsHash: { recorded: record.inputsHash, replayed: rehash(record, record.inputs) } }) };
}

async function policyAt(record: DecisionRecord, deps: ReplayDeps): Promise<PolicyIR | ReplayMissing> {
  const key = record.policyHash;
  if (key === 'unknown') return { input: 'policy_version', key, reason: 'the decision was logged without a policy hash' };
  const text = await deps.loadPolicy(key);
  if (text === undefined) return { input: 'policy_version', key, reason: 'no policy version is stored under the hash' };
  try {
    const ir = JSON.parse(text) as unknown;
    if (typeof ir === 'object' && ir !== null && 'types' in ir) return ir as PolicyIR;
  } catch {
    // reported below
  }
  return { input: 'policy_version', key, reason: 'the stored policy version is not an IR' };
}

/** What `inputsHash` hashed, from the stored capture, named one by one: never a spread of `record.inputs`. */
function rehash(record: DecisionRecord, inputs: NonNullable<DecisionRecord['inputs']>): string {
  return inputsHashOf({
    principal: inputs.principalState,
    actor: inputs.actorState,
    permission: record.permission,
    resource: resourceKey(record.resource),
    env: inputs.env,
    attributes: inputs.attributes,
    relations: inputs.relations,
    modelVersions: inputs.modelVersions,
    policyHash: record.policyHash,
  });
}

/** Caveats the walk evaluated that read what the replay does not hold: their answer, whatever it was, is not the decision's. */
function unheldReads(tree: ExplainNode, ir: PolicyIR, ctx: ReplayContext): ReplayMissing[] {
  const out: ReplayMissing[] = [];
  for (const node of nodes(tree)) {
    if (!node.source.startsWith('caveats.')) continue;
    const name = node.source.slice('caveats.'.length);
    const def = Object.entries(ir.caveats).find(([n]) => n === name)?.[1];
    // The tuple's context is part of the tuple, rebuilt at T; a read above a supplied path still merges request values.
    const supplied = node.tupleContext ?? [];
    for (const path of def === undefined ? [] : conditionReads(def.expr)) {
      if (supplied.some((p) => path === p || path.startsWith(`${p}.`))) continue;
      const reason = ctx.unheld(path);
      if (reason !== undefined) out.push({ input: path.startsWith('fn.') ? 'condition-function' : path, key: path.startsWith('fn.') ? path.slice(3) : name, reason });
    }
  }
  return out;
}

/** Rule 4's names: the gap reads, and the opaque terms, limits and undecided caveats the tree marks unknown. */
function unknownsOf(tree: ExplainNode, reads: readonly ReplayRead[]): ReplayMissing[] {
  const out: ReplayMissing[] = reads.filter((r) => r.origin === 'gap').map((r) => ({ input: r.kind ?? 'relation', key: r.key, reason: r.reason ?? 'not established at the decision instant' }));
  for (const node of nodes(tree)) {
    if (node.truth !== 'unknown') continue;
    if (node.source === 'opaque') out.push({ input: 'opaque', key: node.label.replace(/^opaque /, ''), reason: 'the IR cannot see it' });
    else if (node.source === 'limit') out.push({ input: 'limit', reason: node.label });
    else if (node.source.startsWith('caveats.')) out.push({ input: 'caveat', key: node.source.slice('caveats.'.length), reason: 'undecided in the replayed context' });
  }
  return out;
}

function* nodes(n: ExplainNode): Iterable<ExplainNode> {
  yield n;
  for (const c of n.children) yield* nodes(c);
}

const unique = <T>(xs: readonly T[]): T[] => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
