import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Ok } from '@spinajs/http';
import type { ICookie, Request, Unauthorized } from '@spinajs/http';
import { mfaEnrolmentRefusal } from '@spinajs/authn';
import { AuthnResponseExtension, AuthnService, SessionIssuer } from '@spinajs/authn/contracts';
import type { Credentials, IdentityRef, Principal, Session, SessionHandle } from '@spinajs/authn/contracts';
import { SESSION_IP_KEY, SESSION_USER_AGENT_KEY } from '@spinajs/authn-session';
import { isPlainObject } from '@spinajs/util';

import { publishAuthnEvent } from '../policies/v3/audit.js';
import { unauthenticated } from '../policies/v3/errors.js';
import { mfaPolicyOf } from '../policies/v3/mfa.js';
import { contextOf } from './context.js';
import { NO_STORE, authnClearedSessionCookie, authnFailureResponse, authnSessionCookie } from './responses.js';

export { contextOf, publishAuthnEvent };

// Helpers of the 3.0 account controllers (src/v3/controllers); not exported by any entry.

export type AnswerKind = 'login' | 'mfa' | 'role-switch' | 'impersonation' | 'whoami';

// A client sends the user agent, so the stored copy is bounded.
const USER_AGENT_CAP = 512;

/** The `name` field of a JSON object body. */
export function bodyField(req: Request, name: string): unknown {
  const body: unknown = req.body;
  if (!isPlainObject(body)) return undefined;
  return body[name];
}

/** A non-empty string of at most `cap` characters, else null. */
export const boundedString = (value: unknown, cap: number): string | null => (typeof value === 'string' && value !== '' && value.length <= cap ? value : null);

/** Stores the client ip and user agent that GET /user/sessions shows (the issuer takes no request context, N2). */
export async function stampClient(sessions: SessionIssuer, handle: SessionHandle, req: Request): Promise<void> {
  const ip = req.storage.ClientIp;
  const userAgent = req.headers['user-agent'];
  if (typeof ip === 'string' && ip !== '') await onLiveSession(() => sessions.set(handle, SESSION_IP_KEY, ip));
  if (typeof userAgent === 'string' && userAgent !== '') await onLiveSession(() => sessions.set(handle, SESSION_USER_AGENT_KEY, userAgent.slice(0, USER_AGENT_CAP)));
}

/**
 * A login route's answer: ends a session the caller already holds, then authenticates `credentials` (null: missing or
 * malformed, a failed login). Success: the session cookie and the principal summary with the login extensions; MFA
 * required: `{ MfaRequired: [steps] }` with the pending session cookie; any failure: the login failure answer, plus
 * Retry-After when throttled, clearing the ended session's cookie.
 */
export async function completeLogin(container: IContainer, sessions: SessionIssuer, config: Configuration, req: Request, credentials: Credentials | null): Promise<Ok | Unauthorized> {
  const held = req.storage.AuthnSession;
  if (held) {
    await sessions.revoke(held.handle);
    await auditEnded(container, req, held, 'session.revoke', 'login');
  }
  const cleared: ICookie[] = held ? [authnClearedSessionCookie(config)] : [];
  if (credentials === null) return authnFailureResponse(undefined, cleared);

  // Per call: an eager AuthnService builds its checked neighbours, missing in apps without them.
  const authn = await container.resolve(AuthnService);
  const result = await authn.authenticate(credentials, contextOf(req, 'login'));
  if (result.status === 'failure') return authnFailureResponse(result.reason === 'throttled' ? result.retryAfterSeconds : undefined, cleared);
  if (result.status === 'mfa_required') {
    await stampClient(sessions, result.pending, req);
    return new Ok({ MfaRequired: [...result.steps] }, { Coockies: [authnSessionCookie(config, result.pending)], Headers: [NO_STORE] });
  }
  // A strategy that takes these credentials but issues no session cannot log anyone in here.
  if (!result.session) return authnFailureResponse(undefined, cleared);
  await stampClient(sessions, result.session, req);
  const principal = await authn.principalOf(result);
  return new Ok(await answerFor(container, 'login', principal), { Coockies: [authnSessionCookie(config, result.session)], Headers: [NO_STORE] });
}

/**
 * Audits the end of `session` by this request: `type` for the session, plus `impersonation.end` with `reason` when it
 * was an impersonation, which AuthnImpersonationService audits only for its own stop and expiry (A20).
 */
export async function auditEnded(container: IContainer, req: Request, session: Session, type: 'logout' | 'session.revoke', reason: string): Promise<void> {
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

/**
 * The steps a pending session waits for; for one issued with no steps the MFA policy `policyService`
 * (authn.mfa.policy.service) is asked as completeMfa asks it. A policy refusal over the stored enrolments gives no step:
 * MFA verify then answers its usual failure, whoami an empty list.
 */
export async function pendingSteps(container: IContainer, session: Session, policyService: string): Promise<string[]> {
  const stored = session.pendingSteps;
  if (stored) return [...stored];
  const policy = await mfaPolicyOf(container, policyService);
  try {
    return [...(await policy.required(session.identity, { method: session.facts.method, strategy: session.facts.strategy }))];
  } catch (err) {
    if (mfaEnrolmentRefusal(err)) return [];
    throw err;
  }
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
