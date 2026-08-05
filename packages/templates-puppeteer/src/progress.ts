import { ConsoleMessage, Page } from 'puppeteer';
import { IRenderProgress, RenderPhase, RenderProgressCallback } from '@spinajs/templates';

/** Minimum gap between resource-driven emissions (ms). */
const THROTTLE_MS = 150;
/** Re-emit interval during long phases so the bar moves even when nothing changes (ms). */
const HEARTBEAT_MS = 750;
/** Cap on the request-approximation ratio before any task line arrives (see computePercent). */
const PRE_TASK_APPROXIMATION_CAP = 0.5;

/** Percent band [start, end] each phase occupies. */
const PHASE_BANDS: Record<RenderPhase, [number, number]> = {
  [RenderPhase.Starting]: [0, 10],
  [RenderPhase.Preparing]: [10, 15],
  [RenderPhase.Loading]: [15, 80],
  [RenderPhase.Rendering]: [80, 95],
  [RenderPhase.Done]: [100, 100],
  [RenderPhase.Failed]: [0, 0],
};

/** Console-line prefix of the generic in-page progress protocol. */
export const PAGE_PROGRESS_PREFIX = '__spinajs_progress__:';

/**
 * Parse one console line of the in-page progress protocol:
 * `__spinajs_progress__:{"task":"images","done":2,"total":40}`.
 * Returns null for anything that is not a well-formed protocol line — progress
 * must never break a render, so there is no error path.
 */
export function parseProgressLine(text: string): { task: string; done: number; total: number } | null {
  if (!text || !text.startsWith(PAGE_PROGRESS_PREFIX)) {
    return null;
  }

  try {
    const raw = JSON.parse(text.slice(PAGE_PROGRESS_PREFIX.length)) as { task?: unknown; done?: unknown; total?: unknown };
    const { task, done, total } = raw;

    if (typeof task !== 'string' || task.length === 0) {
      return null;
    }
    if (typeof done !== 'number' || !Number.isFinite(done) || done < 0) {
      return null;
    }
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
      return null;
    }

    return { task, done, total };
  } catch {
    return null;
  }
}

/**
 * Tracks a single puppeteer render and delivers throttled {@link IRenderProgress}
 * snapshots to a callback. Resource counts come from the page's request lifecycle
 * events; the percentage is phase-weighted (see {@link PHASE_BANDS}), and a
 * heartbeat keeps it ticking during the long Loading/Rendering phases.
 *
 * When constructed without a callback it is entirely inert - no listeners, no
 * timers, no allocations on the hot path - so callers can always create one.
 */
export class RenderProgressReporter {
  private readonly enabled: boolean;
  private readonly callback: RenderProgressCallback;
  private readonly startedAt: number = Date.now();

  private phaseNow: RenderPhase = RenderPhase.Starting;
  private loaded = 0;
  private pending = 0;
  private failed = 0;
  /** Last reported counts per task from the in-page progress protocol. */
  private tasks: Map<string, { done: number; total: number }> | null = null;

  private lastEmitAt = 0;
  private lastPercent = 0;

  private heartbeat: NodeJS.Timeout | null = null;
  private page: Page | null = null;

  // pre-bound so add/remove reference the same function identities
  private readonly onRequest = () => {
    this.pending++;
  };
  private readonly onRequestFinished = () => {
    this.pending = Math.max(0, this.pending - 1);
    this.loaded++;
    this.emit();
  };
  private readonly onRequestFailed = () => {
    this.pending = Math.max(0, this.pending - 1);
    this.failed++;
    this.emit();
  };
  private readonly onConsole = (msg: ConsoleMessage) => {
    const parsed = parseProgressLine(typeof msg?.text === 'function' ? msg.text() : '');
    if (!parsed) {
      return;
    }

    (this.tasks ??= new Map()).set(parsed.task, { done: parsed.done, total: parsed.total });
    this.emit();
  };

  constructor(private readonly filePath: string, callback?: RenderProgressCallback) {
    this.enabled = !!callback;
    this.callback = callback ?? (() => undefined);
  }

  /** Attach resource-lifecycle counters to the page. Call once, after newPage(). */
  public attach(page: Page): void {
    if (!this.enabled) {
      return;
    }

    this.page = page;
    page.on('request', this.onRequest);
    page.on('requestfinished', this.onRequestFinished);
    page.on('requestfailed', this.onRequestFailed);
    page.on('console', this.onConsole);
  }

  /** Transition to a new phase and emit immediately (bypassing the throttle). */
  public phase(phase: RenderPhase, message?: string): void {
    if (!this.enabled) {
      return;
    }

    this.phaseNow = phase;

    // Heartbeat only during the phases that can take a long time.
    if (phase === RenderPhase.Loading || phase === RenderPhase.Rendering) {
      this.startHeartbeat();
    } else {
      this.stopHeartbeat();
    }

    this.emit(message, true);
  }

  /** Stop the heartbeat and detach page listeners. Safe to call multiple times. */
  public dispose(): void {
    this.stopHeartbeat();

    if (this.page) {
      this.page.off('request', this.onRequest);
      this.page.off('requestfinished', this.onRequestFinished);
      this.page.off('requestfailed', this.onRequestFailed);
      this.page.off('console', this.onConsole);
      this.page = null;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) {
      return;
    }

    this.heartbeat = setInterval(() => this.emit(), HEARTBEAT_MS);
    // never keep the process alive just to tick progress
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private computePercent(): number {
    if (this.phaseNow === RenderPhase.Failed) {
      return this.lastPercent;
    }

    const [start, end] = PHASE_BANDS[this.phaseNow];

    if (this.phaseNow === RenderPhase.Loading) {
      // Page-reported task totals are exact. Until the first task line arrives,
      // cap the request-count approximation at half the band: a transient
      // loaded/seen spike (e.g. one early asset with nothing else pending)
      // would otherwise pin the never-regressing percent at the band end,
      // locking out the exact task-driven percent for the rest of the load.
      const taskRatio = this.taskRatio();
      const ratio = taskRatio ?? Math.min(this.requestRatio(), PRE_TASK_APPROXIMATION_CAP);
      return Math.max(this.lastPercent, Math.min(end, Math.round(start + (end - start) * ratio)));
    }

    // milestone phases sit at their band start (Done -> 100); never regress
    return Math.max(this.lastPercent, start);
  }

  /** Exact ratio from page-reported tasks, or null when nothing (usable) was reported. */
  private taskRatio(): number | null {
    if (!this.tasks?.size) {
      return null;
    }

    let done = 0;
    let total = 0;
    for (const t of this.tasks.values()) {
      done += Math.min(t.done, t.total);
      total += t.total;
    }

    return total > 0 ? Math.min(1, done / total) : null;
  }

  /** Approximate ratio from the request lifecycle; total is unknown up front. */
  private requestRatio(): number {
    const seen = this.loaded + this.pending;
    return seen > 0 ? this.loaded / seen : 0;
  }

  private emit(message?: string, force = false): void {
    if (!this.enabled) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastEmitAt < THROTTLE_MS) {
      return;
    }
    this.lastEmitAt = now;

    const percent = this.computePercent();
    this.lastPercent = percent;

    const progress: IRenderProgress = {
      phase: this.phaseNow,
      percent,
      resourcesLoaded: this.loaded,
      resourcesPending: this.pending,
      resourcesFailed: this.failed,
      elapsedMs: now - this.startedAt,
      filePath: this.filePath,
      message: message ?? this.defaultMessage(),
      tasks: this.tasks?.size ? Object.fromEntries([...this.tasks].map(([name, t]) => [name, { ...t }])) : undefined,
    };

    // progress must never stall or break a render: don't await, swallow errors
    try {
      const result = this.callback(progress);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch(() => {
          /* swallow async listener errors */
        });
      }
    } catch {
      /* swallow sync listener errors */
    }
  }

  private defaultMessage(): string {
    switch (this.phaseNow) {
      case RenderPhase.Starting:
        return 'Starting renderer';
      case RenderPhase.Preparing:
        return 'Preparing HTML';
      case RenderPhase.Loading: {
        if (this.tasks?.size) {
          return [...this.tasks].map(([name, t]) => `${name} ${t.done}/${t.total}`).join(', ');
        }
        const extra = [`${this.loaded} done`];
        if (this.pending) extra.push(`${this.pending} pending`);
        if (this.failed) extra.push(`${this.failed} failed`);
        return `Loading resources (${extra.join(', ')})`;
      }
      case RenderPhase.Rendering:
        return 'Generating output';
      case RenderPhase.Done:
        return 'Done';
      case RenderPhase.Failed:
        return 'Failed';
      default:
        return '';
    }
  }
}
