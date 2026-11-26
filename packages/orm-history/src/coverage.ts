import { audit } from '@spinajs/audit';
import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { Logger } from '@spinajs/log-common';
import type { Log } from '@spinajs/log-common';
import { ModelBase, Orm, extractModelDescriptor } from '@spinajs/orm';
import type { ModelBaseClass, OrmDriver } from '@spinajs/orm';

import { coverageColumns, restarts, sameColumns } from './coverage-columns.js';
import { deleteCoverage, holdsCoverageTable, insertCoverage, readCoverage, restartCoverage, writeCoverageColumns } from './coverage-table.js';
import type { CoverageKey } from './coverage-table.js';
import { LOST_SUBJECT_ID } from './encode.js';
import { HistoryConfigError } from './errors.js';
import { HistorySpecs, optedOut } from './registry.js';
import type { HistorySpec } from './registry.js';

/** From when on a trail holds every change of an entity: what tells "no change" from "not recorded". */
export abstract class HistoryCoverage {
  /**
   * From when every write of `entity` on `connection` (a configured name, an alias or `default`) is in `trail`;
   * undefined when it was never covered. Read it after the history it qualifies: a retention run in between only
   * moves it forward.
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
    const source = driver.Options.Name;
    // The marker before the row: a retention run between the two reads moves the row past the markers it deletes.
    const [lost] = await audit()
      .trail(trail)
      .of({ type: entity, id: LOST_SUBJECT_ID }, { source, kinds: ['data'], actions: ['lost'], order: 'desc', limit: 1 });
    if (!(await holdsCoverageTable(driver))) return undefined;
    const row = await readCoverage(driver, { trail, connection: source, entity });
    if (row === undefined) return undefined;
    return lost !== undefined && lost.at.getTime() > row.since.getTime() ? lost.at : row.since;
  }

  public record(models?: readonly ModelBaseClass[], now: Date = new Date()): Promise<void> {
    const pass = this.pending.then(() => this.recordNow(models, now));
    this.pending = pass.catch(() => undefined);
    return pass;
  }

  private async recordNow(models: readonly ModelBaseClass[] | undefined, now: Date): Promise<void> {
    const orm = DI.get(Orm);
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
    const key: CoverageKey = { trail: stream.trail, connection: table.driver.Options.Name, entity: stream.entity };
    const next = coverageColumns(stream.specs, table.columns);
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
