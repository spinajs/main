/**
 * Checks if a number is odd
 * Usage: {{#if (isOdd @index)}}...{{/if}}
 */
export function isOdd(index: number): boolean {
  return index % 2 !== 0;
}

/**
 * Checks if a number is even
 * Usage: {{#if (isEven @index)}}...{{/if}}
 */
export function isEven(index: number): boolean {
  return index % 2 === 0;
}

/**
 * Equality comparison
 * Usage: {{#if (eq a b)}}...{{/if}}
 */
export function eq(a: any, b: any): boolean {
  return a === b;
}

/**
 * Not equal comparison
 * Usage: {{#if (ne a b)}}...{{/if}}
 */
export function ne(a: any, b: any): boolean {
  return a !== b;
}

/**
 * Less than comparison
 * Usage: {{#if (lt a b)}}...{{/if}}
 */
export function lt(a: any, b: any): boolean {
  return a < b;
}

/**
 * Greater than comparison
 * Usage: {{#if (gt a b)}}...{{/if}}
 */
export function gt(a: any, b: any): boolean {
  return a > b;
}

/**
 * Less than or equal comparison
 * Usage: {{#if (lte a b)}}...{{/if}}
 */
export function lte(a: any, b: any): boolean {
  return a <= b;
}

/**
 * Greater than or equal comparison
 * Usage: {{#if (gte a b)}}...{{/if}}
 */
export function gte(a: any, b: any): boolean {
  return a >= b;
}

/**
 * Logical AND operation
 * Usage: {{#if (and a b)}}...{{/if}}
 */
export function and(...args: any[]): boolean {
  // Last argument is Handlebars options object
  const values = args.slice(0, -1);
  return values.every(v => !!v);
}

/**
 * Logical OR operation
 * Usage: {{#if (or a b)}}...{{/if}}
 */
export function or(...args: any[]): boolean {
  // Last argument is Handlebars options object
  const values = args.slice(0, -1);
  return values.some(v => !!v);
}

/**
 * Logical NOT operation
 * Usage: {{#if (not value)}}...{{/if}}
 */
export function not(value: any): boolean {
  return !value;
}

/**
 * Check if value is null or undefined
 * Usage: {{#if (isNil value)}}...{{/if}}
 */
export function isNil(value: any): boolean {
  return value === null || value === undefined;
}

/**
 * Check if value is truthy
 * Usage: {{#if (isTruthy value)}}...{{/if}}
 */
export function isTruthy(value: any): boolean {
  return !!value;
}

/**
 * Check if value is falsy
 * Usage: {{#if (isFalsy value)}}...{{/if}}
 */
export function isFalsy(value: any): boolean {
  return !value;
}

/**
 * Check if value is empty (null, undefined, empty string, empty array, empty object)
 * Usage: {{#if (isEmpty value)}}...{{/if}}
 */
export function isEmpty(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Check if value is not empty
 * Usage: {{#if (isNotEmpty value)}}...{{/if}}
 */
export function isNotEmpty(value: any): boolean {
  return !isEmpty(value);
}

/**
 * Check if value is in array or string contains substring
 * Usage: {{#if (includes array value)}}...{{/if}}
 */
export function includes(collection: any[] | string, value: any): boolean {
  if (Array.isArray(collection)) {
    return collection.includes(value);
  }
  if (typeof collection === 'string' && typeof value === 'string') {
    return collection.includes(value);
  }
  return false;
}

/**
 * Check if string starts with prefix
 * Usage: {{#if (startsWith str "prefix")}}...{{/if}}
 */
export function startsWith(str: string, prefix: string): boolean {
  if (typeof str !== 'string' || typeof prefix !== 'string') return false;
  return str.startsWith(prefix);
}

/**
 * Check if string ends with suffix
 * Usage: {{#if (endsWith str "suffix")}}...{{/if}}
 */
export function endsWith(str: string, suffix: string): boolean {
  if (typeof str !== 'string' || typeof suffix !== 'string') return false;
  return str.endsWith(suffix);
}

/**
 * Check if value is between min and max (inclusive)
 * Usage: {{#if (between value 1 10)}}...{{/if}}
 */
export function between(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Compare values with custom operator
 * Usage: {{#if (compare a ">" b)}}...{{/if}}
 */
export function compare(a: any, operator: string, b: any): boolean {
  switch (operator) {
    case '==': return a == b;
    case '===': return a === b;
    case '!=': return a != b;
    case '!==': return a !== b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    default: return false;
  }
}
