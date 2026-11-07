import express from 'express';
import cookieParser from 'cookie-parser';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware } from '../interfaces.js';
import { createBodyLimitMiddleware } from '../body-limits.js';
import type { IBodyLimitRule } from '../body-limits.js';
import { EntityTooLargeException } from '../exceptions.js';

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

// The function names of the handlers express.json() / .urlencoded() / .text() and cookie-parser return, and of the
// cookie parser 3.x shipped in http.middlewares.
const HANDLER_NAMES: Record<string, BodyParserKind> = {
  jsonParser: 'json',
  urlencodedParser: 'urlencoded',
  textParser: 'text',
  cookieParser: 'cookies',
  configuredCookieParser: 'cookies',
};

/** The parsers an `http.middlewares` list mounts itself, by kind, with the handler's function name. */
export function parsersHeldBy(list: readonly unknown[] | undefined): Map<BodyParserKind, string> {
  const held = new Map<BodyParserKind, string>();
  for (const handler of list ?? []) {
    const name = typeof handler === 'function' ? handler.name : undefined;
    const kind = name ? HANDLER_NAMES[name] : undefined;
    if (kind && !held.has(kind)) held.set(kind, name!);
  }
  return held;
}

/** Whether `http.middlewares` parses bodies itself, so `http.bodyLimits` must run before it, as in 3.x. */
export function holdsBodyParser(list: readonly unknown[] | undefined): boolean {
  const held = parsersHeldBy(list);
  return held.has('json') || held.has('urlencoded') || held.has('text');
}

const isTooLarge = (err: unknown): boolean => (err as { type?: string } | null)?.type === 'entity.too.large';

abstract class BuiltInParser<O extends IParserSwitch> extends ServerMiddleware {
  protected abstract readonly Kind: BodyParserKind;

  protected abstract readonly Defaults: O;

  @Config('http.bodyParsers', { defaultValue: {} })
  protected ParsersConfig!: IBodyParsersConfiguration;

  @Config('http.middlewares', { defaultValue: [] })
  protected RawMiddlewares!: unknown[];

  @Logger('http')
  protected Log!: Log;

  constructor() {
    super();
    this.Order = 3.5;
  }

  protected get Options(): O {
    return { ...this.Defaults, ...((this.ParsersConfig?.[this.Kind] ?? {}) as O) };
  }

  public isEnabled(): boolean {
    if (this.Options.enabled === false) {
      return false;
    }

    const held = parsersHeldBy(this.RawMiddlewares).get(this.Kind);
    if (held) {
      this.Log.warn(
        { middleware: this.constructor.name, handler: held, key: `http.bodyParsers.${this.Kind}` },
        'http.middlewares holds ${handler}, so the built-in ${middleware} is not mounted and that handler runs before every server middleware. Remove it and configure ${key} instead.',
      );
      return false;
    }
    return true;
  }

  protected abstract parser(options: Omit<O, 'enabled'>): express.RequestHandler;

  public handler(): express.RequestHandler {
    const { enabled: _enabled, ...options } = this.Options;
    const parse = this.parser(options);
    return (req, res, next) => parse(req, res, (err?: unknown) => next(isTooLarge(err) ? new EntityTooLargeException('request body is too large') : err));
  }
}

/** `express.json()` at Order 3.5 with `http.bodyParsers.json` (default limit 5mb); keeps the bytes in `req.rawBody`. */
@Injectable(ServerMiddleware)
export class JsonBodyParser extends BuiltInParser<JsonBodyParserOptions> {
  protected readonly Kind = 'json';

  protected readonly Defaults: JsonBodyParserOptions = { limit: '5mb' };

  protected parser(options: JsonBodyParserOptions): express.RequestHandler {
    return express.json({
      ...options,
      // @RawBody() and webhook signature checks need the unmodified bytes
      verify: (req, res, buf, encoding) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
        options.verify?.(req, res, buf, encoding);
      },
    });
  }
}

/** `express.urlencoded()` at Order 3.5 with `http.bodyParsers.urlencoded` (default extended). */
@Injectable(ServerMiddleware)
export class UrlencodedBodyParser extends BuiltInParser<UrlencodedBodyParserOptions> {
  protected readonly Kind = 'urlencoded';

  protected readonly Defaults: UrlencodedBodyParserOptions = { extended: true };

  protected parser(options: UrlencodedBodyParserOptions): express.RequestHandler {
    return express.urlencoded(options);
  }
}

/** `express.text()` at Order 3.5 with `http.bodyParsers.text`: XML bodies as text for `@FromXml()` (default limit 5mb). */
@Injectable(ServerMiddleware)
export class TextBodyParser extends BuiltInParser<TextBodyParserOptions> {
  protected readonly Kind = 'text';

  protected readonly Defaults: TextBodyParserOptions = { type: ['application/xml', 'text/xml', 'application/*+xml'], limit: '5mb' };

  protected parser(options: TextBodyParserOptions): express.RequestHandler {
    return express.text(options);
  }
}

/**
 * cookie-parser with `http.cookie.secret` (signed cookies need it) and `http.bodyParsers.cookies`. Order 0.5, not with
 * the body parsers: `IntlHttpMiddleware` (Order 1) reads the language cookie, and parsing cookies cannot fail.
 */
@Injectable(ServerMiddleware)
export class CookieParserMiddleware extends BuiltInParser<CookieParserOptions> {
  protected readonly Kind = 'cookies';

  protected readonly Defaults: CookieParserOptions = {};

  @Config('http.cookie.secret')
  protected Secret?: string;

  constructor() {
    super();
    this.Order = 0.5;
  }

  protected parser(options: CookieParserOptions): express.RequestHandler {
    return cookieParser(this.Secret, options);
  }
}

/**
 * `http.bodyLimits` at Order 3.4, just before the body parsers: a request under a rule's path is parsed here with that
 * limit and the parsers skip it. When `http.middlewares` still holds a body parser, `HttpServer` mounts the limits
 * before that list instead, as in 3.x.
 */
@Injectable(ServerMiddleware)
export class BodyLimits extends ServerMiddleware {
  @Config('http.bodyLimits', { defaultValue: [] })
  protected Rules!: IBodyLimitRule[];

  @Config('http.middlewares', { defaultValue: [] })
  protected RawMiddlewares!: unknown[];

  constructor() {
    super();
    this.Order = 3.4;
  }

  public isEnabled(): boolean {
    return (this.Rules ?? []).length > 0 && !holdsBodyParser(this.RawMiddlewares);
  }

  public handler(): express.RequestHandler | null {
    return createBodyLimitMiddleware(this.Rules ?? []);
  }
}
