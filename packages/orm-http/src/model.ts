import { IColumnDescriptor, IModelDescriptor, ModelBase, OrmException, SelectQueryBuilder, columnToSchema, createQuery, extractModelDescriptor } from '@spinajs/orm';
import { MAX_FILTERS } from './builders.js';
import { aggregateColumnsOf, aggregateSchemaFor } from './aggregate.js';
import { InvalidOption } from '@spinajs/exceptions';
import { IAggregateColumns, IColumnFilter, IFilterRequest, FilterableLogicalOperators, FilterableOperators, MAX_FILTER_GROUP_DEPTH } from './interfaces.js';

/** Bound to each model class by the orm, so `this` is the class. */
const staticMixins = <M>(mixins: M & ThisType<typeof ModelBase>): M => mixins;

function descriptorOf(model: typeof ModelBase): IModelDescriptor {
  const descriptor = model.getModelDescriptor();
  if (!descriptor) {
    throw new OrmException(`Model ${model.name} has no descriptor`);
  }
  return descriptor;
}

export const MODEL_STATIC_MIXINS = staticMixins({
  async filter(filterRequest?: IFilterRequest) {
    const { query } = createQuery(this, SelectQueryBuilder);
    return (query as any).filter(filterRequest?.filters, filterRequest?.op);
  },

  filterColumns() {
    const modelDescriptor = (this as any).getModelDescriptor() as IModelDescriptor;

    if (!modelDescriptor) {
      throw new OrmException(`Model ${(this as any).name} has no descriptor`);
    }

    if(modelDescriptor.FilterableColumns === undefined){
      return [];
    }

    return [...modelDescriptor.FilterableColumns.entries()].map(([key, val]: [string, IColumnFilter<unknown>]) => {
      return {
        column: key,
        operators: val.operators,
        query: val.query,
        value: val.value,
      };
    });
  },

  filterSchema() {
    const modelDescriptor = (this as any).getModelDescriptor() as IModelDescriptor;

    if (!modelDescriptor) {
      throw new OrmException(`Model ${(this as any).name} has no descriptor`);
    }

    if (modelDescriptor.FilterableColumns === undefined){
      return {};
    }

    return modelFilterSchema(modelDescriptor);
  },

  sortableColumns(): string[] {
    const modelDescriptor = descriptorOf(this);

    if (modelDescriptor.SortableColumns && modelDescriptor.SortableColumns.size > 0) {
      return [...modelDescriptor.SortableColumns];
    }

    return [...(modelDescriptor.FilterableColumns?.keys() ?? [])].filter((name) => {
      const column = modelDescriptor.Columns.find((c) => c.Name === name);
      return !name.includes('.') && !!column && !column.Virtual && !modelDescriptor.Relations?.has(name);
    });
  },

  aggregateColumns(): IAggregateColumns {
    return aggregateColumnsOf(descriptorOf(this));
  },

  aggregateSchema() {
    return aggregateSchemaFor(aggregateColumnsOf(descriptorOf(this)));
  },

  includableRelations(): string[] {
    return [...(descriptorOf(this).IncludableRelations ?? [])];
  },
});

type FilterColumn = Pick<IColumnFilter<unknown>, 'column' | 'operators' | 'query' | 'value'>;

type OperatorGroup = 'scalar' | 'text' | 'list' | 'pair' | 'valueless';

/** The value shape of every filter operator; a Record, so a new operator does not compile until it has a group. */
export const FILTER_OPERATOR_GROUPS: Record<FilterableOperators, OperatorGroup> = {
  eq: 'scalar',
  neq: 'scalar',
  gt: 'scalar',
  gte: 'scalar',
  lt: 'scalar',
  lte: 'scalar',
  like: 'text',
  'b-like': 'text',
  'e-like': 'text',
  nlike: 'text',
  'nb-like': 'text',
  'ne-like': 'text',
  regexp: 'text',
  in: 'list',
  nin: 'list',
  'in-set': 'list',
  'nin-set': 'list',
  between: 'pair',
  notbetween: 'pair',
  isnull: 'valueless',
  notnull: 'valueless',
  exists: 'valueless',
  'n-exists': 'valueless',
  empty: 'valueless',
  nempty: 'valueless',
};

// Written as what is NOT accepted: a union `type` would make ajv's strict mode warn on every compile, and an `anyOf` of
// single types would coerce the value in its first branch. Neither `array` nor `object` is a coercion target.
const ANY_SCALAR = { not: { anyOf: [{ type: 'array' }, { type: 'object' }] } };

// What a custom query function or a filter-only column may receive: their value shape is up to the column's code.
const ANY_VALUE = { not: { type: 'object' } };

// Checked before the typed schema, which would coerce null into 0, false or "" and compare with that.
function nonNull(scalar: object): object {
  return { allOf: [{ not: { const: null } }, scalar] };
}

function groupValueSchema(group: OperatorGroup, scalar: object): object | undefined {
  switch (group) {
    case 'scalar':
      return nonNull(scalar);
    case 'text':
      return { type: 'string' };
    case 'list':
      return { type: 'array', minItems: 1, items: nonNull(scalar) };
    case 'pair':
      return { type: 'array', minItems: 2, maxItems: 2, items: nonNull(scalar) };
    case 'valueless':
      return undefined;
  }
}

/** The descriptor that owns `column`: the model's own, or for `Relation.Column` the related model's. */
function owningDescriptor(model: IModelDescriptor, column: string): [IModelDescriptor | undefined, string] {
  const dot = column.indexOf('.');
  if (dot === -1) {
    return [model, column];
  }

  const target = model.Relations?.get(column.slice(0, dot))?.TargetModel;
  return [(target && extractModelDescriptor(target)) || undefined, column.slice(dot + 1)];
}

/** The part of a column's model schema that says what one filter value may be. */
function columnScalarSchema(owner: IModelDescriptor, col: IColumnDescriptor): object {
  const converter = owner.Converters?.get(col.Name);
  const full = columnToSchema(col, {}, converter?.Class, converter?.Options);
  const single = full.type === 'array' && full.items ? full.items : full;

  if (typeof single.type !== 'string' || single.type === 'object' || single.type === 'array') {
    return ANY_SCALAR;
  }

  const scalar: Record<string, unknown> = { type: single.type };
  if (single.format) scalar.format = single.format;
  if (single.enum) scalar.enum = single.enum;
  return scalar;
}

/** The scalar schema of one filter value, or `undefined` when the column takes any value shape. */
function filterScalarSchema(filter: FilterColumn, model?: IModelDescriptor): object | undefined {
  if (filter.value) {
    return filter.value;
  }
  if (filter.query) {
    return undefined;
  }
  if (!model) {
    return ANY_SCALAR;
  }

  const [owner, name] = owningDescriptor(model, filter.column!);
  const col = owner?.Columns?.find((c) => c.Name === name);
  if (col?.Virtual) {
    return undefined;
  }

  return owner && col?.Type ? columnScalarSchema(owner, col) : ANY_SCALAR;
}

/**
 * One `if`/`then` per column and operator group. `Value` sits only in the `then`, so the validator looks at it -
 * and, with `coerceTypes`, converts it in place - only for the condition's own column and operator. Next to the
 * column leaves of an `anyOf` it would be coerced by every leaf tried before the matching one: `"05"` for a string
 * column reached the query as `"5"` once an integer column came first.
 */
function valueRules(filter: FilterColumn, model?: IModelDescriptor): object[] {
  const column = { const: filter.column };
  const scalar = filterScalarSchema(filter, model);

  if (scalar === undefined) {
    return [{ if: { required: ['Column'], properties: { Column: column } }, then: { properties: { Value: ANY_VALUE } } }];
  }

  const byGroup = new Map<OperatorGroup, FilterableOperators[]>();
  for (const operator of filter.operators) {
    const group = FILTER_OPERATOR_GROUPS[operator];
    byGroup.set(group, [...(byGroup.get(group) ?? []), operator]);
  }

  return [...byGroup.entries()].flatMap(([group, operators]) => {
    const value = groupValueSchema(group, scalar);
    if (!value) {
      return [];
    }
    return [{ if: { required: ['Column', 'Operator'], properties: { Column: column, Operator: { enum: operators } } }, then: { required: ['Value'], properties: { Value: value } } }];
  });
}

/**
 * JSON schema of a filter request over the given columns: a flat list of conditions, each of
 * which may instead be a nested group - `{ op, filters }` holding conditions of its own.
 *
 * The group is needed by any search that spans columns: "find this text in the name OR in the
 * id" has to OR those two while the filters around it keep ANDing, and a flat list cannot
 * express that. Groups nest `maxDepth` levels, one unless the model opts in with `@FilterGroupDepth`:
 * the builder walks whatever arrives, so the depth is a cost someone else pays, and this schema is
 * what bounds it.
 *
 * Each value is checked against its operator and column: see {@link FILTER_OPERATOR_GROUPS}. With `model`, a column
 * without an explicit `value` schema takes its type from the model's column.
 */
export function filterSchemaFor(columns: FilterColumn[], model?: IModelDescriptor, maxDepth = 1) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_FILTER_GROUP_DEPTH) {
    throw new InvalidOption(`Filter groups nest 1 to ${MAX_FILTER_GROUP_DEPTH} levels, got ${maxDepth}`);
  }

  const logicalOperator = {
    type: 'string',
    enum: [FilterableLogicalOperators.And, FilterableLogicalOperators.Or],
  };

  const leaf = columns.map(({ column, operators }) => ({
    type: 'object',
    required: ['Column', 'Operator'],
    properties: {
      Column: { const: column },
      Operator: { type: 'string', enum: operators },
    },
  }));

  const rules = columns.flatMap((c) => valueRules(c, model));
  const withRules = rules.length > 0 ? { allOf: rules } : {};

  const groupOf = (entries: object[]) => ({
    type: 'object',
    required: ['filters'],
    properties: {
      op: logicalOperator,
      not: { type: 'boolean' },
      filters: {
        type: 'array',
        items: { type: 'object', anyOf: entries, ...withRules },
      },
    },
  });

  // Unrolled innermost first: a recursive `$ref` would let a request nest without end.
  let group = groupOf(leaf);
  for (let level = 1; level < maxDepth; level++) {
    group = groupOf([...leaf, group]);
  }

  return {
    type: 'object',
    properties: {
      op: logicalOperator,
      filters: {
        type: 'array',
        maxItems: MAX_FILTERS,
        items: {
          type: 'object',
          anyOf: [...leaf, group],
          ...withRules,
        },
      },
    },
  };
}

/**
 * The validator compiles a schema once per object identity, so a schema rebuilt per request is compiled per request
 * ( and kept in its cache for good ). Rebuilt only when the orm has read the model's columns again.
 */
const MODEL_FILTER_SCHEMAS = new WeakMap<IModelDescriptor, { columns: unknown[]; schema: object }>();

function modelFilterSchema(model: IModelDescriptor): object {
  const keys = [...model.FilterableColumns!.keys()];
  const columns = [model.Columns, ...keys.map((k) => owningDescriptor(model, k)[0]?.Columns)];

  const cached = MODEL_FILTER_SCHEMAS.get(model);
  if (cached && cached.columns.length === columns.length && cached.columns.every((c, i) => c === columns[i])) {
    return cached.schema;
  }

  const schema = filterSchemaFor(
    [...model.FilterableColumns!.entries()].map(([column, val]) => ({ column, operators: val.operators, query: val.query, value: val.value })),
    model,
    model.FilterGroupDepth ?? 1,
  );
  MODEL_FILTER_SCHEMAS.set(model, { columns, schema });
  return schema;
}
