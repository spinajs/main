/** Converts the wire value of one schema format to the app's type and back. */
export interface Codec<T> {
  decode(wire: unknown): T;
  encode(value: T): unknown;
}

/** The format slots a codec can fill, each typed as the app value for that format. */
export interface Formats {
  'date-time'?: unknown;
  date?: unknown;
  decimal?: unknown;
  int64?: unknown;
}

export type PlainFormats = { 'date-time': string; date: string; decimal: string; int64: string };

export type FormatCodecs = { [K in keyof Formats]?: Codec<unknown> };

type SlotType<S, Wire> = [S] extends [Codec<infer T> | undefined] ? (undefined extends S ? T | Wire : T) : Wire;

/**
 * The app type of every format slot for the given codecs: the codec's type, else the wire string. A slot that may be
 * unset (an optional key, or a variable typed `FormatCodecs`) is typed as either; pass `formats` as a literal to get
 * the codec's type alone. A generic `F extends FormatCodecs` inferred from an omitted `formats` falls back to
 * `FormatCodecs` and types every slot `unknown`, so a signature taking optional `formats` must default `F` to `{}`.
 */
export type FormatTypes<C extends FormatCodecs> = {
  [K in keyof PlainFormats]: K extends keyof C ? SlotType<C[K], PlainFormats[K]> : PlainFormats[K];
};

export const dateCodec: Codec<Date> = {
  decode(wire) {
    const date = typeof wire === 'string' ? new Date(wire) : undefined;
    if (!date || Number.isNaN(date.getTime())) throw new TypeError(`dateCodec: ${JSON.stringify(wire)} is not date-time text`);
    return date;
  },
  encode(value) {
    if (!(value instanceof Date)) return value;
    if (Number.isNaN(value.getTime())) throw new TypeError('dateCodec: cannot encode an invalid Date');
    return value.toISOString();
  },
};
