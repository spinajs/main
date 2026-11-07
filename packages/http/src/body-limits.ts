import type express from 'express';
import { InvalidOption } from '@spinajs/exceptions';

import { EntityTooLargeException } from './exceptions.js';
import { effectiveParserOptions, jsonParser, textParser, urlencodedParser } from './body-parser-options.js';
import type { IBodyParsersConfiguration } from './body-parser-options.js';

/**
 * A body size limit for every request under `path`. See `http.bodyLimits`.
 */
export interface IBodyLimitRule {
  /** Path prefix matched against the request path, on a segment boundary and case-insensitively */
  path: string;

  /** Size in the body-parser notation: `512b`, `16kb`, `1.5mb`, `1gb` */
  limit: string;
}

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

export function parseBodyLimit(limit: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(limit);
  if (!m) {
    throw new InvalidOption(`http.bodyLimits: ${limit} is not a size such as 16kb or 1mb`);
  }
  return Math.floor(parseFloat(m[1]) * UNITS[(m[2] ?? 'b').toLowerCase()]);
}

// Express matches routes case-insensitively, so a rule must too.
const underPath = (path: string, prefix: string): boolean => {
  const p = path.toLowerCase();
  const r = prefix.toLowerCase().replace(/\/+$/, '');
  return r === '' || p === r || p.startsWith(`${r}/`);
};

const isTooLarge = (err: unknown): boolean => (err as { type?: string } | null)?.type === 'entity.too.large';

function chain(handlers: express.RequestHandler[]): express.RequestHandler {
  return (req, res, next) => {
    let i = 0;
    const step = (err?: unknown) => {
      if (err) {
        next(isTooLarge(err) ? new EntityTooLargeException('request body is too large') : err);
        return;
      }
      const handler = handlers[i++];
      if (!handler) {
        next();
        return;
      }
      void handler(req, res, step);
    };
    step();
  };
}

export interface IBodyLimitOptions {
  /** `http.bodyParsers`: each rule parses with these options, only `limit` replaced. A parser with `enabled: false` is skipped. */
  parsers?: IBodyParsersConfiguration;

  /** Called once, for the first request under a rule whose body something read before the limit could check it. */
  onReadEarly?: (req: express.Request) => void;
}

// body-parser 1.x flags a read body with `_body`; a stream read to its end (body-parser 2.x, raw readers) has ended.
const alreadyRead = (req: express.Request): boolean => (req as { _body?: boolean })._body === true || req.readableEnded;

/**
 * Parses the body of requests under a `http.bodyLimits` path with that path's limit, before the body parsers run;
 * they skip a body that is already read. The first matching rule wins. Returns null with no rules.
 *
 * A declared `Content-Length` over the limit answers 413 for any content type. JSON, urlencoded and text bodies are
 * parsed here with the `http.bodyParsers` options (types, `verify`, `req.rawBody`), only the limit replaced. A body
 * something read before this gate answers 413: its size can no longer be bounded.
 */
export function createBodyLimitMiddleware(rules: readonly IBodyLimitRule[], options: IBodyLimitOptions = {}): express.RequestHandler | null {
  if (rules.length === 0) {
    return null;
  }

  const json = effectiveParserOptions(options.parsers, 'json');
  const urlencoded = effectiveParserOptions(options.parsers, 'urlencoded');
  const text = effectiveParserOptions(options.parsers, 'text');

  const parsers = rules.map((rule) => {
    const bytes = parseBodyLimit(rule.limit);
    return {
      rule,
      bytes,
      parse: chain([
        ...(json.enabled === false ? [] : [jsonParser({ ...json, limit: bytes })]),
        ...(urlencoded.enabled === false ? [] : [urlencodedParser({ ...urlencoded, limit: bytes })]),
        ...(text.enabled === false ? [] : [textParser({ ...text, limit: bytes })]),
      ]),
    };
  });

  let reportedEarlyRead = false;

  return (req, res, next) => {
    const match = parsers.find((p) => underPath(req.path, p.rule.path));
    if (!match) {
      next();
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > match.bytes) {
      next(new EntityTooLargeException('request body is too large'));
      return;
    }

    if (alreadyRead(req)) {
      if (!reportedEarlyRead) {
        reportedEarlyRead = true;
        options.onReadEarly?.(req);
      }
      next(new EntityTooLargeException('request body was read before http.bodyLimits could check it'));
      return;
    }

    match.parse(req, res, next);
  };
}
