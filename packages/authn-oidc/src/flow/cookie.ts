import { createHash, randomBytes } from 'node:crypto';

import { checkedUrl, isPlainObject, isRelaxedEnv } from '../support.js';
import { OIDC_APP_PATH_PATTERN, OIDC_PROVIDER_NAME_PATTERN } from '../options/schema.js';

/**
 * The flow cookie (D1). It carries a random seed and the flow's bindings; state, nonce and the PKCE verifier are
 * derived from it, and state also covers every other member. The cookie needs no server key: it grants nothing
 * without the provider's code, and a changed cookie yields a state the provider never saw.
 */
export interface OidcFlow {
  readonly v: 1;
  /** The provider name (not the strategy name). */
  readonly p: string;
  /** 32 random bytes, base64url. */
  readonly s: string;
  /** Issued at, unix seconds. */
  readonly t: number;
  /** App-relative path to return to after a login, or null. */
  readonly r: string | null;
  /** The redirect_uri sent to the provider, sent again to the token endpoint. */
  readonly u: string;
  readonly m: 'login' | 'link';
  /** Link flows only: SHA-256 hex of the raw id of the session that started it. */
  readonly h?: string;
}

export interface OidcFlowSecrets {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

export const OIDC_FLOW_TTL_SECONDS = 600;
/** How far in the future a flow's issue time may be (clock steps between instances). */
export const OIDC_FLOW_FUTURE_SKEW_SECONDS = 60;
export const OIDC_FLOW_COOKIE_BASE_NAME = 'spinajs-oidc';
export const OIDC_FLOW_COOKIE_MAX_LENGTH = 2048;
const RETURN_TO_MAX_LENGTH = 1024;
const SEED_BYTES = 32;
const KEYS = ['v', 'p', 's', 't', 'r', 'u', 'm', 'h'];
const APP_PATH = new RegExp(OIDC_APP_PATH_PATTERN);
const B64URL_SEED = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]*$/;
const PROVIDER_NAME = new RegExp(OIDC_PROVIDER_NAME_PATTERN);

const b64urlSha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url');

export const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** RFC 7636 §4.2, S256. */
/** What a link flow stores of the session that started it: never the session store's own key (the plain SHA-256). */
export const sessionBindingOf = (rawSessionId: string): string => sha256hex(`spinajs-oidc:session\0${rawSessionId}`);

export const codeChallengeOf = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** A returnTo is kept only as an app-relative path (no open redirect). */
export function appPathOrNull(v: unknown): string | null {
  // Printable ASCII only, so a long multi-byte path cannot push the cookie over its read cap.
  return typeof v === 'string' && v.length <= RETURN_TO_MAX_LENGTH && APP_PATH.test(v) && PRINTABLE_ASCII.test(v) ? v : null;
}

/** Fixed member order, so the state does not depend on how a cookie was serialized. */
function canonical(f: OidcFlow): string {
  return JSON.stringify({ v: f.v, p: f.p, s: f.s, t: f.t, r: f.r, u: f.u, m: f.m, ...(f.h !== undefined ? { h: f.h } : {}) });
}

export function newFlow(input: { provider: string; redirectUri: string; returnTo?: unknown; mode: 'login' | 'link'; sessionHash?: string; now: Date }): OidcFlow {
  return Object.freeze({
    v: 1,
    p: input.provider,
    s: randomBytes(SEED_BYTES).toString('base64url'),
    t: Math.floor(input.now.getTime() / 1000),
    r: input.mode === 'login' ? appPathOrNull(input.returnTo) : null,
    u: input.redirectUri,
    m: input.mode,
    ...(input.sessionHash !== undefined ? { h: input.sessionHash } : {}),
  });
}

export function flowSecrets(f: OidcFlow): OidcFlowSecrets {
  const codeVerifier = b64urlSha256(`spinajs-oidc:pkce\0${f.s}`);
  return Object.freeze({
    state: b64urlSha256(`spinajs-oidc:state\0${canonical(f)}`),
    nonce: b64urlSha256(`spinajs-oidc:nonce\0${f.s}`),
    codeVerifier,
    codeChallenge: codeChallengeOf(codeVerifier),
  });
}

export const encodeFlow = (f: OidcFlow): string => Buffer.from(canonical(f), 'utf8').toString('base64url');

/** The flow in a cookie value, or null for anything malformed. */
export function decodeFlow(value: unknown): OidcFlow | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > OIDC_FLOW_COOKIE_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  let f: unknown;
  try {
    f = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(f) || Object.keys(f).some((k) => !KEYS.includes(k))) return null;
  const ok =
    f.v === 1 &&
    typeof f.p === 'string' &&
    PROVIDER_NAME.test(f.p) &&
    typeof f.s === 'string' &&
    B64URL_SEED.test(f.s) &&
    Number.isSafeInteger(f.t) &&
    (f.r === null || appPathOrNull(f.r) !== null) &&
    checkedUrl(f.u, { relaxed: true, query: true }) !== null &&
    (f.m === 'login' || f.m === 'link') &&
    (f.h === undefined || (typeof f.h === 'string' && SHA256_HEX.test(f.h))) &&
    (f.m === 'link') === (f.h !== undefined);
  return ok ? Object.freeze(f as unknown as OidcFlow) : null;
}

/** True while the flow is within its TTL at `now` and was not issued in the future. */
export function flowIsLive(f: OidcFlow, now: Date): boolean {
  const nowSeconds = now.getTime() / 1000;
  return f.t <= nowSeconds + OIDC_FLOW_FUTURE_SKEW_SECONDS && nowSeconds < f.t + OIDC_FLOW_TTL_SECONDS;
}

/** The single-use key of a state in NonceStore (≤ 160 chars) and when it may be forgotten. */
export function stateClaim(f: OidcFlow, state: string): { key: string; expiresAt: Date } {
  return { key: `oidc-state:${sha256hex(state)}`, expiresAt: new Date((f.t + OIDC_FLOW_TTL_SECONDS) * 1000) };
}

export interface FlowCookie {
  readonly Name: string;
  readonly Value: string;
  /** express cookie options; maxAge in ms. */
  readonly Options: Readonly<Record<string, unknown>>;
}

/** `__Host-` and Secure unless the env is development or test, as the session cookie. */
export function flowCookieName(env: string | undefined): string {
  return isRelaxedEnv(env) ? OIDC_FLOW_COOKIE_BASE_NAME : `__Host-${OIDC_FLOW_COOKIE_BASE_NAME}`;
}

function options(env: string | undefined, maxAgeMs: number): Record<string, unknown> {
  // Lax, not Strict: the callback is a cross-site top-level GET from the provider, which Strict would send without it.
  return { httpOnly: true, secure: !isRelaxedEnv(env), sameSite: 'lax', path: '/', maxAge: maxAgeMs, signed: false };
}

export function flowCookie(f: OidcFlow, env: string | undefined): FlowCookie {
  return { Name: flowCookieName(env), Value: encodeFlow(f), Options: options(env, OIDC_FLOW_TTL_SECONDS * 1000) };
}

export function clearFlowCookie(env: string | undefined): FlowCookie {
  return { Name: flowCookieName(env), Value: '', Options: options(env, 0) };
}
