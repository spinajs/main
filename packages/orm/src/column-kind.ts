import type { IColumnDescriptor } from './interfaces.js';

/** What a column holds, whatever spelling its driver reports for the type. */
export type ColumnKind = 'integer' | 'decimal' | 'uuid' | 'text' | 'other';

const INTEGER = /^(?:(?:tiny|small|medium|big)?int(?:eger)?[248]?|(?:small|big)?serial[248]?)$/;
const DECIMAL = /^(?:numeric|decimal|dec|number|real|float[48]?|double(?:precision)?|smallmoney|money)$/;
const UUID = /^(?:uuid|uniqueidentifier)$/;
const TEXT = /^(?:charactervarying|character|n?varchar2?|n?char|bpchar|n?text|tinytext|mediumtext|longtext|citext|string|clob)$/;

const INTEGER_TEXT = /^-?(?:0|[1-9]\d*)$/;
const DECIMAL_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalise = (type: string): string =>
  type
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\b(?:unsigned|signed|zerofill)\b/g, '')
    .replace(/\s+/g, '');

export function columnKind(column: Pick<IColumnDescriptor, 'Type' | 'NativeType'>): ColumnKind {
  const type = normalise(column.Type || column.NativeType || '');
  if (INTEGER.test(type)) return 'integer';
  if (DECIMAL.test(type)) return 'decimal';
  if (UUID.test(type)) return 'uuid';
  if (TEXT.test(type)) return 'text';
  return 'other';
}

/**
 * The value to compare `column` with for a key that arrives as text, or undefined when no value of the
 * column's type equals it. Bound anyway, such text fails the cast on some databases and is coerced to
 * another key on others.
 */
export function lookupValue(column: Pick<IColumnDescriptor, 'Type' | 'NativeType'>, text: string): string | number | undefined {
  switch (columnKind(column)) {
    case 'integer': {
      if (!INTEGER_TEXT.test(text)) return undefined;
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    case 'decimal':
      return DECIMAL_TEXT.test(text) ? text : undefined;
    case 'uuid':
      return UUID_TEXT.test(text) ? text : undefined;
    default:
      return text;
  }
}
