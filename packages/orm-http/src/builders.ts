import { SelectQueryBuilder, SqlOperator } from '@spinajs/orm';
import { IFilter, IColumnFilter, FilterableLogicalOperators, FilterableOperators } from './interfaces.js';
import { _is_array, _min_length, _is_string, _non_undefined, _check_arg, _trim, _non_empty } from '@spinajs/util';
import { InvalidArgument } from '@spinajs/exceptions';

/**
 * Validation helper functions for different value types using @spinajs/util
 */
const ValidationHelpers = {
  requireArray: (filter: IFilter) => {
    _check_arg(_is_array(), _min_length(1, new InvalidArgument(`Operator '${filter.Operator}' for column '${filter.Column}' requires an array with at least 1 value, got: ${filter.Value.length}`, filter.Column, 'LENGTH_TOO_SHORT')))(filter.Value, filter.Column);
  },

  requireTwoValueArray: (filter: IFilter) => {
    _check_arg(_is_array(), _min_length(2, new InvalidArgument(`Operator '${filter.Operator}' for column '${filter.Column}' requires an array with exactly 2 values, got: ${filter.Value.length}`, filter.Column, 'LENGTH_TOO_SHORT')))(filter.Value, filter.Column);
  },

  requireString: (filter: IFilter) => {
    if (filter.Value !== null && filter.Value !== undefined) {
      _check_arg(_is_string(), _trim(), _non_empty(
        new InvalidArgument(`Operator '${filter.Operator}' for column '${filter.Column}' requires a non-empty string, got: ${filter.Value}`, filter.Column, 'INVALID_STRING')
      ))(filter.Value, filter.Column);
    }
  },

  requireValue: (filter: IFilter) => {
    _check_arg(_non_undefined(
      new InvalidArgument(`Operator '${filter.Operator}' for column '${filter.Column}' requires a value, got: ${filter.Value}`, filter.Column, 'VALUE_REQUIRED')
    ))(filter.Value, filter.Column);
  },

  noValidation: () => {
    // No validation needed for operators that don't use the Value field
  }
};

/**
 * Operator mapping with validation, AND and OR application functions
 */
const OPERATOR_MAP: Record<FilterableOperators, {
  validate: (filter: IFilter) => void;
  applyAnd: (queryBuilder: SelectQueryBuilder<any>, filter: IFilter) => void;
  applyOr: (queryBuilder: SelectQueryBuilder<any>, filter: IFilter) => void;
}> = {
  'eq': {
    validate: ValidationHelpers.requireValue,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.EQ, filter.Value),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.EQ, filter.Value)
  },
  'neq': {
    validate: ValidationHelpers.requireValue,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.NOT, filter.Value),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.NOT, filter.Value)
  },
  'gt': {
    validate: ValidationHelpers.requireValue,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.GT, filter.Value),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.GT, filter.Value)
  },
  'gte': {
    validate: ValidationHelpers.requireValue,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.GTE, filter.Value),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.GTE, filter.Value)
  },
  'lt': {
    validate: ValidationHelpers.requireValue,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.LT, filter.Value),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.LT, filter.Value)
  },
  'lte': {
    validate: ValidationHelpers.requireValue,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.LTE, filter.Value),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.LTE, filter.Value)
  },
  'like': {
    validate: ValidationHelpers.requireString,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.LIKE, `%${filter.Value}%`),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.LIKE, `%${filter.Value}%`)
  },
  'b-like': {
    validate: ValidationHelpers.requireString,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.LIKE, `%${filter.Value}`),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.LIKE, `%${filter.Value}`)
  },
  'e-like': {
    validate: ValidationHelpers.requireString,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.LIKE, `${filter.Value}%`),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.LIKE, `${filter.Value}%`)
  },
  'between': {
    validate: ValidationHelpers.requireTwoValueArray,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.BETWEEN, filter.Value),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.BETWEEN, filter.Value)
  },
  'notbetween': {
    validate: ValidationHelpers.requireTwoValueArray,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.NOT_BETWEEN, filter.Value),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.NOT_BETWEEN, filter.Value)
  },
  'isnull': {
    validate: ValidationHelpers.noValidation,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.NULL),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.NULL)
  },
  'notnull': {
    validate: ValidationHelpers.noValidation,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.NOT_NULL),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.NOT_NULL)
  },
  'in': {
    validate: ValidationHelpers.requireArray,
    applyAnd: (qb, filter) => qb.whereIn(filter.Column, filter.Value),
    applyOr: (qb, filter) => qb.orWhere((query: any) => query.whereIn(filter.Column, filter.Value))
  },
  'nin': {
    validate: ValidationHelpers.requireArray,
    applyAnd: (qb, filter) => qb.whereNotIn(filter.Column, filter.Value),
    applyOr: (qb, filter) => qb.orWhere((query: any) => query.whereNotIn(filter.Column, filter.Value))
  },
  'exists': {
    validate: ValidationHelpers.noValidation,
    applyAnd: (qb, filter) => qb.whereExist(filter.Column),
    applyOr: (qb, filter) => qb.orWhere((query: any) => query.whereExist(filter.Column))
  },
  'n-exists': {
    validate: ValidationHelpers.noValidation,
    applyAnd: (qb, filter) => qb.whereNotExists(filter.Column),
    applyOr: (qb, filter) => qb.orWhere((query: any) => query.whereNotExists(filter.Column))
  },
  'regexp': {
    validate: ValidationHelpers.requireString,
    applyAnd: (qb, filter) => qb.andWhere(filter.Column, SqlOperator.REGEXP, filter.Value),
    applyOr: (qb, filter) => qb.orWhere(filter.Column, SqlOperator.REGEXP, filter.Value)
  }
};

/**
 * Extend where builder with filter func old style ( by prototype )
 */
(SelectQueryBuilder.prototype as any).filter = function (this: SelectQueryBuilder<any>, filters?: IFilter[], logicalOperator?: FilterableLogicalOperators, filterColumns?: IColumnFilter<unknown>[]) {

  if (!filters || filters.length === 0) {
    return this;
  }

  // Performance optimization: limit the number of filters to prevent abuse
  const MAX_FILTERS = 100;
  if (filters.length > MAX_FILTERS) {
    throw new Error(`Too many filters provided: ${filters.length}. Maximum allowed: ${MAX_FILTERS}`);
  }

  const columns: IColumnFilter<unknown>[] = filterColumns ?? (this._model as any).filterColumns();
  const useOrOperator = logicalOperator === FilterableLogicalOperators.Or;

  // Pre-validate all filters before applying any
  filters.forEach((filter, index) => {
    if (!filter || typeof filter !== 'object') {
      throw new Error(`Invalid filter at index ${index}: must be an object`);
    }
  });
  this.andWhere(function () {
    filters.forEach((filter, index) => {

      if (!filter.Column) {
        throw new Error(`Column is required for filter at index ${index}`);
      }

      if (!filter.Operator) {
        throw new Error(`Operator is required for filter at index ${index}`);
      }

      // Validate that the operator is supported
      if (!Object.keys(OPERATOR_MAP).includes(filter.Operator)) {
        throw new Error(`Unsupported operator '${filter.Operator}' at index ${index}. Supported operators: ${Object.keys(OPERATOR_MAP).join(', ')}`);
      }

      const column = columns.find((c) => c.column === filter.Column);
      if (!column) {
        throw new Error(`Column '${filter.Column}' is not filterable at index ${index}`);
      }

      // Validate that the operator is allowed for this column
      if (column.operators && !column.operators.includes(filter.Operator)) {
        throw new Error(`Operator '${filter.Operator}' is not allowed for column '${filter.Column}' at index ${index}. Allowed operators: ${column.operators.join(', ')}`);
      }

      if (column.query) {
        column.query(filter.Operator, filter.Value).call(this);
        return;
      }

      // Apply the operator using the operator map
      const operatorConfig = OPERATOR_MAP[filter.Operator];
      if (!operatorConfig) {
        throw new Error(`Unsupported operator: ${filter.Operator}`);
      }

      // Validate filter value using operator-specific validation
      operatorConfig.validate(filter);


      if (useOrOperator) {
        operatorConfig.applyOr(this, filter);
      } else {
        operatorConfig.applyAnd(this, filter);
      }
    });
  });

  return this;
};
