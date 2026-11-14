import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationTransactionMode, QueryContext, type OrmDriver } from '@spinajs/orm';
import { currentContext, type SimContext } from './context.js';
import { SimCrash } from './crash.js';
import type { SimReplicas } from './replicas.js';

export const SIM_CONNECTION = 'sim';

type Statement = (stmt: string, params: unknown[], context: QueryContext) => Promise<unknown>;
type Transaction = (...args: unknown[]) => Promise<unknown>;
type SqlDriver = OrmDriver & { executeOnDb: Statement; runStatement: Statement };

const DEFAULT_KEPT_DATABASES = 20;

const templates = new Map<string, string>();
let keptDatabases = 0;

function rememberTemplate(key: string, path: string): void {
  if (templates.size === 0) process.once('exit', () => templates.forEach((file) => rmSync(file, { force: true })));
  templates.set(key, path);
}

/** A nightly run of thousands of failing seeds must not fill the disk: `SIM_KEEP_DBS` failing databases per process. */
function keepLimit(): number {
  const raw = process.env.SIM_KEEP_DBS;
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_KEPT_DATABASES;
}

/**
 * One sqlite file per seed behind ONE driver that every replica shares: two drivers on one file
 * each hold a writer handle and fail with SQLITE_BUSY inside transactions, which sqlite never retries.
 *
 * A template is the file as it stands right after the boot, so a suite's boot must not write rows:
 * the next seeds of the same template key would start with them.
 */
export class SimDatabase {
  protected path?: string;
  protected attached?: SqlDriver;
  protected inFlight = 0;
  protected fromTemplate = false;
  protected templateKey?: string;
  /** Callers whose COMMIT ran as ROLLBACK; their transaction() rejects instead of resolving as committed. */
  protected readonly rolledBack = new WeakSet<SimContext>();

  constructor(
    protected readonly seed: number,
    protected readonly replicas: SimReplicas,
  ) {}

  /** `os.tmpdir()/spinajs-sim-<seed>-<random>`, unique per boot so parallel processes never share a file. */
  public get dir(): string {
    if (!this.path) throw new Error('SimDatabase: boot the environment first');
    return this.path;
  }

  public get file(): string {
    return join(this.dir, 'sim.sqlite');
  }

  public get driver(): OrmDriver {
    if (!this.attached) throw new Error('SimDatabase: boot the environment first');
    return this.attached;
  }

  public get migratedFrom(): 'template' | 'migrations' {
    return this.fromTemplate ? 'template' : 'migrations';
  }

  /** True inside a transaction of the shared driver, where a pause would hold the only writer. */
  public inTransaction(): boolean {
    return this.attached?.CurrentTransaction !== undefined;
  }

  public prepare(template?: string, aliases: readonly string[] = []): void {
    this.path = mkdtempSync(join(tmpdir(), `spinajs-sim-${this.seed}-`));
    // the aliases decide which migrations ran, so they are part of the key
    this.templateKey = template === undefined ? undefined : `${template}|${[...aliases].sort().join(',')}`;
    const source = this.templateKey === undefined ? undefined : templates.get(this.templateKey);
    this.fromTemplate = source !== undefined && existsSync(source);
    if (source !== undefined && this.fromTemplate) copyFileSync(source, this.file);
  }

  public config(aliases: readonly string[]): Record<string, unknown> {
    return {
      DefaultConnection: SIM_CONNECTION,
      Aliases: Object.fromEntries(aliases.map((alias) => [alias, SIM_CONNECTION])),
      Connections: [
        {
          Driver: 'orm-driver-sqlite',
          Filename: this.file,
          Name: SIM_CONNECTION,
          Pool: { Max: 1 },
          Migration: { OnStartup: !this.fromTemplate, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
        },
      ],
    };
  }

  public attach(driver: OrmDriver): void {
    const d = driver as SqlDriver;
    // node-sqlite3 runs a handle's statements in parallel mode unless told otherwise; serialized,
    // they run in the order they were issued, which a replayed seed depends on
    (d as unknown as { Db?: { serialize(): void } }).Db?.serialize();
    this.guardStatements(d);
    this.guardTransactions(d);
    this.attached = d;
  }

  public async saveTemplate(): Promise<void> {
    const key = this.templateKey;
    if (key === undefined || this.fromTemplate || templates.has(key)) return;
    const path = join(tmpdir(), `spinajs-sim-template-${process.pid}-${templates.size}.sqlite`);
    rmSync(path, { force: true });
    await this.execute(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    rememberTemplate(key, path);
  }

  /** A raw statement, for test-side sabotage and probes. */
  public execute(sql: string, params: unknown[] = []): Promise<unknown> {
    return (this.driver as SqlDriver).executeOnDb(sql, params, QueryContext.Schema);
  }

  /** Waits until no transaction, executeOnDb call or statement is in flight for three macrotask turns. */
  public async idle(deadlineMs = 10_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    for (let quiet = 0; quiet < 3; ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      quiet = this.inFlight === 0 ? quiet + 1 : 0;
      if (Date.now() > deadline) throw new Error(`SimDatabase: ${this.inFlight} statement(s) still running after ${deadlineMs} ms`);
    }
  }

  /** Deletes the file, or keeps it (up to `SIM_KEEP_DBS` per process) and returns its path. */
  public close(keep: boolean): string | undefined {
    this.attached = undefined;
    if (!this.path) return undefined;
    if (keep && keptDatabases < keepLimit()) {
      keptDatabases++;
      return this.file;
    }
    rmSync(this.path, { recursive: true, force: true });
    return undefined;
  }

  protected guardStatements(d: SqlDriver): void {
    const executeOnDb = d.executeOnDb.bind(d);
    const runStatement = d.runStatement.bind(d);
    d.executeOnDb = (stmt, params, context) => {
      const dead = this.deadCaller();
      if (dead && !/^\s*ROLLBACK/i.test(stmt)) return Promise.reject(new SimCrash('database', dead.replica));
      return this.track(() => executeOnDb(stmt, params, context));
    };
    d.runStatement = (stmt, params, context) => {
      const dead = this.deadCaller();
      if (!dead || !/^\s*COMMIT/i.test(stmt)) return this.track(() => runStatement(stmt, params, context));
      // a crashed process never commits; ROLLBACK also frees the shared writer for the other replicas
      this.rolledBack.add(dead);
      return this.track(() => runStatement('ROLLBACK', params, context));
    };
  }

  protected guardTransactions(d: SqlDriver): void {
    const transaction = d.transaction.bind(d) as Transaction;
    const afterCommit = d.afterCommit.bind(d);
    (d as unknown as { transaction: Transaction }).transaction = async (...args) => {
      const ctx = currentContext();
      // a dead incarnation must not BEGIN: its transaction would hold the only writer
      if (ctx && this.replicas.isDead(ctx)) throw new SimCrash('transaction', ctx.replica);
      const outermost = d.CurrentTransaction === undefined;
      try {
        const result = await this.track(() => transaction(...args));
        if (ctx && this.rolledBack.delete(ctx)) throw new SimCrash('commit', ctx.replica);
        return result;
      } finally {
        // a pause asked for inside the transaction (SimReplicas.deferPark) runs once the writer is free again
        if (outermost && ctx) {
          const ms = this.replicas.takeDeferredPark(ctx);
          if (ms !== undefined) await this.replicas.park(ctx, ms);
        }
      }
    };
    d.afterCommit = (cb) => {
      const ctx = currentContext();
      return afterCommit(ctx ? () => (this.replicas.isDead(ctx) ? undefined : cb()) : cb);
    };
  }

  protected deadCaller(): SimContext | undefined {
    const ctx = currentContext();
    return ctx !== undefined && this.replicas.isDead(ctx) ? ctx : undefined;
  }

  protected track<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight++;
    let running: Promise<T>;
    try {
      running = work();
    } catch (err) {
      this.inFlight--;
      throw err;
    }
    return running.finally(() => this.inFlight--);
  }
}
