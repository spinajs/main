import { Exception, ResourceDuplicated } from '@spinajs/exceptions';
import { IDriverOptions } from './interfaces.js';

/**
 * Exception thrown when functionality is not supported
 */
export class OrmException extends Exception {
  constructor(message?: string, public driver?: Partial<IDriverOptions>, public query?: string, public bindings? : any, public inner?: Error | unknown) {
    super(message, inner);

    // Keep connection details and SQL out of serialized error bodies (e.g. the http error handler spreads own enumerable props).
    for (const key of ['driver', 'query', 'bindings', 'inner'] as const) {
      Object.defineProperty(this, key, { value: this[key], enumerable: false, writable: true, configurable: true });
    }

    if (this.driver) {
      this.message = `Error during execution statement on connection ${this.driver.Name} at ${this.driver.User}@${this.driver.Host}, inner exception: ${this.inner ?? 'none'}, message: ${message}`;
    }
  }

  public toString() {}
}

/**
 * Exception thrown when functionality is not supported
 */
export class OrmNotFoundException extends OrmException {}

/**
 * Exception thrown when insert / update / delete affected no rows
 * eg. delete of an already deleted model
 */
export class NoRowsAffected extends OrmException {
  constructor(message = 'No rows affected by the query') {
    super(message);
  }
}

/** What a driver could tell about the constraint a statement broke. */
export interface IConstraintViolationInfo {
  table?: string;
  constraint?: string;
  columns?: string[];
}

export type ConstraintKind = 'not_null' | 'check' | 'foreign_key' | 'other';

/**
 * A statement broke a primary key or unique constraint. Thrown by every driver; the native
 * error is `inner` and its message is this one.
 */
export class UniqueViolation extends ResourceDuplicated {
  public table?: string;
  public constraint?: string;
  public columns?: string[];

  constructor(message: string, info: IConstraintViolationInfo = {}, inner?: unknown) {
    super(message, inner);

    this.table = info.table;
    this.constraint = info.constraint;
    this.columns = info.columns;
  }
}

/** A statement broke a NOT NULL, CHECK or FOREIGN KEY constraint. */
export class ConstraintViolation extends OrmException {
  public table?: string;
  public constraint?: string;
  public columns?: string[];

  constructor(message: string, public kind: ConstraintKind, info: IConstraintViolationInfo = {}, driver?: Partial<IDriverOptions>, query?: string, bindings?: unknown, inner?: unknown) {
    super(message, driver, query, bindings, inner);

    this.table = info.table;
    this.constraint = info.constraint;
    this.columns = info.columns;
  }
}

/** A model or connection was used before an Orm created its connections. */
export class OrmNotResolved extends OrmException {}

export class OrmConnectionMissing extends OrmException {
  constructor(message: string, public readonly connection: string) {
    super(message);
  }
}

export class NotAnOrmDriver extends OrmException {}

export class TransactionRequired extends OrmException {}

export class ConnectionMismatch extends OrmException {
  /**
   * @param expected - the connection `table` is on
   * @param actual - the connection of the driver that was given
   */
  constructor(message: string, public readonly table: string, public readonly expected: string, public readonly actual: string) {
    super(message);
  }
}
