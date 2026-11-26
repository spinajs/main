import { audit } from '@spinajs/audit';
import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { Logger } from '@spinajs/log-common';
import type { Log } from '@spinajs/log-common';
import { ModelBase, Orm, OrmMigrationGuard, extractModelDescriptor } from '@spinajs/orm';
import type { ModelBaseClass, OrmDriver } from '@spinajs/orm';

import { coverageColumns, restarts, sameColumns } from './coverage-columns.js';
import { deleteCoverage, holdsCoverageTable, insertCoverage, readCoverage, restartCoverage, writeCoverageColumns } from './coverage-table.js';
import type { CoverageKey } from './coverage-table.js';
import { LOST_SUBJECT_ID } from './encode.js';
import { HistoryConfigError } from './errors.js';
import { HistorySpecs, optedOut } from './registry.js';
import type { HistorySpec } from './registry.js';

/** From when on a trail holds every change of the columns an entity's registration records: what tells "no change" from "not recorded". */
export abstract class HistoryCoverage {
  /**
   * From when every observed write of `entity` on `connection` (a configured name, an alias or `default`) is in
   * `trail`, for the columns its registration records; undefined when it was never covered. A column the registration
   * excludes, masks or does not track (column mode) is never covered: an update of only such columns leaves no entry.
   * Rejects with `HistoryConfigError` for an unknown connection, `AuditConfigError` for an unknown trail.
   */
  abstract since(trail: string, connection: string, entity: string): Promise<Date | undefined>;

  /**
   * Records that this process tracks the tables of `models` (default: every model the ORM loaded) from now on. An
   * entity recorded before keeps its instant, unless its events now hold a column they left out before. A table that
   * cannot be recorded is logged and has no coverage; the call rejects only when no ORM is booted.
   */
  abstract record(models?: readonly ModelBaseClass[]): Promise<void>;
}

interface Table {
  readonly driver: OrmDriver;
  readonly name: string;
  readonly columns: readonly string[];
  readonly models: ModelBaseClass[];
}

interface Stream {
  readonly trail: string;
  readonly entity: string;
  readonly specs: readonly HistorySpec[];
}

const isModel = (c: unknown): c is ModelBaseClass => typeof c === 'function' && c.prototype instanceof ModelBase;

// By driver: `default` and an alias name the connection of another entry.
function tablesOf(orm: Orm): Table[] {
  const tables: Table[] = [];
  for (const { type } of orm.Models) {
    if (!isModel(type)) continue;
    const d = extractModelDescriptor(type);
    const driver = d?.Driver;
    if (!d || !driver) continue;
    const table = tables.find((t) => t.driver === driver && t.name === d.TableName);
    if (table) table.models.push(type);
    else tables.push({ driver, name: d.TableName, columns: d.Columns.map((c) => c.Name), models: [type] });
  }
  return tables;
}

/** Every model of a table must record into one stream, or a write through the others is missing from it. */
function streamOf(specs: readonly (HistorySpec | undefined)[]): Stream | undefined {
  const tracked = specs.filter((s): s is HistorySpec => s !== undefined);
  const [first] = tracked;
  if (first === undefined || tracked.length !== specs.length) return undefined;
  return tracked.every((s) => s.trail === first.trail && s.entity === first.entity) ? { trail: first.trail, entity: first.entity, specs: tracked } : undefined;
}

/** The entities whose earlier claim ends: those of a table tracked only in part, and the table name of an opt-out. */
function endedBy(table: Table, specs: readonly (HistorySpec | undefined)[]): string[] {
  const tracked = specs.flatMap((s) => (s === undefined ? [] : [s.entity]));
  return [...new Set([...tracked, ...(table.models.some(optedOut) ? [table.name] : [])])];
}

@Singleton()
@Injectable(HistoryCoverage)
export class TableHistoryCoverage extends HistoryCoverage {
  @Autoinject(HistorySpecs)
  protected Specs: HistorySpecs;

  @Logger('orm-history')
  protected Log: Log;

  // One pass at a time, and `since` waits for the pass in flight: a read right after boot sees the rows of that boot.
  private pending: Promise<void> = Promise.resolve();
  private readonly warned = new Set<string>();

  public async since(trail: string, connection: string, entity: string): Promise<Date | undefined> {
    await this.pending;
    const driver = DI.get(Orm)?.Connections.get(connection);
    if (!driver) throw new HistoryConfigError(`orm-history: no ORM connection ${JSON.stringify(connection)} to read the coverage of ${entity} from`);
    const key: CoverageKey = { trail, connection: driver.Options.Name, entity };
    const events = audit().trail(trail);
    if (!(await holdsCoverageTable(driver))) return undefined;
    const start = await readCoverage(driver, key);
    if (start === undefined) return undefined;
    // By `at`, not by `seq`: a transaction that commits late inserts a marker stamped before one inserted earlier.
    const lost = await events.of({ type: entity, id: LOST_SUBJECT_ID }, { source: key.connection, kinds: ['data'], actions: ['lost'], from: start.since, order: 'desc', limit: 1000 });
    // Read again after the markers: a retention run in between moves the row past the markers it deletes.
    const row = await readCoverage(driver, key);
    if (row === undefined) return undefined;
    return new Date(Math.max(row.since.getTime(), ...lost.map((e) => e.at.getTime())));
  }

  public record(models?: readonly ModelBaseClass[], now: Date = new Date(), orm?: Orm): Promise<void> {
    const pass = this.pending.then(() => this.recordNow(models, now, orm ?? DI.get(Orm)));
    this.pending = pass.catch(() => undefined);
    return pass;
  }

  /** What an application's boot runs. A migration tool's Orm serves no writes and boots before the table exists. */
  public boot(orm: Orm): void {
    if (orm.Container.get(OrmMigrationGuard)?.Enabled === false) return;
    this.record(undefined, new Date(), orm).catch((error: unknown) => this.Log.warn({ error }, 'orm-history: the coverage of the tracked models could not be recorded at boot'));
  }

  private async recordNow(models: readonly ModelBaseClass[] | undefined, now: Date, orm: Orm | null): Promise<void> {
    if (!orm) throw new HistoryConfigError('orm-history: coverage is recorded once the ORM is booted');
    const held = new Map<OrmDriver, boolean>();
    for (const table of tablesOf(orm)) {
      if (models !== undefined && !table.models.some((m) => models.includes(m))) continue;
      await this.recordTable(table, now, held).catch((error: unknown) => this.failed(table, error));
    }
  }

  private async recordTable(table: Table, now: Date, held: Map<OrmDriver, boolean>): Promise<void> {
    const specs = table.models.map((m) => this.Specs.of(m));
    const stream = streamOf(specs);
    const ended = stream === undefined ? endedBy(table, specs) : [];
    // A table with no tracked model and no opt-out costs no statement.
    if (stream === undefined && ended.length === 0) return;
    if (!(await this.holds(table.driver, held))) return;
    if (stream !== undefined) return this.cover(table, stream, now);
    const connection = table.driver.Options.Name;
    await deleteCoverage(table.driver, connection, ended);
    if (specs.some((s) => s !== undefined)) {
      this.warnOnce(`half:${connection}:${table.name}`, { table: table.name, connection }, 'orm-history: table ${table} on ${connection} is written by models that are not all tracked in one trail under one entity, so its history has no coverage; track every model of the table the same way');
    }
  }

  private async cover(table: Table, stream: Stream, now: Date): Promise<void> {
    const key: CoverageKey = { trail: stream.trail, connection: table.driver.Options.Name, entity: stream.entity };    const next = coverageColumns(stream.specs, table.columns);
    const row = await readCoverage(table.driver, key);
    if (row === undefined) await insertCoverage(table.driver, key, next, now);
    else if (restarts(row.columns, next)) await restartCoverage(table.driver, key, next, now);
    else if (row.columns !== undefined && !sameColumns(row.columns, next)) await writeCoverageColumns(table.driver, key, next);
  }

  private async holds(driver: OrmDriver, held: Map<OrmDriver, boolean>): Promise<boolean> {
    const known = held.get(driver) ?? (await holdsCoverageTable(driver));
    held.set(driver, known);
    const connection = driver.Options.Name;
    if (!known) this.warnOnce(`table:${connection}`, { connection }, 'orm-history: ${connection} has no history_coverage table, so the history of its tracked models has no coverage; run the migration OrmHistoryCoverage_2026_11_25_00_00_00 there');
    return known;
  }

  private failed(table: Table, error: unknown): void {
    const connection = table.driver.Options.Name;
    const reason = error instanceof Error ? error.message : String(error);
    this.warnOnce(`failed:${connection}:${table.name}`, { table: table.name, connection, reason }, 'orm-history: the coverage of table ${table} on ${connection} could not be recorded: ${reason}');
  }

  private warnOnce(key: string, fields: Record<string, unknown>, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.Log.warn(fields, message);
  }
}

// Orm.resolve() has no hook of its own; the container tells when it has finished. Not awaited by the boot: `since`
// waits for the pass.
DI.on('di.resolved.Orm', (_container: unknown, orm: unknown) => {
  // The container emits inside the resolution of the Orm: a throw here would reject that resolution.
  try {
    const coverage = DI.resolve(HistoryCoverage);
    if (orm instanceof Orm && coverage instanceof TableHistoryCoverage) coverage.boot(orm);
  } catch (error) {
    process.emitWarning(`orm-history: the coverage of the tracked models could not be recorded at boot: ${error instanceof Error ? error.message : String(error)}`);
  }
});
