import { Injectable, Singleton } from '@spinajs/di';

import type { AuthzCommandResult, AuthzTx } from '../contracts/admin.js';
import { AuthzConfigError } from '../contracts/errors.js';
import { engineLog } from '../host/log.js';

/** Where AuthzAdmin runs a batch: one transaction, the domain's version and the idempotency store. */
export abstract class AuthzAdminBackend {
  /** Commits when fn resolves, rolls back when it rejects (the rejection propagates). */
  abstract transaction<T>(domain: string, fn: (tx: AuthzTx) => Promise<T>): Promise<T>;
  /** Inside fn: bump authz_version(domain). */
  abstract bumpVersion(domain: string, tx: AuthzTx): Promise<void>;
  /** Results a committed batch stored under (domain, actorKey, key), unless older than their expiry. */
  abstract recall(domain: string, actorKey: string, key: string, now: Date): Promise<readonly AuthzCommandResult[] | undefined>;
  /** Inside fn: store them; 'exists' when another batch stored the key first (the caller rolls back and recalls). */
  abstract remember(domain: string, actorKey: string, key: string, results: readonly AuthzCommandResult[], expiresAt: Date, tx: AuthzTx): Promise<'stored' | 'exists'>;
}

/** The `driver` of a memory transaction; memory stores register how to undo each write. */
export interface MemoryTx {
  onRollback(undo: () => void): void;
}

class MemoryTxDriver implements MemoryTx {
  readonly undo: (() => void)[] = [];
  open = true;

  onRollback(undo: () => void): void {
    if (!this.open) throw new AuthzConfigError('memory transaction already ended; a write outside its transaction cannot be undone');
    if (typeof undo !== 'function') throw new AuthzConfigError('onRollback needs a function');
    this.undo.push(undo);
  }
}

/** The MemoryTx of a memory backend's transaction; a memory store under any other backend must fail loudly. */
export function memoryTx(tx: AuthzTx): MemoryTx {
  const driver = (tx as AuthzTx | undefined)?.driver;
  if (!(driver instanceof MemoryTxDriver)) throw new AuthzConfigError('a memory store needs a transaction of MemoryAuthzAdminBackend (authz.admin.backend)');
  return driver;
}

interface Remembered {
  readonly results: readonly AuthzCommandResult[];
  readonly expiresAt: number;
}

const copy = <T>(v: T): T => structuredClone(v);

/** Transactions run one at a time; a rollback undoes the writes in reverse order. */
@Singleton()
@Injectable(AuthzAdminBackend)
export class MemoryAuthzAdminBackend extends AuthzAdminBackend {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly versions = new Map<string, number>();
  private readonly remembered = new Map<string, Remembered>();
  private readonly log = engineLog('authz-admin');

  transaction<T>(_domain: string, fn: (tx: AuthzTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.run(fn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async bumpVersion(domain: string, tx: AuthzTx): Promise<void> {
    const undo = memoryTx(tx);
    const had = this.versions.has(domain);
    const before = this.versions.get(domain) ?? 0;
    this.versions.set(domain, before + 1);
    undo.onRollback(() => (had ? this.versions.set(domain, before) : this.versions.delete(domain)));
  }

  /** The domain's version: the number of committed batches. */
  version(domain: string): number {
    return this.versions.get(domain) ?? 0;
  }

  async recall(domain: string, actorKey: string, key: string, now: Date): Promise<readonly AuthzCommandResult[] | undefined> {
    const id = entryKey(domain, actorKey, key);
    const entry = this.remembered.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= now.getTime()) {
      this.remembered.delete(id);
      return undefined;
    }
    return copy(entry.results);
  }

  async remember(domain: string, actorKey: string, key: string, results: readonly AuthzCommandResult[], expiresAt: Date, tx: AuthzTx): Promise<'stored' | 'exists'> {
    const undo = memoryTx(tx);
    const id = entryKey(domain, actorKey, key);
    // remember() has no clock: recall() drops an entry once it expires, and AuthzAdmin recalls before it remembers.
    if (this.remembered.has(id)) return 'exists';
    this.remembered.set(id, { results: copy(results), expiresAt: expiresAt.getTime() });
    undo.onRollback(() => this.remembered.delete(id));
    return 'stored';
  }

  private async run<T>(fn: (tx: AuthzTx) => Promise<T>): Promise<T> {
    const driver = new MemoryTxDriver();
    try {
      const out = await fn(Object.freeze({ driver }));
      driver.open = false;
      return out;
    } catch (e) {
      driver.open = false;
      for (const undo of driver.undo.reverse()) {
        try {
          undo();
        } catch (err) {
          this.log.error(`authz admin: an undo of a rolled back memory transaction failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw e;
    }
  }
}

const entryKey = (domain: string, actorKey: string, key: string): string => JSON.stringify([domain, actorKey, key]);
