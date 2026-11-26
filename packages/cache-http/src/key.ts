import { createHash } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { idempotencyScopeParts } from '@spinajs/http';
import type { IActionLocalStoregeContext, IdempotencyScopePart } from '@spinajs/http';
import { ceilingHash, principalKey } from '@spinajs/principal';
import type { AuthnFacts, Principal } from '@spinajs/principal';
import type { ResponseCacheScope } from './options.js';

/**
 * A value of the request's store that a reply depends on, put into the key of every stored reply. An application
 * registers one with `@Injectable(ResponseCacheKeyPart)`; this package registers `LanguageKeyPart`.
 */
export abstract class ResponseCacheKeyPart {
  /** undefined adds nothing. A part names its kind (`lang:pl`), so parts of two kinds never meet. */
  public abstract partOf(storage: IActionLocalStoregeContext): string | undefined;
}

/** The language `@spinajs/intl-http` detected, from whatever header, cookie or query it read it. */
@Injectable(ResponseCacheKeyPart)
export class LanguageKeyPart extends ResponseCacheKeyPart {
  public partOf(storage: IActionLocalStoregeContext): string | undefined {
    return 'language' in storage && typeof storage.language === 'string' ? `lang:${storage.language}` : undefined;
  }
}

/** Sorted: the key must not depend on the order the parts were registered in. */
export function keyPartsOf(parts: readonly ResponseCacheKeyPart[], storage: IActionLocalStoregeContext): string[] {
  return parts
    .map((part) => part.partOf(storage))
    .filter((part): part is string => part !== undefined)
    .sort();
}

type Check = (value: unknown) => boolean;
const read = (value: object, name: string): unknown => Reflect.get(value, name);
const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
const isText: Check = (value) => typeof value === 'string';
const absentOr = (check: Check): Check => (value) => value == null || check(value);
const listOf = (check: Check): Check => (value) => Array.isArray(value) && value.every(check);
const isRef: Check = (value) => isObject(value) && isText(read(value, 'type')) && isText(read(value, 'id'));
const isCeiling: Check = (value) =>
  isObject(value) &&
  absentOr(listOf(isText))(read(value, 'roles')) &&
  absentOr(listOf(isText))(read(value, 'permissions')) &&
  absentOr(listOf((r) => isObject(r) && isText(read(r, 'type')) && absentOr(isText)(read(r, 'id'))))(read(value, 'resources')) &&
  absentOr((date) => date instanceof Date)(read(value, 'expiresAt')) &&
  absentOr(isText)(read(value, 'reason'));
const isSignIn: Check = (value) => isObject(value) && ['method', 'strategy', 'assurance'].every((name) => isText(read(value, name))) && listOf(isText)(read(value, 'mfa')) && absentOr(isRef)(read(value, 'impersonator'));

// every field responsePrincipal reads, so a malformed principal gets no key instead of a TypeError or a half-read key
function isPrincipal(value: unknown, outer: readonly object[] = []): value is Principal {
  if (!isRef(value) || !isObject(value) || outer.includes(value) || typeof read(value, 'authenticated') !== 'boolean') return false;
  const onBehalfOf = read(value, 'onBehalfOf');
  return (
    (onBehalfOf == null || isPrincipal(onBehalfOf, [...outer, value])) &&
    absentOr(isText)(read(value, 'delegation')) &&
    absentOr(isCeiling)(read(value, 'ceiling')) &&
    absentOr(isSignIn)(read(value, 'authn')) &&
    absentOr(listOf(isRef))(read(value, 'companions'))
  );
}

/** The principal `@spinajs/authz-http` resolved for the request (`req.storage.Principal`), when there is one. */
export function principalIn(storage: IActionLocalStoregeContext): Principal | undefined {
  if (!('Principal' in storage)) return undefined;
  const principal: unknown = storage.Principal;
  return isPrincipal(principal) ? principal : undefined;
}

// policy conditions may read principal.authn.*, so a step-up sign-in may see more than the same identity without it
const signIn = (authn: AuthnFacts | undefined): unknown[] | null => (authn ? [authn.method, authn.strategy, authn.assurance, [...authn.mfa].sort()] : null);

/**
 * The principal part of a reply's key: the identity with the authority it speaks with, so a reply stored for one
 * credential of an identity never reaches a narrower one. The restriction rule of `idempotencyPrincipal` of
 * `@spinajs/idempotency` (not a dependency), plus the sign-in facts policies read.
 */
export function responsePrincipal(principal: Principal): string {
  return JSON.stringify([
    principalKey(principal),
    ceilingHash(principal.ceiling),
    principal.onBehalfOf ? responsePrincipal(principal.onBehalfOf) : null,
    principal.onBehalfOf ? (principal.delegation ?? 'intersect') : null,
    principal.authn?.impersonator ? principalKey(principal.authn.impersonator) : null,
    principal.companions?.length ? principal.companions.map(principalKey).sort() : null,
    signIn(principal.authn),
  ]);
}

/** '' on a wider scope; undefined when a per-principal request has no authenticated principal and so has no key. */
function principalPart(scope: ResponseCacheScope, storage: IActionLocalStoregeContext): string | undefined {
  if (scope !== 'principal') return '';
  const principal = principalIn(storage);
  // authz-http's anonymous principal is every caller without credentials, not one caller
  return principal?.authenticated === true ? responsePrincipal(principal) : undefined;
}

export interface ResponseCacheRoute {
  /** `responseCacheNamespace(route type, mounted path)` */
  readonly namespace: string;
  readonly scope: ResponseCacheScope;
  /** The request headers the route names in `vary`. */
  readonly vary: readonly string[];
}

/** The parts of an http request the key reads; an express request is one. */
export interface ResponseCacheRequest {
  /** Path and query as sent. */
  readonly originalUrl: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export const responseCacheNamespace = (routeType: string, path: string): string => `http:${routeType.toUpperCase()} ${path}`;

// hashKey of @spinajs/cache serializes with node:v8, which writes one string as other bytes when V8 holds it two-byte
const digest = (parts: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('base64url');

/**
 * The key of a stored reply, inside its cache, besides the `CacheScope` segments the cache adds. Two requests share it
 * only when the route, the scope, the principal part, the URL as sent, `Accept`, `x-data-transform`, the `vary` headers,
 * the `IdempotencyScopePart` parts (the tenant) and the `ResponseCacheKeyPart` parts are all equal. undefined: the
 * request must run uncached. The request method is not in it, so a HEAD request is answered from a GET reply.
 */
export function responseCacheKey(route: ResponseCacheRoute, req: ResponseCacheRequest, storage: IActionLocalStoregeContext, scopeParts: readonly IdempotencyScopePart[], keyParts: readonly ResponseCacheKeyPart[]): string | undefined {
  const principal = principalPart(route.scope, storage);
  if (principal === undefined) return undefined;
  const header = (name: string): string | readonly string[] | null => req.headers[name.toLowerCase()] ?? null;
  return digest([
    route.namespace,
    route.scope,
    principal,
    req.originalUrl,
    header('accept'),
    // http picks the data transformer of a JSON reply from this header
    header('x-data-transform'),
    route.vary.map((name) => [name.toLowerCase(), header(name)]),
    idempotencyScopeParts(scopeParts, storage),
    keyPartsOf(keyParts, storage),
  ]);
}
