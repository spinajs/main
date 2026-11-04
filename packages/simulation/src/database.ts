import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigrationTransactionMode, QueryContext, type OrmDriver } from '@spinajs/orm';
import { currentContext } from './context.js';
import { SimCrash } from './crash.js';
import type { SimReplicas } from './replicas.js';

export const SIM_CONNECTION = 'sim';

type Statement = (stmt: string, params: unknown[], context: QueryContext) => Promise<unknown>;
type SqlDriver = OrmDriver & { executeOnDb: Statement; runStatement: Statement };

const templates = new Map<string, string>();

/**
 * One sqlite file per seed behind ONE driver that every replica shares: two drivers on one file
 * each hold a writer handle and fail with SQLITE_BUSY inside transactions, which sqlite never retries.
 */
export class SimDatabase {
  public readonly dir: string;
  public readonly file: string;
  protected attached?: SqlDriver;
  protected inFlight = 0;
  protected fromTemplate = false;

  constructor(
    seed: number,
    protected readonly replicas: SimReplicas,
  ) {
    this.dir = join(tmpdir(), `spinajs-sim-${seed}`);
    this.file = join(this.dir, 'sim.sqlite');
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

  public prepare(template?: string): void {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    const source = template === undefined ? undefined : templates.get(template);
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
    const executeOnDb = d.executeOnDb.bind(d);
    const runStatement = d.runStatement.bind(d);
    const transaction = d.transaction.bind(d) as (...args: unknown[]) => Promise<unknown>;
    d.executeOnDb = (stmt, params, context) => {
      const ctx = currentContext();
      if (ctx && this.replicas.isDead(ctx) && !/^\s*ROLLBACK/i.test(stmt)) return Promise.reject(new SimCrash('database', ctx.replica));
      return this.track(() => executeOnDb(stmt, params, context));
    };
    d.runStatement = (stmt, params, context) => {
      // a crashed process never commits; ROLLBACK also frees the shared writer for the other replicas
      const statement = this.deadCaller() && /^\s*COMMIT/i.test(stmt) ? 'ROLLBACK' : stmt;
      return this.track(() => runStatement(statement, params, context));
    };
    (d as unknown as { transaction: (...args: unknown[]) => Promise<unknown> }).transaction = async (...args) => {
      const ctx = currentContext();
      const outermost = d.CurrentTransaction === undefined;
      try {
        return await this.track(() => transaction(...args));
      } finally {
        // a pause asked for inside the transaction (SimReplicas.deferPark) runs once the writer is free again
        if (outermost && ctx) {
          const ms = this.replicas.takeDeferredPark(ctx);
          if (ms !== undefined) await this.replicas.park(ctx, ms);
        }
      }
    };
    this.attached = d;
  }

  public async saveTemplate(template?: string): Promise<void> {
    if (template === undefined || this.fromTemplate || templates.has(template)) return;
    const path = join(tmpdir(), `spinajs-sim-template-${template}-${process.pid}.sqlite`);
    rmSync(path, { force: true });
    await this.execute(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    templates.set(template, path);
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

  public close(keep: boolean): string | undefined {
    this.attached = undefined;
    if (keep) return this.file;
    rmSync(this.dir, { recursive: true, force: true });
    return undefined;
  }

  protected deadCaller(): boolean {
    const ctx = currentContext();
    return ctx !== undefined && this.replicas.isDead(ctx);
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
