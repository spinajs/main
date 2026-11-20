import type { Constructor } from '@spinajs/di';

import type { QueryBuilder } from '../builders.js';
import type { OrmDriver } from '../driver.js';
import type { ModelBase } from '../model.js';

export type CaptureKind = 'insert' | 'update' | 'delete';
export type CapturedRow = Readonly<Record<string, unknown>>;

export interface CaptureInterest {
  /** `'*'` reads the whole row. The primary key is always read. */
  readonly columns: readonly string[] | '*';
  /** Asks for one transaction around the statement and every observer. */
  readonly transactional: boolean;
}

export interface RowChange {
  readonly id: string;
  /** Undefined: the row did not exist before the statement. */
  readonly before: CapturedRow | undefined;
  /** Undefined: the row is gone after the statement. */
  readonly after: CapturedRow | undefined;
}

export interface CapturedWrite {
  readonly kind: CaptureKind;
  readonly query: QueryBuilder;
  readonly model: Constructor<ModelBase>;
  readonly driver: OrmDriver;
  /** Every row the statement reached, projected to the observer's columns, unchanged rows included. */
  readonly rows: readonly RowChange[];
  /** An insert whose keys the driver did not report; `rows` is then empty. */
  readonly unknownKeys: boolean;
}

export abstract class WriteObserver {
  /** Synchronous; undefined when the statement does not concern this observer. */
  abstract interest(query: QueryBuilder): CaptureInterest | undefined;
  /** Before any capture read, inside the transaction; throwing aborts the statement. */
  prepare?(query: QueryBuilder): void | Promise<void>;
  abstract observe(write: CapturedWrite): Promise<void>;
}

/** Runs the key select of an update or delete; authz-orm registers one that runs it as SYSTEM. */
export abstract class CaptureReadScope {
  abstract run<T>(fn: () => Promise<T>): Promise<T>;
}
