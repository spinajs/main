import { AuthzAdminFailure } from '@spinajs/authz';
import { InvalidArgument, ResourceDuplicated, ResourceNotFound } from '@spinajs/exceptions';
import { BadRequestResponse, Conflict, ForbiddenResponse, NotFound } from '@spinajs/http';
import type { Response } from '@spinajs/http';
import { InvitationRefused } from '@spinajs/teams';

export interface TeamsHttpError {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}

// The AuthzAdmin codes answer as on authz-http-admin's routes; test/helpers.test.ts compares the two tables.
const REFUSED = new Set(['forbidden', 'escalation', 'last_holder', 'self_lockout', 'protected_role', 'invitation_email_mismatch', 'invitation_not_a_user', 'invitation_inviter_lost_authority']);
const MISSING = new Set(['not_found', 'invitation_unknown']);
const CONFLICTING = new Set(['conflict', 'invitation_expired', 'invitation_revoked', 'invitation_used_up']);

/** 403 for a refusal, 404 for a missing row, 409 for a state that refuses the request, 400 for the rest (validation). */
export function teamsErrorStatus(code: string): 400 | 403 | 404 | 409 {
  if (REFUSED.has(code)) return 403;
  if (MISSING.has(code)) return 404;
  if (CONFLICTING.has(code)) return 409;
  return 400;
}

function answer(status: number, code: string, message: string, field?: string): { readonly status: number; readonly error: TeamsHttpError } {
  return Object.freeze({ status, error: Object.freeze({ code, message, ...(field === undefined || field === null ? {} : { field }) }) });
}

/**
 * The answer to an error a teams service throws. Undefined for what http and authz-http answer
 * themselves (AccessDenied 403, ValidationFailed 400) and for anything else, which stays a 500:
 * a driver error carries a `code` too and must not be read as a refusal.
 */
export function teamsFailureAnswer(e: unknown): { readonly status: number; readonly error: TeamsHttpError } | undefined {
  if (e instanceof AuthzAdminFailure) return answer(teamsErrorStatus(e.code), e.code, e.message, e.field);
  // InvitationRefused is a Forbidden for every code; a client needs 404 for an unknown token and 409 for a spent one.
  if (e instanceof InvitationRefused) {
    const code = `invitation_${e.code}`;
    return answer(teamsErrorStatus(code), code, e.message);
  }
  if (e instanceof ResourceNotFound) return answer(404, 'not_found', e.message);
  if (e instanceof ResourceDuplicated) return answer(409, 'conflict', e.message);
  if (e instanceof InvalidArgument) return answer(400, 'invalid_request', e.message, e.fieldName);
  return undefined;
}

export function respond(status: number, body: unknown): Response {
  switch (status) {
    case 403:
      return new ForbiddenResponse(body);
    case 404:
      return new NotFound(body);
    case 409:
      return new Conflict(body);
    default:
      return new BadRequestResponse(body);
  }
}

/** Runs a route; a service error with a known answer becomes `{ error: { code, message, field? } }` with its status. */
export async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const known = teamsFailureAnswer(e);
    if (!known) throw e;
    return respond(known.status, { error: known.error });
  }
}
