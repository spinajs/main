import type { IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import type { Request } from '@spinajs/http';
import { AuthnResponseExtension, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, Principal, SessionHandle } from '@spinajs/authn/contracts';
import { SESSION_IP_KEY, SESSION_PENDING_STEPS_KEY, SESSION_USER_AGENT_KEY } from '@spinajs/authn-session';

import { publishAuthnEvent } from '../policies/v3/audit.js';
import { unauthenticated } from '../policies/v3/errors.js';
import { mfaPolicyOf } from '../policies/v3/mfa.js';

export { publishAuthnEvent };

// Helpers of the 3.0 account controllers (src/v3/controllers); not exported by any entry.

export type Restored = NonNullable<Request['storage']['AuthnSession']>;

export type AnswerKind = 'login' | 'mfa' | 'role-switch' | 'impersonation' | 'whoami';

// A client sends the user agent, so the stored copy is bounded.
const USER_AGENT_CAP = 512;

/** The first of `names` the JSON body carries. */
export function bodyField(req: Request, ...names: string[]): unknown {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  for (const name of names) {
    const value = (body as Record<string, unknown>)[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A non-empty string of at most `cap` characters, else null. */
export const boundedString = (value: unknown, cap: number): string | null => (typeof value === 'string' && value !== '' && value.length <= cap ? value : null);

/** ctx.ip is the trusted-proxy chain's ClientIp, never Express's ip (A05, N3). */
export function contextOf(req: Request, purpose: AuthnContext['purpose'], session?: SessionHandle): AuthnContext {
  const ip = req.storage.ClientIp;
  const userAgent = req.headers['user-agent'];
  return { ...(typeof ip === 'string' ? { ip } : {}), ...(typeof userAgent === 'string' ? { userAgent } : {}), now: new Date(), purpose, ...(session ? { session } : {}) };
}

/** Stores the client ip and user agent that GET /user/sessions shows (the issuer takes no request context, N2). */
export async function stampClient(sessions: SessionIssuer, handle: SessionHandle, req: Request): Promise<void> {
  const ip = req.storage.ClientIp;
  const userAgent = req.headers['user-agent'];
  if (typeof ip === 'string' && ip !== '') await onLiveSession(() => sessions.set(handle, SESSION_IP_KEY, ip));
  if (typeof userAgent === 'string' && userAgent !== '') await onLiveSession(() => sessions.set(handle, SESSION_USER_AGENT_KEY, userAgent.slice(0, USER_AGENT_CAP)));
}

/**
 * Audits the end of `session` by this request: `type` for the session, plus `impersonation.end` with `reason` when it
 * was an impersonation, which AuthnImpersonationService audits only for its own stop and expiry (A20).
 */
export async function auditEnded(container: IContainer, req: Request, session: Restored, type: 'logout' | 'session.revoke', reason: string): Promise<void> {
  const { sessionHandle, impersonator } = session.facts;
  const about = { identity: { type: session.identity.type, id: session.identity.id }, ...(sessionHandle ? { session: sessionHandle } : {}) };
  const actor = impersonator ? { actor: { type: impersonator.type, id: impersonator.id } } : {};
  await publishAuthnEvent(container, req, { type, outcome: 'success', reason, ...about, ...actor });
  if (impersonator) await publishAuthnEvent(container, req, { type: 'impersonation.end', outcome: 'success', reason, ...about, ...actor });
}

/**
 * Runs `step` against the issuer; the session vanishing meanwhile (logout or ban in parallel) is the caller's session
 * having ended, a 401, not a server error.
 */
export async function onLiveSession<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof InvalidOperation) throw unauthenticated('the session has ended');
    throw err;
  }
}

/** What every successful answer says about the principal; never a session id, handle or storage key. */
export function summaryOf(p: Principal): Record<string, unknown> {
  const a = p.authn;
  return {
    Identity: { type: p.type, id: p.id },
    Authn: a
      ? {
          method: a.method,
          strategy: a.strategy,
          assurance: a.assurance,
          mfa: [...a.mfa],
          authenticatedAt: a.authenticatedAt instanceof Date ? a.authenticatedAt.toISOString() : a.authenticatedAt,
          ...(a.impersonator ? { impersonator: { type: a.impersonator.type, id: a.impersonator.id } } : {}),
        }
      : null,
  };
}

/** The principal summary, then each registered AuthnResponseExtension in turn (D26: users adds `Access`). */
export async function answerFor(container: IContainer, kind: AnswerKind, principal: Principal, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { ...summaryOf(principal), ...extra };
  const extensions = (await container.resolve(Array.ofType(AuthnResponseExtension))) as AuthnResponseExtension[];
  // A resolve of the abstract base itself would leave an instance of it in the list; it extends nothing.
  for (const ext of extensions.filter((e) => e?.constructor !== AuthnResponseExtension && typeof e?.extend === 'function')) await ext.extend(kind, principal, body);
  return body;
}

/** The steps a pending session waits for; a migrated 2.x row keeps none, so the MFA policy `policyService` (authn.mfa.policy.service) is asked as completeMfa asks it. */
export async function pendingSteps(container: IContainer, session: Restored, policyService: string): Promise<string[]> {
  const stored = session.data.get(SESSION_PENDING_STEPS_KEY);
  if (Array.isArray(stored) && stored.length > 0 && stored.every((s) => typeof s === 'string')) return [...stored];
  const policy = await mfaPolicyOf(container, policyService);
  return [...(await policy.required(session.identity, { method: session.facts.method, strategy: session.facts.strategy }))];
}

/** A user id, or `{ type, id }`, each part a non-empty string of at most `cap` characters. */
export function identityRefOf(value: unknown, cap: number): IdentityRef | null {
  if (typeof value === 'string') return boundedString(value, cap) === null ? null : { type: 'user', id: value };
  if (typeof value !== 'object' || value === null) return null;
  const { type, id } = value as Record<string, unknown>;
  const t = boundedString(type, cap);
  const i = boundedString(id, cap);
  return t !== null && i !== null ? { type: t, id: i } : null;
}
