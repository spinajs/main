import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FailedOutboxEntry, OutboxEntry, OutboxInput, OutboxStore } from '../outbox.js';

interface IFileOutbox {
  version: 1;
  /** last seq handed out; kept so a seq is never reused, even after the newest entry was removed */
  seq: number;
  pending: OutboxEntry[];
  failed: FailedOutboxEntry[];
}

export interface FileOutboxOptions {
  /** Test seam: the rename that publishes the temp file. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Base of the backoff between rename retries (grows linearly, capped at 5x). Default 10. */
  retryDelayMs?: number;
}

interface Job {
  run(state: IFileOutbox): unknown;
  writes: boolean;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

const RENAME_RETRIES = 5;
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

const empty = (): IFileOutbox => ({ version: 1, seq: 0, pending: [], failed: [] });
const isEntry = (value: unknown): value is { seq: number } => typeof value === 'object' && value !== null && typeof (value as { seq?: unknown }).seq === 'number';

/**
 * The outbox of a Node service, in one JSON file. Every write goes through a temp file, fsync and rename,
 * so a crash leaves the old queue or the new one, never a torn one. Changes that queue up while a write
 * is in flight are committed together by the next one. Payloads must be JSON. One process at a time per file.
 *
 * The whole queue is rewritten on every commit, so the cost of a write grows with the queue size: meant
 * for queues of up to some thousands of entries.
 */
export class FileOutboxStore implements OutboxStore {
  private cache: IFileOutbox | null = null;
  private queue: Job[] = [];
  private flushing = false;
  private readonly renameFile: (from: string, to: string) => Promise<void>;
  private readonly retryDelayMs: number;

  constructor(
    public readonly path: string,
    options: FileOutboxOptions = {},
  ) {
    this.renameFile = options.rename ?? rename;
    this.retryDelayMs = options.retryDelayMs ?? 10;
  }

  public add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>> {
    try {
      // A payload that cannot be serialized must fail its own caller, not the batch it would share a write with.
      JSON.stringify(input.payload);
    } catch (err) {
      return Promise.reject(err);
    }

    return this.submit(true, (state) => {
      const entry: OutboxEntry<P> = { seq: ++state.seq, name: input.name, payload: structuredClone(input.payload), createdAt: Date.now(), ...(input.key !== undefined ? { key: input.key } : {}) };
      state.pending.push(entry);
      return structuredClone(entry);
    });
  }

  public pending(): Promise<OutboxEntry[]> {
    return this.submit(false, (state) => structuredClone(state.pending));
  }

  public remove(seq: number): Promise<void> {
    return this.submit(true, (state) => {
      state.pending = state.pending.filter((entry) => entry.seq !== seq);
    });
  }

  public fail(entry: FailedOutboxEntry): Promise<void> {
    return this.submit(true, (state) => {
      const index = state.pending.findIndex((pending) => pending.seq === entry.seq);
      if (index < 0) {
        return;
      }

      state.pending.splice(index, 1);
      state.failed.push(structuredClone(entry));
      state.failed.sort((a, b) => a.seq - b.seq);
    });
  }

  public failed(): Promise<FailedOutboxEntry[]> {
    return this.submit(false, (state) => structuredClone(state.failed));
  }

  public clearFailed(seqs?: readonly number[]): Promise<void> {
    return this.submit(true, (state) => {
      state.failed = seqs === undefined ? [] : state.failed.filter((entry) => !seqs.includes(entry.seq));
    });
  }

  private submit<T>(writes: boolean, run: (state: IFileOutbox) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, writes, resolve: resolve as (value: unknown) => void, reject });
      if (!this.flushing) {
        this.flushing = true;
        void this.flush();
      }
    });
  }

  private async flush(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const batch = this.queue;
        this.queue = [];

        try {
          const state = await this.load();
          const results = batch.map((job) => job.run(state));
          if (batch.some((job) => job.writes)) {
            await this.write(state);
          }
          batch.forEach((job, i) => job.resolve(results[i]));
        } catch (err) {
          // Jobs mutated the cache in place: the file still holds the last committed queue, so reload from it.
          this.cache = null;
          batch.forEach((job) => job.reject(err));
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async load(): Promise<IFileOutbox> {
    if (this.cache) {
      return this.cache;
    }

    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return (this.cache = empty());
      }
      throw err;
    }

    let state: IFileOutbox;
    try {
      state = JSON.parse(text) as IFileOutbox;
    } catch (err) {
      throw new Error(`outbox file ${this.path} is damaged: ${(err as Error).message}`);
    }

    if (state?.version !== 1 || typeof state.seq !== 'number' || !Array.isArray(state.pending) || !Array.isArray(state.failed)) {
      throw new Error(`outbox file ${this.path} is not a version 1 outbox`);
    }

    const entries: unknown[] = [...state.pending, ...state.failed];
    if (!entries.every(isEntry)) {
      throw new Error(`outbox file ${this.path} holds a malformed entry`);
    }
    if (entries.some((entry) => (entry as { seq: number }).seq > state.seq)) {
      throw new Error(`outbox file ${this.path} has a seq counter behind its entries`);
    }

    return (this.cache = state);
  }

  private async write(state: IFileOutbox): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    const temp = `${this.path}.tmp`;
    try {
      const file = await open(temp, 'w');
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }

      await this.publish(temp);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }

    // An error here means the batch may have persisted although it rejects: at-least-once, and the idempotency key makes the retry safe.
    await this.syncDirectory();
  }

  /** Windows and antivirus scanners briefly hold the target open, which fails the rename with EPERM/EBUSY/EACCES. */
  private async publish(temp: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.renameFile(temp, this.path);
      } catch (err) {
        if (attempt > RENAME_RETRIES || !TRANSIENT.has((err as NodeJS.ErrnoException).code ?? '')) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * Math.min(attempt, 5)));
      }
    }
  }

  /** Makes the rename itself durable. Windows cannot open a directory for fsync, so it is skipped there. */
  private async syncDirectory(): Promise<void> {
    if (process.platform === 'win32') {
      return;
    }

    try {
      const dir = await open(dirname(this.path), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch (err) {
      if (!['EINVAL', 'EISDIR', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '')) {
        throw err;
      }
    }
  }
}
