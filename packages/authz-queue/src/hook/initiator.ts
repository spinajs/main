import { Injectable } from '@spinajs/di';
import { SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { Ceiling, Principal } from '@spinajs/authz';
import type { Initiator } from '../api.js';

/**
 * Builds the principal a job runs as from the `Initiator` on its message. An app that must reload
 * the user (attributes, deactivation) registers its own with `DI.register(X).as(InitiatorPrincipalFactory)`.
 * Return `UNATTENDED` for an initiator that can no longer act; throw only for a failure worth a retry.
 */
export abstract class InitiatorPrincipalFactory {
  abstract principalOf(initiator: Initiator): Promise<Principal>;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function reviveDate(v: unknown): Date | undefined {
  const d = v instanceof Date ? v : typeof v === 'string' || typeof v === 'number' ? new Date(v) : undefined;
  return d !== undefined && !Number.isNaN(d.getTime()) ? d : undefined;
}

/** Rebuilds a Ceiling that went through a JSON broker (`expiresAt` is a string there); undefined when the shape is wrong. */
export function reviveCeiling(raw: unknown): Ceiling | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof Ceiling]: Ceiling[K] } = {};
  if (c.roles !== undefined) {
    if (!isStrings(c.roles)) return undefined;
    out.roles = [...c.roles];
  }
  if (c.permissions !== undefined) {
    if (!isStrings(c.permissions)) return undefined;
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
  async principalOf(initiator: Initiator): Promise<Principal> {
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
