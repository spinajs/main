import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Middleware } from '../decorators.js';
import { RouteMiddleware } from '../interfaces.js';
import type { IController, IReplyContext, IRoute } from '../interfaces.js';
import { overriddenByRoute } from './route-declaration.js';

export interface IDeprecationOptions {
  /** When the route was deprecated: `Deprecation: @<unix seconds>`; without it `Deprecation: true`. */
  since?: Date;
  /** When the route stops answering: `Sunset: <HTTP-date>` (RFC 8594). */
  sunset?: Date;
  /** A page about the deprecation: `Link: <link>; rel="deprecation"`. */
  link?: string;
}

interface IDeprecationHeaders {
  readonly deprecation: string;
  readonly sunset?: string;
  readonly link?: string;
}

function validDate(name: string, value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidArgument(`@Deprecated ${name} must be a valid Date`);
  }
  return value;
}

function deprecationHeaders(options: IDeprecationOptions): IDeprecationHeaders {
  const since = options.since === undefined ? undefined : validDate('since', options.since);
  const sunset = options.sunset === undefined ? undefined : validDate('sunset', options.sunset);
  if (since && sunset && sunset.getTime() < since.getTime()) {
    throw new InvalidArgument('@Deprecated sunset must not be before since');
  }
  if (options.link !== undefined && (typeof options.link !== 'string' || options.link.trim() === '' || /[<>\s]/.test(options.link))) {
    throw new InvalidArgument('@Deprecated link must be a URI without spaces or angle brackets');
  }
  return {
    deprecation: since ? `@${Math.floor(since.getTime() / 1000)}` : 'true',
    ...(sunset ? { sunset: sunset.toUTCString() } : {}),
    ...(options.link !== undefined ? { link: `<${options.link}>; rel="deprecation"` } : {}),
  };
}

/**
 * Marks every reply of the route, error replies included, as deprecated: `Deprecation` (RFC 9745), `Sunset` (RFC 8594)
 * and `Link: <link>; rel="deprecation"`, each when given. Mounted by {@link Deprecated}; a route's own declaration
 * replaces the controller's.
 */
@NewInstance()
@Injectable(RouteMiddleware)
export class DeprecationMiddleware extends RouteMiddleware {
  protected readonly headers: IDeprecationHeaders;

  constructor(protected readonly options: IDeprecationOptions = {}) {
    super();
    this.headers = deprecationHeaders(options);
  }

  public override isEnabled(route: IRoute, _controller: IController): boolean {
    return !overriddenByRoute(route, DeprecationMiddleware, this.options);
  }

  public onAfter({ res, response }: IReplyContext): void {
    res.setHeader('Deprecation', this.headers.deprecation);
    if (this.headers.sunset) {
      res.setHeader('Sunset', this.headers.sunset);
    }
    if (this.headers.link) {
      // a hook's header replaces the answer's own one of the same name, so a Link the answer set is joined here
      const own = response.headers.find((h) => h.Name.toLowerCase() === 'link');
      if (own) {
        response.setHeader('Link', [...(Array.isArray(own.Value) ? own.Value : [String(own.Value)]), this.headers.link].join(', '));
      } else {
        res.append('Link', this.headers.link);
      }
    }
  }
}

/**
 * Announces that the route, or on a class every route of the controller, is deprecated: see {@link DeprecationMiddleware}.
 * The options are checked here, so a wrong one fails at import.
 *
 * ```ts
 * @Get()
 * @Deprecated({ since: new Date('2026-01-01'), sunset: new Date('2026-12-31'), link: 'https://example.com/v2' })
 * public list() { ... }
 * ```
 */
export function Deprecated(options: IDeprecationOptions = {}) {
  deprecationHeaders(options);
  return Middleware(DeprecationMiddleware, options);
}
