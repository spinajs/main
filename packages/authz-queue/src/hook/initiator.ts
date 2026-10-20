import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { SYSTEM, UNATTENDED, engineLog } from '@spinajs/authz';
import type { Ceiling, HostLog, Principal } from '@spinajs/authz';
import { isStringArray } from '@spinajs/util';
import type { Initiator } from '../api.js';

/**
 * Builds the principal a job runs as from the `Initiator` on its message. An app that must reload
 * the user (attributes, deactivation) registers its own with `DI.register(X).as(InitiatorPrincipalFactory)`.
 * Return `UNATTENDED` for an initiator that can no longer act; throw only for a failure worth a retry.
 */
export abstract class InitiatorPrincipalFactory {
  abstract principalOf(initiator: Initiator): Promise<Principal>;
}

// null counts as absent, as in the engine's ceiling reader.
function reviveDate(v: unknown): Date | undefined {
  const d = v instanceof Date ? v : typeof v === 'string' || typeof v === 'number' ? new Date(v) : undefined;
  return d !== undefined && !Number.isNaN(d.getTime()) ? d : undefined;
}

/** Rebuilds a Ceiling that went through a JSON broker (`expiresAt` is a string there); undefined when the shape is wrong. */
export function reviveCeiling(raw: unknown): Ceiling | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c: Record<string, unknown> = Object.fromEntries(Object.entries(raw as object).filter(([, v]) => v !== null));
  const out: { -readonly [K in keyof Ceiling]: Ceiling[K] } = {};
  if (c.roles !== undefined) {
    if (!isStringArray(c.roles)) return undefined;
    out.roles = [...c.roles];
  }
  if (c.permissions !== undefined) {
    if (!isStringArray(c.permissions)) return undefined;
    out.permissions = [...c.permissions];
  }
  if (c.resources !== undefined) {
    if (!Array.isArray(c.resources)) return undefined;
    const resources = [];
    for (const r of c.resources as unknown[]) {
      if (r === null || typeof r !== 'object') return undefined;
      const { type, id } = r as { type?: unknown; id?: unknown };
      if (typeof type !== 'string' || (id !== undefined && typeof id !== 'string')) return undefined;
      resources.push(id === undefined ? { type } : { type, id });
    }
    out.resources = resources;
  }
  if (c.expiresAt !== undefined) {
    const expiresAt = reviveDate(c.expiresAt);
    if (expiresAt === undefined) return undefined;
    out.expiresAt = expiresAt;
  }
  if (c.reason !== undefined) {
    if (typeof c.reason !== 'string') return undefined;
    out.reason = c.reason;
  }
  return out;
}

/** Trusts the stamp: type, id and ceiling are all the principal has. A malformed stamp yields `UNATTENDED`. */
@Injectable(InitiatorPrincipalFactory)
export class StampedInitiatorPrincipalFactory extends InitiatorPrincipalFactory {
  private warned = false;
  private readonly warn: boolean | undefined;

  protected Log: HostLog = engineLog('authz-queue');

  @Config('authz.queue.stampedInitiatorWarning')
  protected WarningSwitch: boolean;

  /**
   * `warn` decides the one-time warning without reading the config, for a wrapper built with `new` that does reload the user.
   * Without it, `authz.queue.stampedInitiatorWarning` decides, so a `new` instance needs a resolved Configuration.
   */
  constructor(options: { readonly warn?: boolean } = {}) {
    super();
    this.warn = options.warn;
  }

  async principalOf(initiator: Initiator): Promise<Principal> {
    if (!this.warned) {
      // The schema default keeps the warning; so does a value the schema never saw.
      const warn = this.warn ?? this.WarningSwitch !== false;
      this.warned = true;
      if (warn) this.Log.warn('authz-queue: jobs run as their initiator from the stamp alone; register an InitiatorPrincipalFactory that reloads the user so deactivated users stop acting');
    }
    if (initiator === null || typeof initiator !== 'object') return UNATTENDED;
    const { type, id, ceiling } = initiator as { type?: unknown; id?: unknown; ceiling?: unknown };
    if (typeof type !== 'string' || type === '' || typeof id !== 'string' || id === '') return UNATTENDED;
    if (type === 'system') return SYSTEM;
    if (type === 'unattended') return UNATTENDED;

    let revived: Ceiling | undefined;
    if (ceiling !== undefined && ceiling !== null) {
      revived = reviveCeiling(ceiling);
      if (revived === undefined) return UNATTENDED;
    }

    return Object.freeze({
      type,
      id,
      authenticated: type !== 'anonymous',
      source: 'queue',
      attributes: Object.freeze({}),
      ...(revived ? { ceiling: revived } : {}),
    });
  }
}
