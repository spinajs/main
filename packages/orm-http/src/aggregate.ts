import { IContainer } from '@spinajs/di';
import { ColumnMethodStatement, ColumnMethods, IModelDescriptor, IQueryStatement, SelectQueryBuilder, extractModelDescriptor } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import { AggregateFunction, IAggregateColumns, IAggregateMeasure, IAggregateRequest } from './interfaces.js';

export const MAX_AGGREGATE_ROWS = 1000;
export const MAX_MEASURES = 16;
export const MAX_GROUP_COLUMNS = 8;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const FUNCTIONS: AggregateFunction[] = ['sum', 'avg', 'min', 'max', 'count'];
const METHODS: Record<AggregateFunction, ColumnMethods> = {
  sum: ColumnMethods.SUM,
  avg: ColumnMethods.AVG,
  min: ColumnMethods.MIN,
  max: ColumnMethods.MAX,
  count: ColumnMethods.COUNT,
};

const refuse = (field: string, message: string): never => {
  throw new InvalidArgument(message, field);
};

/** What `model` lets a request group and measure; empty for a builder without a model. */
export function aggregateColumnsOf(model: IModelDescriptor | null | undefined): IAggregateColumns {
  return {
    groupable: [...(model?.GroupableColumns ?? [])],
    aggregatable: Object.fromEntries(model?.AggregatableColumns ?? []),
  };
}

/** JSON schema of an aggregate request over the given allow-list. */
export function aggregateSchemaFor(columns: IAggregateColumns) {
  const measured = Object.entries(columns.aggregatable).map(([column, functions]) => ({
    type: 'object',
    additionalProperties: false,
    required: ['name', 'fn', 'column'],
    properties: {
      name: { type: 'string', pattern: NAME.source },
      fn: { type: 'string', enum: functions },
      column: { const: column },
    },
  }));
  const counted = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'fn'],
    properties: {
      name: { type: 'string', pattern: NAME.source },
      fn: { const: 'count' },
      column: { type: 'string', enum: [...new Set([...columns.groupable, ...Object.keys(columns.aggregatable)])] },
    },
  };
  // An enum may not be empty: a model with no groupable column gets a `groupBy` no value satisfies.
  const groupColumn = columns.groupable.length > 0 ? { type: 'string', enum: columns.groupable } : { not: {} };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['measures'],
    properties: {
      groupBy: { type: 'array', maxItems: MAX_GROUP_COLUMNS, uniqueItems: true, items: groupColumn },
      measures: { type: 'array', minItems: 1, maxItems: MAX_MEASURES, items: { anyOf: [...measured, counted] } },
      order: {
        type: 'array',
        maxItems: MAX_GROUP_COLUMNS + MAX_MEASURES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['column'],
          properties: { column: { type: 'string', maxLength: 128 }, order: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'] } },
        },
      },
      limit: { type: 'integer', minimum: 1 },
    },
  };
}

/** Adds each group column to `names`, the result keys seen so far. */
function checkGroupBy(groupBy: unknown, columns: IAggregateColumns, names: Set<string>): void {
  if (!Array.isArray(groupBy) || groupBy.length > MAX_GROUP_COLUMNS) {
    refuse('groupBy', `groupBy is a list of at most ${MAX_GROUP_COLUMNS} columns`);
  }

  for (const column of groupBy as unknown[]) {
    if (typeof column !== 'string' || !columns.groupable.includes(column)) {
      refuse('groupBy', `Cannot group by ${JSON.stringify(column)}. Groupable columns are: ${columns.groupable.join(', ')}`);
    }
    if (names.has(column as string)) {
      refuse('groupBy', `groupBy names ${column as string} twice`);
    }
    names.add(column as string);
  }
}

/** Adds the measure's name to `names`, the result keys seen so far. */
function checkMeasureName(measure: IAggregateMeasure | undefined, names: Set<string>): void {
  if (!measure || typeof measure.name !== 'string' || !NAME.test(measure.name)) {
    refuse('name', `A measure name is a letter or underscore followed by letters, digits or underscores, got ${JSON.stringify(measure?.name)}`);
  }
  const { name } = measure as IAggregateMeasure;
  if (names.has(name)) {
    refuse('name', `The name ${name} is used by two results`);
  }
  names.add(name);
}

function checkMeasure({ name, fn, column }: IAggregateMeasure, columns: IAggregateColumns): void {
  if (!FUNCTIONS.includes(fn)) {
    refuse('fn', `Unknown aggregate function ${JSON.stringify(fn)}. Functions are: ${FUNCTIONS.join(', ')}`);
  }
  if (column === undefined || column === null) {
    if (fn !== 'count') {
      refuse('column', `Measure ${name} needs a column; only count works without one`);
    }
    return;
  }

  const allowed = typeof column === 'string' && (columns.aggregatable[column] ?? []).includes(fn);
  const countable = fn === 'count' && typeof column === 'string' && (columns.groupable.includes(column) || column in columns.aggregatable);
  if (!allowed && !countable) {
    refuse('column', `Function ${fn} is not allowed on column ${JSON.stringify(column)}`);
  }
}

function check(spec: IAggregateRequest, columns: IAggregateColumns): void {
  if (!spec || !Array.isArray(spec.measures) || spec.measures.length === 0) {
    refuse('measures', 'An aggregate request needs at least one measure');
  }
  if (spec.measures.length > MAX_MEASURES) {
    refuse('measures', `An aggregate request may hold ${MAX_MEASURES} measures, got ${spec.measures.length}`);
  }

  const names = new Set<string>();
  checkGroupBy(spec.groupBy ?? [], columns, names);
  for (const measure of spec.measures) {
    checkMeasureName(measure, names);
    checkMeasure(measure, columns);
  }
  checkOrderAndLimit(spec, names);
}

function checkOrderAndLimit(spec: IAggregateRequest, names: Set<string>): void {
  for (const sort of spec.order ?? []) {
    if (!sort?.column || !names.has(sort.column)) {
      refuse('order', `An aggregate is ordered by its group columns or measure names, got ${JSON.stringify(sort?.column)}`);
    }
  }

  if (spec.limit !== undefined && (!Number.isSafeInteger(spec.limit) || spec.limit < 1)) {
    refuse('limit', `limit must be an integer >= 1, got ${JSON.stringify(spec.limit)}`);
  }
}

/** The protected parts of a builder this extension reads; the builder offers no public way to add several counts. */
interface BuilderInternals {
  _columns: IQueryStatement[];
  _container: IContainer;
  _tableAlias: string;
  _model: unknown;
}

const prototype = SelectQueryBuilder.prototype as unknown as { aggregate: (this: SelectQueryBuilder<unknown>, spec: IAggregateRequest, columns?: IAggregateColumns) => SelectQueryBuilder<unknown> };

prototype.aggregate = function (this: SelectQueryBuilder<unknown>, spec: IAggregateRequest, columns?: IAggregateColumns) {
  const internals = this as unknown as BuilderInternals;
  const allowed = columns ?? aggregateColumnsOf(internals._model ? extractModelDescriptor(internals._model) : null);
  check(spec, allowed);

  this.clearColumns();

  for (const column of spec.groupBy ?? []) {
    this.select(column);
    this.groupBy(column);
  }

  // Pushed as statements: `count()` on the builder clears the columns selected so far.
  for (const measure of spec.measures) {
    internals._columns.push(internals._container.resolve(ColumnMethodStatement, [measure.column ?? '*', METHODS[measure.fn], measure.name, internals._tableAlias]));
  }

  for (const sort of spec.order ?? []) {
    this.order(sort.column as string, sort.order);
  }

  this.take(Math.min(spec.limit ?? MAX_AGGREGATE_ROWS, MAX_AGGREGATE_ROWS));

  return this;
};

/** Raw aggregate rows as an answer: drivers hand sums and counts back as text (Postgres bigint, decimals). */
export function readAggregateRows(rows: Record<string, unknown>[], spec: IAggregateRequest): Record<string, unknown>[] {
  const numeric = spec.measures.filter((measure) => measure.fn === 'sum' || measure.fn === 'avg' || measure.fn === 'count').map((measure) => measure.name);

  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of spec.groupBy ?? []) {
      out[column] = row[column] ?? null;
    }
    for (const measure of spec.measures) {
      const value = row[measure.name] ?? null;
      out[measure.name] = numeric.includes(measure.name) && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
    }
    return out;
  });
}
