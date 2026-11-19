import { Injectable, PerChildInstance, SyncService } from '@spinajs/di';
import { InternalLogger } from '@spinajs/internal-logger';

interface WatchState {
  /** Bumped by `dispose()`; a poll applies its rows only while the token it read before its query is current. */
  generation: number;
  disposed: boolean;
  /** Stops the running timer; null while none runs. */
  stopTimer: (() => void) | null;
  /** The poll the timer runs now, or the last one; never rejects. */
  polling: Promise<void>;
}

// Kept off the class, so the exported type carries only dispose(): the bootstrapper drives the rest through the
// functions below, which the package index does not re-export.
const states = new WeakMap<DbConfigWatcher, WatchState>();

function stateOf(watcher: DbConfigWatcher): WatchState {
  let state = states.get(watcher);
  if (!state) {
    state = { generation: 0, disposed: false, stopTimer: null, polling: Promise.resolve() };
    states.set(watcher, state);
  }
  return state;
}

/**
 * Runs the watch poll of the `configuration` table on a timer. A DI service, so the container's `dispose()` ends it; the
 * bootstrapper resolves it once the Orm is resolved, so the reverse-order dispose ends it before the Orm closes.
 */
@PerChildInstance()
@Injectable()
export class DbConfigWatcher extends SyncService {
  /**
   * Ends the timer for good: a later sweep starts nothing on this watcher, and a poll in flight applies nothing from now
   * on. Settles once a poll the timer was running has finished.
   */
  public async dispose(): Promise<void> {
    const state = stateOf(this);
    state.disposed = true;
    state.generation++;
    state.stopTimer?.();
    await state.polling;
  }
}

/**
 * Calls `poll` every `intervalMs`, each run scheduled once the previous one settled. Replaces a running timer, whose
 * poll in flight the new timer waits for before it counts down; a disposed watcher starts nothing.
 */
export function startWatch(watcher: DbConfigWatcher, poll: () => Promise<void>, intervalMs: number): void {
  const state = stateOf(watcher);
  state.stopTimer?.();
  if (state.disposed) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      state.polling = run().catch((err: unknown) => InternalLogger.error({ error: err }, 'Failed to refresh watched config values from db', 'configuration-db-source'));
    }, intervalMs);
  };

  const run = async () => {
    try {
      await poll();
    } finally {
      scheduleNext();
    }
  };

  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
    if (state.stopTimer === stop) {
      state.stopTimer = null;
    }
  };

  state.stopTimer = stop;
  void state.polling.then(scheduleNext);
}

/** What a poll reads before its query. */
export function watchToken(watcher: DbConfigWatcher): number {
  return stateOf(watcher).generation;
}

/** Whether a poll that read `token` may still apply its rows. */
export function isWatchCurrent(watcher: DbConfigWatcher, token: number): boolean {
  return token === stateOf(watcher).generation;
}

export function isWatchDisposed(watcher: DbConfigWatcher): boolean {
  return stateOf(watcher).disposed;
}
