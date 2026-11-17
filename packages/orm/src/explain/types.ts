export interface PlanNode {
  label: string;
  detail?: string;
  estimatedRows?: number;
  estimatedCost?: number;
  children: PlanNode[];
}

export interface QueryPlan {
  dialect: 'sqlite' | 'postgres' | 'mysql';
  root: PlanNode;
  /** The driver's EXPLAIN output (rows or parsed JSON); `null` once the plan was redacted. */
  raw: unknown;
}

export interface SlowQueryRecord {
  fingerprint: string;
  /** Sanitized: literal values are `?`. */
  sql: string;
  /** Only with `db.Explain.CaptureBindings`. */
  bindings?: unknown[];
  driver: string;
  connection: string;
  durationMs: number;
  at: Date;
  traceId?: string;
  spanId?: string;
  plan?: QueryPlan;
  planError?: string;
}

/** `db.Explain` */
export interface ExplainOptions {
  Enabled: boolean;
  SlowQueryMs: number;
  MaxPerMinute: number;
  CaptureBindings: boolean;
}

/** Every registered sink receives every slow-query record. */
export abstract class SlowQuerySink {
  public abstract record(entry: SlowQueryRecord): void | Promise<void>;
}
