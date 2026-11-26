import { DI, Injectable, Singleton } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';

import { REPLAY_MAX_CHANGES_LIMIT, replayLimits, replayWindow } from './config.js';
import type { ReplayLimits } from './config.js';
import { RecordingSource, ReplayService, Replayer, StateSource } from './contracts.js';
import type { Recording, ReplayMissing, ReplayOutcome, ReplayReport, ReplayRunOptions, StateView } from './contracts.js';
import { RecordingUnreadable, ReplayBusy } from './errors.js';
import type { ReplayWindow } from './history.js';
import { ReplayBudgetExceeded } from './history-scan.js';
import { verdictOf } from './verdict.js';

interface DomainParts {
  readonly recordings: RecordingSource;
  readonly replayer: Replayer;
  readonly state: StateSource;
}

/**
 * Loads a recording from the `RecordingSource` of its domain, hands the domain's `Replayer` the state at the
 * recording's instant through the process's `StateSource`, and applies the verdict rules to what it answers.
 */
@Singleton()
@Injectable(ReplayService)
export class DomainReplayService extends ReplayService {
  private readonly running = new Map<string, number>();

  /**
   * @throws ReplayBusy when `concurrency` replays of the domain run in this process already
   * @throws InvalidOperation when the domain has no `RecordingSource` or `Replayer`, or one of them twice, or the process not one `StateSource`; when `options.maxChanges` is not a positive integer; when a `replay.*` setting is refused (`replayLimits`)
   */
  async replay(domain: string, id: string, options: ReplayRunOptions = {}): Promise<ReplayReport | undefined> {
    options.signal?.throwIfAborted();
    // NaN would switch the budget off: no count is ever greater than it.
    if (options.maxChanges !== undefined && !(Number.isInteger(options.maxChanges) && options.maxChanges >= 1)) throw new InvalidOperation(`replay: maxChanges must be a positive integer, not ${options.maxChanges}`);
    const parts = await partsOf(domain);
    const limits = replayLimits(domain);
    const running = this.running.get(domain) ?? 0;
    if (running >= limits.concurrency) throw new ReplayBusy(domain, limits.concurrency);
    this.running.set(domain, running + 1);
    try {
      return await run(domain, id, parts, limits, options);
    } finally {
      this.running.set(domain, (this.running.get(domain) ?? 1) - 1);
    }
  }
}

async function run(domain: string, id: string, parts: DomainParts, limits: ReplayLimits, options: ReplayRunOptions): Promise<ReplayReport | undefined> {
  let recording: Recording | undefined;
  try {
    recording = await parts.recordings.load(id);
  } catch (e) {
    if (!(e instanceof RecordingUnreadable)) throw e;
    return reportOf(id, domain, undefined, refused(`the record is not readable: ${e.message}`));
  }
  if (recording === undefined) return undefined;
  if (recording.domain !== domain) return reportOf(id, domain, recording.outcome, refused(`the recording belongs to the domain ${recording.domain}`));
  const window = replayWindow(recording, limits);
  const unplaced = outsideCalendar(recording.at, window);
  if (unplaced !== undefined) return reportOf(id, domain, recording.outcome, refused(unplaced));
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const budget = { maxChanges: Math.min(options.maxChanges ?? limits.maxChanges, REPLAY_MAX_CHANGES_LIMIT), maxKeys: limits.maxKeys };
  let outcome: ReplayOutcome;
  try {
    const view = watched(parts.state.view(recording.at, window, budget, signal));
    const answer = await parts.replayer.replay(recording, view.view, signal, budget);
    // A replayer that went on after a read of the state failed answers without that state.
    if (view.failure !== undefined) throw view.failure.error;
    outcome = answer;
  } catch (e) {
    if (options.signal?.aborted) throw options.signal.reason;
    outcome = { outcome: 'unknown', missing: [stopped(e, timeout, limits.timeoutMs)], divergences: [] };
  }
  return reportOf(id, domain, recording.outcome, outcome);
}

// A scan from an invalid instant reads nothing, which would pass for a window without changes.
function outsideCalendar(at: Date, window: ReplayWindow): string | undefined {
  if (Number.isNaN(at.getTime())) return 'the recording has no valid instant';
  if (Number.isNaN(new Date(at.getTime() - window.beforeMs - 1).getTime())) return `the window of the recording, ${window.beforeMs} ms before ${at.toISOString()}, starts before the earliest instant a Date holds`;
  return undefined;
}

const refused = (reason: string): ReplayOutcome => ({ outcome: 'unknown', missing: [{ input: 'record', reason }], divergences: [] });

function reportOf(id: string, domain: string, recorded: unknown, outcome: ReplayOutcome): ReplayReport {
  return { id, domain, ...verdictOf(recorded, outcome), ...(outcome.tree === undefined ? {} : { tree: outcome.tree }) };
}

/** A limit the replay ran into; anything else is a fault and rethrown. */
function stopped(e: unknown, timeout: AbortSignal, timeoutMs: number): ReplayMissing {
  if (e instanceof ReplayBudgetExceeded) return { input: 'history-budget', key: e.limit, reason: `the replay read ${e.count} ${e.limit === 'maxChanges' ? 'changes' : 'keys'}, past its ${e.limit}` };
  // Only the timeout's own abort: a fault that happens to come after the deadline is still a fault.
  if (timeout.aborted && e === timeout.reason) return { input: 'timeout', reason: `the replay ran past timeoutMs ${timeoutMs}` };
  throw e;
}

interface Watched {
  readonly view: StateView;
  failure?: { readonly error: unknown };
}

/** The view, with the first error any of its reads rejected with. */
function watched(view: StateView): Watched {
  const out: Watched = {
    view: {
      at: view.at,
      keys: (entity, ids) => noted(out, () => view.keys(entity, ids)),
      select: (entity, where) => noted(out, () => view.select(entity, where)),
    },
  };
  return out;
}

async function noted<T>(watch: Watched, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    watch.failure ??= { error: e };
    throw e;
  }
}

async function partsOf(domain: string): Promise<DomainParts> {
  const scope = `for the domain ${domain}`;
  // Typed as lists, yet DI answers a promise when a registered part has a dependency that resolves asynchronously.
  const [recordings, replayers, states] = await Promise.all([DI.resolve(Array.ofType(RecordingSource)), DI.resolve(Array.ofType(Replayer)), DI.resolve(Array.ofType(StateSource))]);
  return {
    recordings: single(recordings.filter((s) => s instanceof RecordingSource && s.domain === domain), 'RecordingSource', scope),
    replayer: single(replayers.filter((r) => r instanceof Replayer && r.domain === domain), 'Replayer', scope),
    state: single(states.filter((s) => s instanceof StateSource), 'StateSource', 'in this process'),
  };
}

function single<T>(found: readonly T[], what: string, scope: string): T {
  if (found.length === 1) return found[0];
  throw new InvalidOperation(found.length === 0 ? `replay: no ${what} is registered ${scope}` : `replay: ${what} is registered ${found.length} times ${scope}; keep one`);
}
