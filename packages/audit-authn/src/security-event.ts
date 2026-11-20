import { AUDIT_WIDTHS } from '@spinajs/audit';
import type { AuditInput, AuditOutcome, AuditSubject } from '@spinajs/audit';
import type { AuthnEvent } from '@spinajs/authn/contracts';

export interface SecurityInputOptions {
  /** False for a trail that hashes `data.identity`: a subject cannot be hashed, so it must not repeat the identity in clear. */
  readonly subject: boolean;
}

const OUTCOME: Record<AuthnEvent['outcome'], AuditOutcome> = { success: 'ok', failure: 'failed' };
const MAX_USER_AGENT = 255;

// SR-19: free text holding `@` may be an email and is never written.
const noEmail = (value: string): string => (value.includes('@') ? '?' : value);

const refOf = (ref: { readonly type: unknown; readonly id: unknown } | undefined): AuditSubject | undefined => (ref ? { type: String(ref.type), id: String(ref.id) } : undefined);

// `record` refuses the whole event for a subject wider than its column: on a rejecting trail that would stop the login.
const fits = (ref: AuditSubject): boolean => ref.type !== '' && ref.id !== '' && ref.type.length <= AUDIT_WIDTHS.subject_type && ref.id.length <= AUDIT_WIDTHS.subject_id;

export function securityInput(e: AuthnEvent, options: SecurityInputOptions = { subject: true }): AuditInput {
  const identity = refOf(e.identity);
  const fields: [string, unknown][] = [
    ['strategy', e.strategy === undefined ? undefined : noEmail(e.strategy)],
    ['reason', e.reason === undefined ? undefined : noEmail(e.reason)],
    ['session', e.session],
    ['ip', e.ip],
    ['userAgent', e.userAgent?.slice(0, MAX_USER_AGENT)],
    ['identity', identity],
    ['actor', refOf(e.actor)],
    ['detail', e.data],
  ];
  const named = options.subject && identity !== undefined && fits(identity);
  // Tells a reader of the trail why `of(identity)` does not find this event.
  if (identity !== undefined && !named) fields.push(['subjectOmitted', true]);
  const data = Object.fromEntries(fields.filter(([, value]) => value !== undefined));

  return { kind: 'security', action: noEmail(e.type), outcome: OUTCOME[e.outcome], at: e.at, ...(named ? { subject: identity } : {}), data };
}
