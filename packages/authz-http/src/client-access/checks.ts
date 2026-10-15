import { GLOBAL, compileFieldGlobs, isPermission } from '@spinajs/authz';
import type { AuthzService, Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import type { Log } from '@spinajs/log';

import { decisionFields } from '../fields.js';

export const MAX_ACCESS_CHECKS = 100;

/** `reasons[i]` codes the endpoint sets itself; a denial carries the decision's own `reason.code`. */
export const CLIENT_CHECK_REASONS = Object.freeze({
  invalid: 'invalid_request',
  subjectMismatch: 'subject_mismatch',
  conditional: 'conditional',
  fieldDenied: 'field_denied',
} as const);

export interface ClientChecksAnswer {
  readonly results: boolean[];
  readonly reasons: (string | null)[];
}

export interface ClientCheck {
  readonly permission: Permission;
  readonly resource: ResourceRef;
  readonly field?: { readonly name: string; readonly mode: 'read' | 'write' };
}

export interface ClientCheckOptions {
  /** The `authz` config section; `decisionFields` reads `fields.neverRead` from it. */
  readonly authz: unknown;
  readonly log: Log;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

const isCaller = (subject: unknown, principal: Principal): boolean => isRecord(subject) && subject.type === principal.type && subject.id === principal.id && subject.relation === undefined;

/** One `checks[]` entry (ckit's `{ object, permission, subject?, context? }`) as a check, or the reason it is answered false. `checkAll` throws on a malformed entry, so none may reach it. */
export function readClientCheck(raw: unknown, principal: Principal): ClientCheck | string {
  if (!isRecord(raw) || !isRecord(raw.object) || !nonEmpty(raw.object.type) || !nonEmpty(raw.object.id) || !nonEmpty(raw.permission)) return CLIENT_CHECK_REASONS.invalid;
  const type = raw.object.type;
  const id = raw.object.id;
  const permission = raw.permission.includes(':') ? raw.permission : `${type}:${raw.permission}`;
  if (!isPermission(permission)) return CLIENT_CHECK_REASONS.invalid;
  if (raw.subject !== undefined && !isCaller(raw.subject, principal)) return CLIENT_CHECK_REASONS.subjectMismatch;

  let field: ClientCheck['field'];
  if (raw.context !== undefined) {
    if (!isRecord(raw.context)) return CLIENT_CHECK_REASONS.invalid;
    const { field: name, fieldMode } = raw.context;
    if (name !== undefined) {
      if (!nonEmpty(name) || (fieldMode !== undefined && fieldMode !== 'read' && fieldMode !== 'write')) return CLIENT_CHECK_REASONS.invalid;
      field = { name, mode: fieldMode ?? 'write' };
    }
  }

  const resource: ResourceRef = type === GLOBAL.type ? GLOBAL : id === '*' ? { type } : { type, id };
  return field ? { permission, resource, field } : { permission, resource };
}

function verdict(d: Decision, check: ClientCheck, authz: unknown): [boolean, string | null] {
  if (!d.allowed) return [false, d.reason?.code ?? 'no_access'];
  if (d.residual.op !== 'true') return [false, CLIENT_CHECK_REASONS.conditional];
  if (check.field && !compileFieldGlobs(decisionFields(authz, d)[check.field.mode]).allows(check.field.name)) return [false, CLIENT_CHECK_REASONS.fieldDenied];
  return [true, null];
}

/** Design §10.2: only a definite allow is true; a bad entry costs its own answer, never the batch. */
export async function answerClientChecks(service: AuthzService, principal: Principal, raw: readonly unknown[], opts: ClientCheckOptions): Promise<ClientChecksAnswer> {
  const parsed = raw.map((entry) => readClientCheck(entry, principal));
  const results = parsed.map(() => false);
  const reasons = parsed.map((p): string | null => (typeof p === 'string' ? p : null));
  parsed.forEach((p, i) => {
    if (typeof p === 'string') opts.log.debug(`POST /user/access/checks: entry ${i} answered false (${p})`);
  });

  const pending = parsed.flatMap((p, i) => (typeof p === 'string' ? [] : [{ i, check: p }]));
  const decisions = pending.length === 0 ? [] : await service.checkAll(principal, pending.map(({ check }) => ({ permission: check.permission, resource: check.resource })));
  if (decisions.length !== pending.length) throw new Error(`checkAll answered ${decisions.length} decisions for ${pending.length} requests`);
  pending.forEach(({ i, check }, k) => {
    [results[i], reasons[i]] = verdict(decisions[k], check, opts.authz);
  });

  return { results, reasons };
}
