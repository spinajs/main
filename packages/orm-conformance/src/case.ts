import type { Orm, OrmDriver } from '@spinajs/orm';

import type { FixtureSeed } from './fixture.js';

export type TargetName = 'sqlite' | 'pglite' | 'postgres' | 'mysql' | 'mssql';
export type CaseOrder = 'ordered' | 'unordered';

export interface ConformanceDb {
  readonly target: TargetName;
  readonly orm: Orm;
  readonly driver: OrmDriver;
}

export interface ConformanceCase {
  /** kebab-case, unique in the corpus; divergences.json refers to it. */
  readonly name: string;
  /** Rows inserted into a freshly created fixture before `run`. */
  readonly seed: FixtureSeed;
  /** `unordered`: the rows of the result are sorted before comparison. */
  readonly order: CaseOrder;
  /** Keys whose 0/1 values are booleans: sqlite, mysql and mssql return a raw boolean column as a number. */
  readonly booleans?: readonly string[];
  /** Returns plain data ( or models' fields mapped to plain data ); a throw is recorded as `{ $error: <class name> }`. */
  run(db: ConformanceDb): Promise<unknown>;
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function defineCase(definition: ConformanceCase): ConformanceCase {
  if (!KEBAB.test(definition.name)) {
    throw new Error(`conformance case name ${definition.name} must be kebab-case`);
  }

  return definition;
}
