import { InvalidArgument } from '@spinajs/exceptions';
import GlobToRegExp from 'glob-to-regexp';
import { trimChar } from './string.js';
import { Constructor } from './fp.js';
import { DateTime } from 'luxon';

/**
 * Helper function to validate arguments
 *
 * @param checks
 * @returns validated argument
 */
export function _check_arg(...checks: ((arg: any, name: string) => any)[]) {
  return function (arg: any, name: string) {
    for (const check of checks) {
      arg = check(arg, name);
    }

    return arg;
  };
}

/**
 * Tries to validate an argument using the provided checks
 * If validation fails, it returns a tuple with a boolean indicating failure and the error.
 * This is useful for scenarios where you want to handle validation errors gracefully.
 * 
 * @param checks - validation checks to apply
 * @returns 
 */
export function _try_check_arg(...checks: ((arg: any, name: string) => any)[]) : (arg: any, name?: string) => [boolean, any] {
  return function (arg: any, name?: string) {  
    try {
      const val = _check_arg(...checks)(arg, name ?? 'argument');
      return [true, val];
    } catch (e) {
      if (e instanceof InvalidArgument) {
        return [false, e];
      }

      throw e;
    }
  };
}

/**
 * Validate number, if not number throws InvalidArgument
 *
 * @param checks
 * @returns validated number
 */

export function _is_number(...checks: ((arg: number, name: string) => unknown)[]) {
  return function (arg: unknown, name: string) {
    if (typeof arg !== 'number') {
      throw new InvalidArgument(`${name} should be number`, name, 'TYPE_MISMATCH');
    }

    return _check_arg(...checks)(arg, name);
  };
}

export function _is_map<K, V>(...checks: ((arg: unknown, name: string) => unknown)[]): (arg: Map<K, V>, name: string) => Map<K, V> {
  return function (arg: Map<K, V>, name: string) {
    if (!(arg instanceof Map)) {
      throw new InvalidArgument(`${name} should be Map`, name, 'TYPE_MISMATCH');
    }

    return _check_arg(...checks)(arg, name);
  };
}

export function _contains_key<K, V>(key: K): (arg: unknown, name: string) => Map<K, V> | object {
  return function (arg: Map<K, V> | object, name: string) {
    if (arg instanceof Map) {
      if (!arg.has(key)) {
        throw new InvalidArgument(`${name} should contain key ${key}`, name, 'MISSING_KEY');
      }
    } else if (typeof arg === 'object' && !Object.keys(arg).includes(key.toString())) {
      throw new InvalidArgument(`${name} should contain key ${key}`, name, 'MISSING_KEY');
    }

    return arg;
  };
}

export function _is_boolean(...checks: ((arg: unknown, name: string) => boolean)[]) {
  return function (arg: unknown, name: string) {
    if (typeof arg === 'number') {
      if (arg !== 1 && arg !== 0) {
        throw new InvalidArgument(`${name} should be boolean`, name, 'TYPE_MISMATCH');
      }
    } else if (typeof arg !== 'boolean') {
      throw new InvalidArgument(`${name} should be boolean`, name, 'TYPE_MISMATCH');
    }

    return _check_arg(...checks)(arg, name);
  };
}

/**
 * Check if argument is string, if not throws InvalidArgument
 *
 * @param checks
 * @returns
 */
export function _is_string(...checks: ((arg: string, name: string) => unknown)[]) {
  return function (arg: unknown, name: string) {
    if (typeof arg !== 'string') {
      throw new InvalidArgument(`${name} should be string`, name, 'TYPE_MISMATCH');
    }

    return _check_arg(...checks)(arg, name);
  };
}

export function _is_array(...checks: ((arg: any[], name: string) => any[])[]) {
  return function (arg: any[], name: string) {
    if (!Array.isArray(arg)) {
      throw new InvalidArgument(`${name} should be array`, name, 'TYPE_MISMATCH');
    }

    return _check_arg(...checks)(arg, name);
  };
}


/**
 * Check if argument is an array and validate all elements
 *
 * @param checks - validation checks to apply to each element
 * @returns validated array
 */
export function _is_array_of(...checks: ((arg: any, name: string) => any)[]) {
  return _is_array(function (arg: any[], name: string) {
    const validator = _check_arg(...checks);
    
    return arg.map((item, index) => {
      try {
        return validator(item, `${name}[${index}]`);
      } catch (e) {
        if (e instanceof InvalidArgument) {
          throw new InvalidArgument(
            `${name}[${index}] validation failed: ${e.message}`,
            name,
            'ARRAY_ELEMENT_VALIDATION_FAILED',
            e
          );
        }
        throw e;
      }
    });
  });
}

export function _is_object(...checks: ((arg: object, name: string) => object)[]) {
  return function (arg: object, name: string) {
    if (typeof arg !== 'object' || arg === null || arg === undefined || Array.isArray(arg)) {
      throw new InvalidArgument(`${name} should be plain old object`, name, 'TYPE_MISMATCH');
    }

    return _check_arg(...checks)(arg, name);
  };
}

export function _is_instance_of(c: Constructor<unknown>, ...checks: ((arg: object, name: string) => object)[]) {
  return function (arg: object, name: string) {
    if (typeof arg !== 'object' || arg === null || arg === undefined || Array.isArray(arg) || arg.constructor.name !== c.name) {
      throw new InvalidArgument(`${name} is not type of ${c.name}`, name, 'TYPE_MISMATCH');
    }

    return _check_arg(...checks)(arg, name);
  };
}

export function _or(...checks: ((arg: any, name: string) => any)[]) {
  return function (arg: any, name: string) {
    for (const check of checks) {
      try {
        return check(arg, name);
      } catch (e) {
        // ignore
      }
    }

    throw new InvalidArgument(`${name} should pass at least one check: ${checks.map((c) => c.name).join(', ')}`, name, 'VALIDATION_FAILED');
  };
}

export function _to_upper() {
  return function (arg: unknown, _name: string) {
    if (typeof arg !== 'string') {
      return arg;
    }
    return arg.toUpperCase();
  };
}

export function _to_array() {
  return function (arg: unknown) {
    if (Array.isArray(arg)) {
      return arg;
    }

    return [arg];
  };
}

export function _to_lower() {
  return function (arg: unknown, _name: string) {
    if (typeof arg !== 'string') {
      return arg;
    }

    return arg.toLowerCase();
  };
}

export function _trim(char?: string) {
  return function (arg: unknown, _name: string) {
    if (typeof arg === 'string') {
      return char ? trimChar(arg, char) : arg.trim();
    }
    return arg;
  };
}

export function _between(min: number, max: number, error?: InvalidArgument) {
  return function (arg: string | number | any[], name: string) {
    if (Array.isArray(arg) || typeof arg === 'string') {
      if (arg.length < min || arg.length > max) {
        throw error ?? new InvalidArgument(`${name} should be between ${min} and ${max}`, name, 'RANGE_ERROR');
      }
    } else if (typeof arg === 'number') {
      if (arg < min || arg > max) {
        throw error ?? new InvalidArgument(`${name} should be between ${min} and ${max}`, name, 'RANGE_ERROR');
      }
    }

    return arg;
  };
}

export function _min_length(length: number, error?: InvalidArgument) {
  return function (arg: string | any[], name: string) {
    if (Array.isArray(arg)) {
      if (arg.length < length) {
        throw error ?? new InvalidArgument(`${name} should be at least ${length} items`, name, 'LENGTH_TOO_SHORT');
      }
    } else if (typeof arg === 'string') {
      if (arg.length < length) {
        throw error ?? new InvalidArgument(`${name} should be at least ${length} characters`, name, 'LENGTH_TOO_SHORT');
      }
    }
    else throw new InvalidArgument(`${name} should be a string or an array`, name, 'TYPE_MISMATCH');


    return arg;
  };
}

export function _max_length(length: number, error?: InvalidArgument) {
  return function (arg: string | any[], name: string) {
    if (Array.isArray(arg)) {
      if (arg.length > length) {
        throw error ?? new InvalidArgument(`${name} should be at most ${length} items`, name, 'LENGTH_TOO_LONG');
      }
    } else if (typeof arg === 'string') {
      if (arg.length > length) {
        throw error ?? new InvalidArgument(`${name} should be at most ${length} characters`, name, 'LENGTH_TOO_LONG');
      }
    }
    else throw new InvalidArgument(`${name} should be a string or an array`, name, 'TYPE_MISMATCH');

    return arg;
  };
}

export function _min(value: number, error?: InvalidArgument) {
  return function (arg: number, name: string) {
    if (arg < value) {
      throw error ?? new InvalidArgument(`${name} should be at least ${value}`, name, 'VALUE_TOO_SMALL');
    }

    return arg;
  };
}

export function _max(value: number, error?: InvalidArgument) {
  return function (arg: number, name: string) {
    if (arg > value) {
      throw error ?? new InvalidArgument(`${name} should be at most ${value}`, name, 'VALUE_TOO_LARGE');
    }

    return arg;
  };
}

export function _non_null(error?: InvalidArgument) {
  return function (arg: any, name: string) {
    if (arg === null) {
      throw error ?? new InvalidArgument(`${name} should not be null`, name, 'NULL_VALUE');
    }

    return arg;
  };
}

export function _non_undefined(error?: InvalidArgument) {
  return function (arg: any, name: string) {
    if (arg === undefined) {
      throw error ?? new InvalidArgument(`${name} should not be undefined`, name, 'UNDEFINED_VALUE');
    }

    return arg;
  };
}

export function _non_NaN(error?: InvalidArgument) {
  return function (arg: any, name: string) {
    if (isNaN(arg)) {
      throw error ?? new InvalidArgument(`${name} is NaN`, name, 'NAN_VALUE');
    }

    return arg;
  };
}

export function _non_nil(error?: InvalidArgument) {
  return function (arg: any, name: string) {
    if (arg === null || arg === undefined || arg === '' || (Array.isArray(arg) && arg.length === 0) || (typeof arg === 'object' && Object.keys(arg).length === 0)) {
      throw error ?? new InvalidArgument(`${name} should not be null, undefined or empty`, name, 'EMPTY_VALUE');
    }

    return arg;
  };
}

export function _non_empty(error?: InvalidArgument) {
  return function (arg: string | any[], name: string) {
    if (arg.length === 0) {
      throw error ?? new InvalidArgument(`${name} should not be empty`, name, 'EMPTY_VALUE');
    }

    return arg;
  };
}

export function _default<T>(value: T | (() => T)): (arg: T, name: string) => T {
  return function (arg: any, _name: string) {
    if (arg === null || arg === undefined || arg === '' || (Array.isArray(arg) && arg.length === 0) || (typeof arg === 'object' && Object.keys(arg).length === 0)) {
      if (value instanceof Function) {
        return value();
      }
      return value;
    }

    return arg;
  };
}

export function _contains<T>(values: unknown, error?: InvalidArgument) {
  return function (arg: T, name: string) {
    if (!Array.isArray(values)) {
      throw new InvalidArgument(`${name} should be an array`, name, 'TYPE_MISMATCH');
    }

    if (!values.includes(arg)) {
      throw error ?? new InvalidArgument(`${name} should be one of ${values.join(', ')}`, name, 'INVALID_CHOICE');
    }

    return arg;
  };
}

export function _lt(value: number, error?: InvalidArgument) {
  return function (arg: unknown, name: string) {
    if (typeof arg !== 'number') {
      return arg;
    }

    if (arg >= value) {
      throw error ?? new InvalidArgument(`${name} should be less than ${value}`, name, 'VALUE_TOO_LARGE');
    }

    return arg;
  };
}

export function _lte(value: number, error?: InvalidArgument) {
  return function (arg: unknown, name: string) {
    if (typeof arg !== 'number') {
      return arg;
    }

    if (arg > value) {
      throw error ?? new InvalidArgument(`${name} should be less than or equal ${value}`, name, 'VALUE_TOO_LARGE');
    }

    return arg;
  };
}

export function _gt(value: number, error?: InvalidArgument) {
  return function (arg: unknown, name: string) {
    if (typeof arg !== 'number') {
      return arg;
    }

    if (arg <= value) {
      throw error ?? new InvalidArgument(`${name} should be greater than ${value}`, name, 'VALUE_TOO_SMALL');
    }

    return arg;
  };
}

export function _gte(value: number, error?: InvalidArgument) {
  return function (arg: unknown, name: string) {
    if (typeof arg !== 'number') {
      return arg;
    }

    if (arg < value) {
      throw error ?? new InvalidArgument(`${name} should be greater than or equal ${value}`, name, 'VALUE_TOO_SMALL');
    }

    return arg;
  };
}

export function _reg_match(reg: RegExp, error?: InvalidArgument) {
  return function (arg: unknown, name: string) {
    if (typeof arg !== 'string') {
      return arg;
    }

    if (!reg.test(arg)) {
      throw error ?? new InvalidArgument(`${name} should match ${reg}`, name, 'PATTERN_MISMATCH');
    }

    return arg;
  };
}

export function _glob_match(glob: string, error?: InvalidArgument) {
  return function (arg: unknown, name: string) {
    if (typeof arg !== 'string') {
      return arg;
    }
    return _reg_match(GlobToRegExp(glob), error)(arg, name);
  };
}

export function _is_email() {
  return _reg_match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/);
}

export function _is_uuid() {
  return _reg_match(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
}

export function _to_int(error?: InvalidArgument) {
  return function (arg: string, name: string) {
    const res = parseInt(arg);

    if (isNaN(res)) {
      throw error ?? new InvalidArgument(`${name} should be integer`, name, 'PARSE_ERROR');
    }

    return res;
  };
}

export function _to_float(error?: InvalidArgument) {
  return function (arg: string, name: string) {
    const res = parseFloat(arg);

    if (isNaN(res)) {
      throw error ?? new InvalidArgument(`${name} should be float`, name, 'PARSE_ERROR');
    }

    return res;
  };
}

export function _to_date(fromFormat?: string, error?: InvalidArgument) {
  return function (arg: any, name: string) {

    if(!arg || typeof arg !== 'string' && !(arg instanceof Date)) {
      throw error ?? new InvalidArgument(`${name} should be a valid date string or Date object`, name, 'PARSE_ERROR');
    }

    if(arg instanceof Date) {
      return DateTime.fromJSDate(arg).startOf('day');
    }

    const res = fromFormat ? DateTime.fromFormat(arg, fromFormat).startOf('day') : DateTime.fromISO(arg).startOf('day');

    if (res.isValid === false) {
      throw error ?? new InvalidArgument(`${name} should be a valid date in format ${fromFormat}`, name, 'PARSE_ERROR');
    }

    return res;
  };
}

/**
 * 
 * Alias for _contains
 * 
 * @param oneOf 
 * @param error 
 * @returns 
 */
export function _one_of<T>(oneOf: T[], error?: InvalidArgument) {
  return _contains(oneOf, error);
}

/**
 * Custom validation check using a callback function
 * 
 * @param callback - Function that returns true if validation passes, false otherwise
 * @param error - Optional custom error to throw if validation fails
 * @returns 
 */
export function _custom<T>(callback: (arg: T) => boolean, error?: InvalidArgument) {
  return function (arg: T, name: string) {
    if (!callback(arg)) {
      throw error ?? new InvalidArgument(`${name} failed custom validation`, name, 'CUSTOM_VALIDATION_FAILED');
    }

    return arg;
  };
}

export function _positive(error?: InvalidArgument) {
  return function (arg: number, name: string) {
    if (typeof arg !== 'number' || arg <= 0) {
      throw error ?? new InvalidArgument(`${name} should be a positive number`, name, 'NEGATIVE_OR_ZERO');
    }

    return arg;
  };
}

export function _convert<T, U>(fn: (arg: T) => U, error?: InvalidArgument) {
  return function (arg: T, name: string) {
    try {
      return fn(arg);
    } catch {
      throw error ?? new InvalidArgument(`${name} failed conversion`, name, 'CONVERSION_FAILED');
    }
  };
}
