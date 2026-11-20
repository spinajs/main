import type { OrmDriver } from '../driver.js';

export interface ExecutedStatement {
  sql: string;
  bindings: unknown[];
  durationMs: number;
  /** The driver that ran the statement; a model select may have run on a read replica. */
  driver: OrmDriver;
  traceId?: string;
  spanId?: string;
  /** The compile emitted caller-written SQL (a `RawQuery`, a `sql` fragment); see `trackRawSql`. */
  rawSql: boolean;
}

/**
 * Query middlewares see the builder but not what the driver compiled from it, and compiling a second time
 * registers relation middlewares again. The driver writes each statement here while a reader asked for them.
 */
const EXECUTED = new WeakMap<object, ExecutedStatement[]>();

let recording = false;

/** Off until `SlowQueryMiddleware` finds `db.Explain.Enabled`, so a statement costs one boolean check and keeps no bindings. */
export function setStatementRecording(on: boolean): void {
  recording = on;
}

export function statementRecording(): boolean {
  return recording;
}

export function recordStatement(builder: object, statement: ExecutedStatement): void {
  if (!recording) {
    return;
  }

  const list = EXECUTED.get(builder);
  if (list) {
    list.push(statement);
  } else {
    EXECUTED.set(builder, [statement]);
  }
}

export function executedStatements(builder: object): readonly ExecutedStatement[] {
  return EXECUTED.get(builder) ?? [];
}

/** A chunked insert executes copies of its builder; their statements belong to the builder the caller holds. */
export function adoptStatements(owner: object, copy: object): void {
  const moved = EXECUTED.get(copy);
  if (!moved) {
    return;
  }

  EXECUTED.delete(copy);
  const list = EXECUTED.get(owner);
  if (list) {
    list.push(...moved);
  } else {
    EXECUTED.set(owner, moved);
  }
}
