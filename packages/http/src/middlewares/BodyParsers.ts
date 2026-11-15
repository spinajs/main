import express from 'express';
import cookieParser from 'cookie-parser';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

import { ServerMiddleware } from '../interfaces.js';
import { createBodyLimitMiddleware } from '../body-limits.js';
import type { IBodyLimitRule } from '../body-limits.js';
import { EntityTooLargeException } from '../exceptions.js';
import { shippedHandlerName } from '../default-middlewares.js';
import { effectiveParserOptions, jsonParser, textParser, urlencodedParser } from '../body-parser-options.js';
import type {
  BodyParserKind,
  CookieParserOptions,
  IBodyParsersConfiguration,
  JsonBodyParserOptions,
  TextBodyParserOptions,
  UrlencodedBodyParserOptions,
} from '../body-parser-options.js';

export type {
  BodyParserKind,
  CookieParserOptions,
  IBodyParsersConfiguration,
  JsonBodyParserOptions,
  TextBodyParserOptions,
  UrlencodedBodyParserOptions,
} from '../body-parser-options.js';

// The source text of the handlers express.json() / .urlencoded() / .text() and cookie-parser return is the same
// for every call, whatever the options; a function of the app that only shares the name does not match.
const PARSER_SOURCES = new Map<string, BodyParserKind>([
  [express.json().toString(), 'json'],
  [express.urlencoded().toString(), 'urlencoded'],
  [express.text().toString(), 'text'],
  [cookieParser().toString(), 'cookies'],
]);

function handlersOf(list: readonly unknown[] | undefined): unknown[] {
  return (list ?? []).flatMap((entry) => (Array.isArray(entry) ? handlersOf(entry) : [entry]));
}

/**
 * The parsers an `http.middlewares` list (nested arrays included) mounts itself, by kind, with the handler's name:
 * express's and cookie-parser's own handlers, and the `configuredCookieParser` 3.x shipped. A parser wrapped in
 * another function is not recognised.
 */
export function parsersHeldBy(list: readonly unknown[] | undefined): Map<BodyParserKind, string> {
  const held = new Map<BodyParserKind, string>();
  for (const handler of handlersOf(list)) {
    if (typeof handler !== 'function') continue;
    const kind = shippedHandlerName(handler) === 'cookie parser' ? 'cookies' : PARSER_SOURCES.get(handler.toString());
    if (kind && !held.has(kind)) held.set(kind, handler.name || 'anonymous');
  }
  return held;
}

/**
 * Whether `http.bodyLimits` must run before `http.middlewares`: the list holds a handler `@spinajs/http` did not
 * ship (only helmet and `configuredCookieParser` are tagged), which might read the body.
 */
export function limitsBeforeMiddlewares(list: readonly unknown[] | undefined): boolean {
  return handlersOf(list).some((handler) => shippedHandlerName(handler) === undefined);
}

const isTooLarge = (err: unknown): boolean => (err as { type?: string } | null)?.type === 'entity.too.large';

const named = (handler: express.RequestHandler, name: string): express.RequestHandler => {
  Object.defineProperty(handler, 'name', { value: name });
  return handler;
};

abstract class BuiltInParser<O extends { enabled?: boolean }> extends ServerMiddleware {
  protected abstract readonly Kind: BodyParserKind;

  @Config('http.bodyParsers', { defaultValue: {} })
  protected ParsersConfig!: IBodyParsersConfiguration;

  @Config('http.middlewares', { defaultValue: [] })
  protected RawMiddlewares!: unknown[];

  @Logger('http')
  protected Log!: Log;

  private enabled?: boolean;

  constructor() {
    super();
    this.Order = 3.5;
  }

  protected get Options(): O {
    return effectiveParserOptions(this.ParsersConfig, this.Kind) as O;
  }

  public isEnabled(): boolean {
    this.enabled ??= this.decideEnabled();
    return this.enabled;
  }

  private decideEnabled(): boolean {
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

  protected abstract parser(options: O): express.RequestHandler;

  public handler(): express.RequestHandler {
    const parse = this.parser(this.Options);
    return named(
      (req, res, next) => parse(req, res, (err?: unknown) => next(isTooLarge(err) ? new EntityTooLargeException('request body is too large') : err)),
      this.constructor.name,
    );
  }
}

/** `express.json()` at Order 3.5 with `http.bodyParsers.json` (default limit 5mb); keeps the bytes in `req.rawBody`. */
@Injectable(ServerMiddleware)
export class JsonBodyParser extends BuiltInParser<JsonBodyParserOptions> {
  protected readonly Kind = 'json';

  protected parser(options: JsonBodyParserOptions): express.RequestHandler {
    return jsonParser(options);
  }
}

/** `express.urlencoded()` at Order 3.5 with `http.bodyParsers.urlencoded` (default extended). */
@Injectable(ServerMiddleware)
export class UrlencodedBodyParser extends BuiltInParser<UrlencodedBodyParserOptions> {
  protected readonly Kind = 'urlencoded';

  protected parser(options: UrlencodedBodyParserOptions): express.RequestHandler {
    return urlencodedParser(options);
  }
}

/** `express.text()` at Order 3.5 with `http.bodyParsers.text`: XML bodies as text for `@FromXml()` (default limit 5mb). */
@Injectable(ServerMiddleware)
export class TextBodyParser extends BuiltInParser<TextBodyParserOptions> {
  protected readonly Kind = 'text';

  protected parser(options: TextBodyParserOptions): express.RequestHandler {
    return textParser(options);
  }
}

/**
 * cookie-parser with `http.cookie.secret` (signed cookies need it) and `http.bodyParsers.cookies`. Order 0.5, not with
 * the body parsers: `IntlHttpMiddleware` (Order 1) reads the language cookie, and parsing cookies cannot fail.
 */
@Injectable(ServerMiddleware)
export class CookieParserMiddleware extends BuiltInParser<CookieParserOptions> {
  protected readonly Kind = 'cookies';

  @Config('http.cookie.secret')
  protected Secret?: string;

  constructor() {
    super();
    this.Order = 0.5;
  }

  protected parser({ enabled: _enabled, ...options }: CookieParserOptions): express.RequestHandler {
    return cookieParser(this.Secret, options);
  }
}

/**
 * `http.bodyLimits` at Order 3.4, just before the body parsers: a request under a rule's path is parsed here with that
 * limit and the `http.bodyParsers` options, and the parsers skip it. A body something read earlier answers 413. When
 * `http.middlewares` holds a handler the package did not ship, `HttpServer` mounts the limits before that list instead.
 */
@Injectable(ServerMiddleware)
export class BodyLimits extends ServerMiddleware {
  @Config('http.bodyLimits', { defaultValue: [] })
  protected Rules!: IBodyLimitRule[];

  @Config('http.bodyParsers', { defaultValue: {} })
  protected ParsersConfig!: IBodyParsersConfiguration;

  @Config('http.middlewares', { defaultValue: [] })
  protected RawMiddlewares!: unknown[];

  @Logger('http')
  protected Log!: Log;

  constructor() {
    super();
    this.Order = 3.4;
  }

  public isEnabled(): boolean {
    return (this.Rules ?? []).length > 0 && !limitsBeforeMiddlewares(this.RawMiddlewares);
  }

  public handler(): express.RequestHandler | null {
    const limits = createBodyLimitMiddleware(this.Rules ?? [], {
      parsers: this.ParsersConfig,
      onReadEarly: (req) =>
        this.Log.warn(
          { path: req.path },
          'A server middleware below Order 3.4 read the body of ${path} before http.bodyLimits could check it; such requests answer 413. Leave body parsing to http.bodyParsers.',
        ),
    });
    return limits && named(limits, this.constructor.name);
  }
}
