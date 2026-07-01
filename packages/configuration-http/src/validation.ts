import { InvalidArgument } from '@spinajs/exceptions';
import { ConfigurationEntryType, IConfigurationEntryMeta } from '@spinajs/configuration-db-source';
import { DateTime } from 'luxon';
import _ from 'lodash';

/**
 * Parses a single incoming value into the in-memory representation expected by
 * the `DbConfig` model for a given temporal type. Accepts ISO strings as well as
 * the canonical formats used by the model when it serializes back to the db.
 */
function toDateTime(type: ConfigurationEntryType, raw: unknown): DateTime {
  if (raw instanceof DateTime) {
    return raw;
  }

  if (typeof raw !== 'string') {
    throw new InvalidArgument(`value for type "${type}" must be a string`);
  }

  let dt = DateTime.fromISO(raw);
  if (!dt.isValid) {
    switch (type) {
      case 'date':
      case 'date-range':
        dt = DateTime.fromFormat(raw, 'dd-MM-yyyy');
        break;
      case 'time':
      case 'time-range':
        dt = DateTime.fromFormat(raw, 'HH:mm:ss');
        break;
      default:
        break;
    }
  }

  if (!dt.isValid) {
    throw new InvalidArgument(`value "${raw}" is not a valid ${type}`);
  }

  return dt;
}

function checkDateBounds(value: DateTime, meta?: IConfigurationEntryMeta) {
  if (!meta) {
    return;
  }

  if (meta.minDate && value < DateTime.fromISO(meta.minDate as unknown as string)) {
    throw new InvalidArgument(`value is before allowed minimum date`);
  }

  if (meta.maxDate && value > DateTime.fromISO(meta.maxDate as unknown as string)) {
    throw new InvalidArgument(`value is after allowed maximum date`);
  }
}

function checkNumberBounds(value: number, meta?: IConfigurationEntryMeta) {
  if (!meta) {
    return;
  }

  if (meta.min !== undefined && value < meta.min) {
    throw new InvalidArgument(`value ${value} is lower than allowed minimum ${meta.min}`);
  }

  if (meta.max !== undefined && value > meta.max) {
    throw new InvalidArgument(`value ${value} is greater than allowed maximum ${meta.max}`);
  }
}

/**
 * Validates and coerces a value coming from the HTTP layer into the typed
 * representation that the `DbConfig` model expects for the given configuration
 * `Type` and `Meta` constraints. Throws `InvalidArgument` ( mapped to HTTP 400 )
 * on any violation.
 */
export function coerceValue(type: ConfigurationEntryType, meta: IConfigurationEntryMeta | undefined, raw: unknown): unknown {
  switch (type) {
    case 'string':
    case 'file':
      if (typeof raw !== 'string') {
        throw new InvalidArgument(`value for type "${type}" must be a string`);
      }
      return raw;

    case 'int': {
      const n = Number(raw);
      if (!_.isFinite(n) || !Number.isInteger(n)) {
        throw new InvalidArgument(`value "${raw as string}" is not an integer`);
      }
      checkNumberBounds(n, meta);
      return n;
    }

    case 'float':
    case 'range': {
      const n = Number(raw);
      if (!_.isFinite(n)) {
        throw new InvalidArgument(`value "${raw as string}" is not a number`);
      }
      checkNumberBounds(n, meta);
      return n;
    }

    case 'boolean':
      if (typeof raw === 'boolean') {
        return raw;
      }
      if (raw === '1' || raw === 'true') {
        return true;
      }
      if (raw === '0' || raw === 'false') {
        return false;
      }
      throw new InvalidArgument(`value "${raw as string}" is not a boolean`);

    case 'oneOf': {
      if (typeof raw !== 'string') {
        throw new InvalidArgument(`value for type "oneOf" must be a string`);
      }
      if (meta?.oneOf && !meta.oneOf.includes(raw)) {
        throw new InvalidArgument(`value "${raw}" is not one of [${meta.oneOf.join(', ')}]`);
      }
      return raw;
    }

    case 'manyOf': {
      if (!_.isArray(raw)) {
        throw new InvalidArgument(`value for type "manyOf" must be an array`);
      }
      if (meta?.manyOf) {
        const invalid = raw.filter((x) => !meta.manyOf!.includes(x as string));
        if (invalid.length > 0) {
          throw new InvalidArgument(`values [${invalid.join(', ')}] are not allowed, expected subset of [${meta.manyOf.join(', ')}]`);
        }
      }
      return raw;
    }

    case 'date':
    case 'time':
    case 'datetime': {
      const dt = toDateTime(type, raw);
      checkDateBounds(dt, meta);
      return dt;
    }

    case 'date-range':
    case 'time-range':
    case 'datetime-range': {
      if (!_.isArray(raw)) {
        throw new InvalidArgument(`value for type "${type}" must be an array`);
      }
      return raw.map((x) => {
        const dt = toDateTime(type, x);
        checkDateBounds(dt, meta);
        return dt;
      });
    }

    case 'json':
    default:
      // json is stored as-is and serialized by the model
      return raw;
  }
}
