import { Container, Inject, NewInstance } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { QueryContext, DropEventQueryCompiler, EventQueryCompiler } from '../../interfaces.js';
import type { ICompilerOutput } from '../../interfaces.js';
import type { OrmDriver } from '../../driver.js';
import type { DateTime } from 'luxon';
import type { SchemaTouch } from '../../schema-touches.js';
import { assertOneOf } from '../internal.js';
import type { RawQuery } from '../raw.js';
import { QueryBuilder } from '../base.js';

export type EventIntervalUnit = 'YEAR' | 'QUARTER' | 'MONTH' | 'WEEK' | 'DAY' | 'HOUR' | 'MINUTE' | 'SECOND';

const EVENT_INTERVAL_UNITS: readonly string[] = ['YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND'];

export interface IEventInterval {
  Value: number;
  Unit: EventIntervalUnit;
}

function eventInterval(value: number, unit: EventIntervalUnit): IEventInterval {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidArgument(`event interval must be a positive integer, got ${value}`);
  }

  return { Value: value, Unit: assertOneOf(unit, EVENT_INTERVAL_UNITS, 'event interval unit') };
}

/**
 * A job scheduled inside the database engine. Engines without native events throw
 * MethodNotImplemented at compile time - check `supportedFeatures().events` first.
 */
@NewInstance()
@Inject(Container)
export class EventQueryBuilder extends QueryBuilder {
  public Every?: IEventInterval;
  public FromNow?: IEventInterval;
  public At?: DateTime;
  public Starts?: DateTime;
  public Ends?: DateTime;
  public Preserve = false;
  public Enabled = true;
  public IfNotExists = false;
  public Comment?: string;
  public Actions: (RawQuery | QueryBuilder)[] = [];

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver);

    this.setTable(name);
    this.QueryContext = QueryContext.Schema;
  }

  /** Repeat with the given interval */
  public every(value: number, unit: EventIntervalUnit) {
    this.assertNoSchedule();
    this.Every = eventInterval(value, unit);
    return this;
  }

  /** Run once at a point in time */
  public at(dateTime: DateTime) {
    this.assertNoSchedule();
    this.At = dateTime;
    return this;
  }

  /** Run once, the given interval from now */
  public fromNow(value: number, unit: EventIntervalUnit) {
    this.assertNoSchedule();
    this.FromNow = eventInterval(value, unit);
    return this;
  }

  public starts(dateTime: DateTime) {
    this.Starts = dateTime;
    return this;
  }

  public ends(dateTime: DateTime) {
    this.Ends = dateTime;
    return this;
  }

  /** Keep the event after its last run ( ON COMPLETION PRESERVE ) */
  public preserve() {
    this.Preserve = true;
    return this;
  }

  public disabled() {
    this.Enabled = false;
    return this;
  }

  public ifNotExists() {
    this.IfNotExists = true;
    return this;
  }

  public comment(comment: string) {
    this.Comment = comment;
    return this;
  }

  /**
   * One action is emitted as given - a statement, or raw SQL carrying its own BEGIN ... END.
   * Several actions are wrapped in BEGIN ... END.
   */
  public do(sql: RawQuery | QueryBuilder | (RawQuery | QueryBuilder)[]) {
    this.Actions = Array.isArray(sql) ? sql : [sql];
    return this;
  }

  protected schemaTouches(): SchemaTouch {
    return [];
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<EventQueryCompiler>(EventQueryCompiler, [this]).compile();
  }

  private assertNoSchedule() {
    if (this.Every || this.At || this.FromNow) {
      throw new InvalidOperation(`event ${this.Table} already has a schedule, every(), at() and fromNow() are mutually exclusive`);
    }
  }
}

@NewInstance()
@Inject(Container)
export class DropEventQueryBuilder extends QueryBuilder {
  public Exists = false;

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver);

    this.setTable(name);
    this.QueryContext = QueryContext.Schema;
  }

  public ifExists() {
    this.Exists = true;
    return this;
  }

  protected schemaTouches(): SchemaTouch {
    return [];
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<DropEventQueryCompiler>(DropEventQueryCompiler, [this]).compile();
  }
}
