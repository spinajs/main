import {
  isBinary,
  isByte,
  isDate,
  isDateTime,
  isDouble,
  isDuration,
  isEmail,
  isFloat,
  isHostname,
  isInt32,
  isInt64,
  isIpv4,
  isIpv6,
  isJsonPointer,
  isJsonPointerUriFragment,
  isPassword,
  isRegex,
  isRelativeJsonPointer,
  isTime,
  isUri,
  isUriReference,
  isUriTemplate,
  isUrl,
  isUuid,
} from './ajv-formats.js';

export * from './ajv-formats.js';
export * from './keywords.js';

const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export function isDecimal(str: string): boolean {
  return DECIMAL.test(str);
}

const STRING_FORMATS = new Map<string, (str: string) => boolean>([
  ['date', isDate],
  ['time', isTime],
  ['date-time', isDateTime],
  ['duration', isDuration],
  ['uri', isUri],
  ['uri-reference', isUriReference],
  ['uri-template', isUriTemplate],
  ['url', isUrl],
  ['email', isEmail],
  ['hostname', isHostname],
  ['ipv4', isIpv4],
  ['ipv6', isIpv6],
  ['regex', isRegex],
  ['uuid', isUuid],
  ['json-pointer', isJsonPointer],
  ['json-pointer-uri-fragment', isJsonPointerUriFragment],
  ['relative-json-pointer', isRelativeJsonPointer],
  ['byte', isByte],
  ['password', isPassword],
  ['binary', isBinary],
  ['decimal', isDecimal],
]);

const NUMBER_FORMATS = new Map<string, (value: number) => boolean>([
  ['int32', isInt32],
  ['int64', isInt64],
  ['float', isFloat],
  ['double', isDouble],
]);

/**
 * The server's check for a string `format`, or `undefined` for a format the server does not know (it then accepts
 * every value) and for the number formats. Ajv applies a string format to strings only.
 */
export function formatPredicate(name: string): ((s: string) => boolean) | undefined {
  return STRING_FORMATS.get(name);
}

/** The server's check for `int32`, `int64`, `float` and `double`, which Ajv applies to numbers only. */
export function numberFormatPredicate(name: string): ((n: number) => boolean) | undefined {
  return NUMBER_FORMATS.get(name);
}
