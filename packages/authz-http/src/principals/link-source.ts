import { DI, Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { Config } from '@spinajs/configuration';

import { PrincipalSource } from '../api.js';
import type { LinksConfig } from '../http-config.js';
import '../storage.js';

/**
 * Opens a share link (design §6.1.6): the principal of the link a bearer token belongs to, with
 * `companion` (the request's own principal) speaking with it. An unknown, expired or revoked
 * token must yield a link principal that denies everything (`ceiling.resources: []`, reason
 * `link_invalid`), never null. authz-http cannot import the RBAC model that keeps links, so a
 * package or the app registers the implementation.
 */
export abstract class LinkResolver {
  abstract principal(token: string, companion?: Principal): Promise<Principal>;
}

/** The link principal when no LinkResolver is registered: it denies every check. */
export function deadLinkPrincipal(companion?: Principal): Principal {
  return Object.freeze({
    type: 'link',
    id: 'unresolved',
    authenticated: true,
    source: 'link',
    ...(companion ? { companions: Object.freeze([{ type: companion.type, id: companion.id }]) } : {}),
    ceiling: Object.freeze({ resources: Object.freeze([]), reason: 'link_invalid' }),
    attributes: Object.freeze({}),
  });
}

/**
 * A link token in the request (`authz.http.links`: query parameter, header or cookie, each
 * optional) replaces the principal the earlier sources found, which becomes its companion
 * (order 110, design §11.1, B38). PrincipalMiddleware runs it after the first-non-null sources.
 */
@Injectable(PrincipalSource)
export class LinkPrincipalSource extends PrincipalSource {
  public readonly name = 'link' as const;
  public readonly order = 110 as const;

  @Logger('authz-http')
  protected Log: Log;

  @Config('authz.http.links')
  protected Links: LinksConfig;

  // Warned once: any request can carry a token, so a warning per request would let anyone flood the log.
  private warned = false;

  public async authenticate(req: Request): Promise<Principal | null> {
    const token = this.token(req);
    if (token === undefined) {
      return null;
    }

    const companion = req.storage?.Principal;
    if ((DI.getRegisteredTypes(LinkResolver) ?? []).length === 0) {
      if (!this.warned) this.Log.warn('a request carries a share link token, but no LinkResolver is registered; links deny everything');
      this.warned = true;
      return deadLinkPrincipal(companion);
    }

    const resolver = (await DI.resolve(LinkResolver)) as LinkResolver;
    return resolver.principal(token, companion);
  }

  protected token(req: Request): string | undefined {
    const { query, header, cookie } = this.Links;
    const pick = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
    return (
      (query !== null ? pick(req.query?.[query]) : undefined) ??
      (header !== null ? pick(req.headers?.[header.toLowerCase()]) : undefined) ??
      (cookie !== null ? pick((req.signedCookies as Record<string, unknown> | undefined)?.[cookie] ?? (req.cookies as Record<string, unknown> | undefined)?.[cookie]) : undefined)
    );
  }
}
