import { RawQuery } from '@spinajs/orm';

const NULL_DEFAULT = /^\(NULL\)$/i;
const TEXT_DEFAULT = /^\(N?'((?:[^']|'')*)'\)$/;
const NUMBER_DEFAULT = /^\(\((-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)\)\)$/i;

const TEXT_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext']);
const NUMBER_TYPES = new Set(['tinyint', 'smallint', 'int', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney']);

function numberDefault(digits: string, type: string): unknown {
  if (NUMBER_TYPES.has(type)) return Number(digits);
  if (type === 'bit') return Number(digits) !== 0;
  // tedious reads a bigint as text
  if (type === 'bigint' || TEXT_TYPES.has(type)) return digits;
  return undefined;
}

/**
 * `COLUMN_DEFAULT` is the default's T-SQL text, `((0))`, `(N'a')` or `(getdate())`. A literal becomes the value tedious reads
 * from a column of that type; an expression, or a literal of another type (a date, a GUID), stays a `RawQuery`: a new model
 * leaves the column unset and the insert sends `DEFAULT`.
 */
export function columnDefault(text: unknown, type: string): unknown {
  if (typeof text !== 'string') return text ?? null;
  if (NULL_DEFAULT.test(text)) return null;

  const native = type.toLowerCase();
  const quoted = TEXT_DEFAULT.exec(text);
  const number = NUMBER_DEFAULT.exec(text);
  const value = quoted && TEXT_TYPES.has(native) ? quoted[1].replace(/''/g, "'") : number ? numberDefault(number[1], native) : undefined;

  return value === undefined ? RawQuery.create(text) : value;
}
