import { AsyncService, Container, Inject, PerChildInstance } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import type { AuthnContext, Credentials } from '../contracts/credentials.js';
import type { AuthnFacts } from '../contracts/principal.js';
import { AuthnService } from '../contracts/service.js';
import { SessionIssuer } from '../contracts/session.js';
import type { SessionHandle } from '../contracts/session.js';

/** Design §22.5 `authn.freshAuth.maxAgeSeconds`. */
export const DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS = 300;

/**
 * True when `authenticatedAt` lies within `maxAgeSeconds` before `now`, the boundary included. A time after `now` or
 * an invalid one is not fresh.
 */
export function isFresh(facts: Pick<AuthnFacts, 'authenticatedAt'>, now: Date, maxAgeSeconds: number): boolean {
  if (typeof maxAgeSeconds !== 'number' || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new InvalidArgument('isFresh: maxAgeSeconds must be a positive number');
  }
  const at = facts?.authenticatedAt;
  if (!(at instanceof Date) || !(now instanceof Date)) return false;
  const age = now.getTime() - at.getTime();
  return age >= 0 && age <= maxAgeSeconds * 1000;
}

function readMaxAge(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) throw new InvalidOption('authn.freshAuth.maxAgeSeconds must be a positive integer');
  return raw;
}

/**
 * Fresh authentication for sensitive actions (A13): the active session authenticated within
 * `authn.freshAuth.maxAgeSeconds`, or an inline re-authentication of its identity, which counts for this request only.
 * One per container.
 */
@PerChildInstance()
@Inject(Container)
export class FreshAuth extends AsyncService {
  private maxAge = DEFAULT_FRESH_AUTH_MAX_AGE_SECONDS;
  private authn!: AuthnService;
  private sessions!: SessionIssuer;
  private ready = false;

  constructor(private readonly container: IContainer) {
    super();
  }

  public get maxAgeSeconds(): number {
    return this.maxAge;
  }

  public async resolve(): Promise<void> {
    if (this.ready) return;
    const configuration = (await this.container.resolve(Configuration)) as Configuration | null;
    if (configuration === null || typeof configuration !== 'object' || typeof configuration.get !== 'function') {
      throw new InvalidOperation('FreshAuth: the resolved Configuration has no get()');
    }
    this.maxAge = readMaxAge(configuration.get('authn.freshAuth.maxAgeSeconds'));
    if (!this.container.hasRegistered(SessionIssuer as unknown as Class<SessionIssuer>)) throw new InvalidOperation('FreshAuth: no SessionIssuer is registered');
    this.sessions = (await this.container.resolve(SessionIssuer as unknown as Class<SessionIssuer>)) as SessionIssuer;
    this.authn = (await this.container.resolve(AuthnService as unknown as Class<AuthnService>)) as AuthnService;
    this.ready = true;
    await super.resolve();
  }

  /** `reauth` is verified only when the session is not fresh. */
  public async check(session: SessionHandle, ctx: AuthnContext, reauth?: Credentials): Promise<boolean> {
    const id: unknown = (session as Partial<SessionHandle> | null | undefined)?.id;
    if (typeof id !== 'string' || id === '') return false;
    const stored = await this.sessions.restore(id);
    if (!stored || stored.handle.state !== 'active') return false;
    if (isFresh(stored.facts, ctx.now, this.maxAge)) return true;
    return reauth !== undefined && (await this.authn.reauthenticate(session, reauth, ctx));
  }
}
