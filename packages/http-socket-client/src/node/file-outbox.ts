import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FailedOutboxEntry, OutboxEntry, OutboxInput, OutboxStore } from '../outbox.js';

interface IFileOutbox {
  version: 1;
  /** last seq handed out; kept so a seq is never reused, even after the newest entry was removed */
  seq: number;
  pending: OutboxEntry[];
  failed: FailedOutboxEntry[];
}

const empty = (): IFileOutbox => ({ version: 1, seq: 0, pending: [], failed: [] });

/**
 * The outbox of a Node service, in one JSON file. Every change rewrites the file through a temp file,
 * fsync and rename, so a crash leaves the old queue or the new one, never a torn one. Payloads must be
 * JSON. One process at a time per file.
 */
export class FileOutboxStore implements OutboxStore {
  private cache: IFileOutbox | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(public readonly path: string) {}

  public add<P>(input: OutboxInput<P>): Promise<OutboxEntry<P>> {
    return this.change((state) => {
      const entry: OutboxEntry<P> = { seq: ++state.seq, name: input.name, payload: structuredClone(input.payload), createdAt: Date.now(), ...(input.key !== undefined ? { key: input.key } : {}) };
      state.pending.push(entry);
      return entry;
    });
  }

  public pending(): Promise<OutboxEntry[]> {
    return this.read((state) => state.pending);
  }

  public remove(seq: number): Promise<void> {
    return this.change((state) => {
      state.pending = state.pending.filter((entry) => entry.seq !== seq);
    });
  }

  public fail(entry: FailedOutboxEntry): Promise<void> {
    return this.change((state) => {
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
    return this.read((state) => state.failed);
  }

  public clearFailed(seqs?: readonly number[]): Promise<void> {
    return this.change((state) => {
      state.failed = seqs === undefined ? [] : state.failed.filter((entry) => !seqs.includes(entry.seq));
    });
  }

  private read<T>(pick: (state: IFileOutbox) => T): Promise<T> {
    return this.serial(async () => structuredClone(pick(await this.load())));
  }

  /** The cache changes only after the file did, so a failed write leaves both on the old queue. */
  private change<T>(mutate: (state: IFileOutbox) => T): Promise<T> {
    return this.serial(async () => {
      const draft = structuredClone(await this.load());
      const result = mutate(draft);
      await this.write(draft);
      this.cache = draft;
      return structuredClone(result);
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
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

    return (this.cache = state);
  }

  private async write(state: IFileOutbox): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    const temp = `${this.path}.tmp`;
    const file = await open(temp, 'w');
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temp, this.path);
  }
}
