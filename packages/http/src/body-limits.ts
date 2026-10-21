import express from 'express';
import { InvalidOption } from '@spinajs/exceptions';

import { EntityTooLargeException } from './exceptions.js';

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

/**
 * Parses the body of requests under a `http.bodyLimits` path with that path's limit, before the `http.middlewares`
 * parsers run; they skip a body that is already read. The first matching rule wins. Returns null with no rules.
 *
 * A declared `Content-Length` over the limit answers 413 for any content type. JSON, urlencoded and XML text are
 * parsed here, so the JSON parser's `verify` of `http.middlewares` does not run for them; `req.rawBody` is still set.
 */
export function createBodyLimitMiddleware(rules: readonly IBodyLimitRule[]): express.RequestHandler | null {
  if (rules.length === 0) {
    return null;
  }

  const parsers = rules.map((rule) => {
    const bytes = parseBodyLimit(rule.limit);
    return {
      rule,
      bytes,
      parse: chain([
        express.json({
          limit: bytes,
          verify: (req, _res, buf) => {
            (req as { rawBody?: Buffer }).rawBody = buf;
          },
        }),
        express.urlencoded({ extended: true, limit: bytes }),
        express.text({ type: ['application/xml', 'text/xml', 'application/*+xml'], limit: bytes }),
      ]),
    };
  });

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

    match.parse(req, res, next);
  };
}
