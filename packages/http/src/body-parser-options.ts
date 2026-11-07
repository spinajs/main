import express from 'express';
import type cookieParser from 'cookie-parser';

export type BodyParserKind = 'json' | 'urlencoded' | 'text' | 'cookies';

interface IParserSwitch {
  /** Default true. */
  enabled?: boolean;
}

export type JsonBodyParserOptions = IParserSwitch & NonNullable<Parameters<typeof express.json>[0]>;
export type UrlencodedBodyParserOptions = IParserSwitch & NonNullable<Parameters<typeof express.urlencoded>[0]>;
export type TextBodyParserOptions = IParserSwitch & NonNullable<Parameters<typeof express.text>[0]>;
export type CookieParserOptions = IParserSwitch & cookieParser.CookieParseOptions;

/** `http.bodyParsers`: options of the built-in parsers, passed on to express / cookie-parser. */
export interface IBodyParsersConfiguration {
  json?: JsonBodyParserOptions;
  urlencoded?: UrlencodedBodyParserOptions;
  text?: TextBodyParserOptions;
  cookies?: CookieParserOptions;
}

const DEFAULTS: Required<IBodyParsersConfiguration> = {
  json: { limit: '5mb' },
  urlencoded: { extended: true },
  text: { type: ['application/xml', 'text/xml', 'application/*+xml'], limit: '5mb' },
  cookies: {},
};

/** The shipped defaults of one parser with `http.bodyParsers.<kind>` merged over them. */
export function effectiveParserOptions<K extends BodyParserKind>(config: IBodyParsersConfiguration | undefined, kind: K): Required<IBodyParsersConfiguration>[K] {
  return { ...DEFAULTS[kind], ...(config?.[kind] ?? {}) };
}

/** `express.json()` that keeps the bytes in `req.rawBody` before the configured `verify` runs. */
export function jsonParser(options: JsonBodyParserOptions): express.RequestHandler {
  const { enabled: _enabled, ...rest } = options;
  return express.json({
    ...rest,
    // @RawBody() and webhook signature checks need the unmodified bytes
    verify: (req, res, buf, encoding) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
      options.verify?.(req, res, buf, encoding);
    },
  });
}

export function urlencodedParser(options: UrlencodedBodyParserOptions): express.RequestHandler {
  const { enabled: _enabled, ...rest } = options;
  return express.urlencoded(rest);
}

export function textParser(options: TextBodyParserOptions): express.RequestHandler {
  const { enabled: _enabled, ...rest } = options;
  return express.text(rest);
}
