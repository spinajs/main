import type { Codec } from '../runtime/index.js';

// The libraries arrive as constructor arguments and are described structurally, so this module imports no package at
// runtime and its declarations need none installed.

interface LuxonValue {
  readonly isValid: boolean;
}

interface LuxonClass<D extends LuxonValue> {
  fromISO(text: string, options: { setZone: boolean }): D;
  isDateTime(value: unknown): value is D;
}

function luxonIso<D extends LuxonValue>(name: string, DateTime: LuxonClass<D>, shape: RegExp, write: (value: D) => string | null): Codec<D> {
  return {
    decode(wire) {
      const value = typeof wire === 'string' && shape.test(wire) ? DateTime.fromISO(wire, { setZone: true }) : undefined;
      if (!value?.isValid) throw new TypeError(`${name}: ${JSON.stringify(wire)} is not ISO text`);
      return value;
    },
    encode(value) {
      if (!DateTime.isDateTime(value)) return value;
      const text = value.isValid ? write(value) : null;
      if (text === null) throw new TypeError(`${name}: cannot encode an invalid DateTime`);
      return text;
    },
  };
}

/** `date-time` as a luxon `DateTime` that keeps the offset of the text: `luxonCodec(DateTime)`. */
export function luxonCodec<D extends LuxonValue & { toISO(): string | null }>(DateTime: LuxonClass<D>): Codec<D> {
  return luxonIso('luxonCodec', DateTime, /./, (value) => value.toISO());
}

/** `date` as a luxon `DateTime` at the start of that day: `luxonDateCodec(DateTime)`. */
export function luxonDateCodec<D extends LuxonValue & { toISODate(): string | null }>(DateTime: LuxonClass<D>): Codec<D> {
  return luxonIso('luxonDateCodec', DateTime, /^\d{4}-\d{2}-\d{2}$/, (value) => value.toISODate());
}

interface DecimalValue {
  toFixed(): string;
}

const NUMBER_TEXT = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

// Not `instanceof`: a cloned constructor (`Decimal.clone()`) or a second copy of the package makes a different class.
function isDecimalValue(value: unknown): value is DecimalValue {
  return typeof value === 'object' && value !== null && typeof value.constructor === 'function' && typeof (value as DecimalValue).toFixed === 'function';
}

/**
 * `decimal` as a decimal.js `Decimal` or a big.js `Big`: `decimalCodec(Decimal)`. Encodes with `toFixed()`, because
 * `toJSON()` switches to exponent notation (`'1e+21'`, `'1e-7'`) and the server's `decimal` format rejects it.
 */
export function decimalCodec<D extends DecimalValue>(Decimal: new (value: string) => D): Codec<D> {
  return {
    decode(wire) {
      if (typeof wire !== 'string' || !NUMBER_TEXT.test(wire)) throw new TypeError(`decimalCodec: ${JSON.stringify(wire)} is not decimal text`);
      try {
        return new Decimal(wire);
      } catch {
        throw new TypeError(`decimalCodec: ${JSON.stringify(wire)} is not decimal text`);
      }
    },
    encode(value) {
      if (!isDecimalValue(value)) return value;
      const text = value.toFixed();
      if (!/^-?[0-9]/.test(text)) throw new TypeError(`decimalCodec: cannot encode ${text}`);
      return text;
    },
  };
}

/** `int64` as a `bigint`. */
export const bigintCodec: Codec<bigint> = {
  decode(wire) {
    if (typeof wire !== 'string' || !/^-?[0-9]+$/.test(wire)) throw new TypeError(`bigintCodec: ${JSON.stringify(wire)} is not integer text`);
    return BigInt(wire);
  },
  encode(value) {
    return typeof value === 'bigint' ? value.toString() : value;
  },
};
