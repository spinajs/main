import type { Principal, PrincipalRef, ResourceRef } from './principal.js';
import type { Permission } from './permission.js';
import type { ResourceFilter } from './filter.js';

export interface DecisionRequest {
  readonly principal: Principal; // under 'inherit' delegation: the delegate
  readonly actor?: Principal; // the principal that made the request when it differs (the agent)
  readonly permission: Permission;
  readonly resource: ResourceRef;
  readonly subject?: unknown; // loaded row/object: residual is evaluated against it
  readonly env?: Readonly<Record<string, unknown>>; // ip, now, mfa, user agent
  readonly explain?: boolean;
}

export interface FieldSet {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
  readonly hide?: readonly string[];
}

// core codes: no_access, unknown_resource, ceiling, delegate, unattended, anonymous, model_error, needs_subject, residual_false
// RBAC codes: role_denied, role_too_low{ladder, role, needed}, tag_missing{tag}, provenance{needed}, rule codes from config
export interface DenyReason {
  readonly code: string;
  readonly model?: string;
  readonly priority?: number; // lower wins (D17); default per code, see DEFAULT_DENY_PRIORITY
  readonly sortKey?: string; // tie-break, compared by code point (branch rule pattern)
  readonly [k: string]: unknown;
}

export interface Vote {
  readonly model: string;
  readonly permitWhen: ResourceFilter; // FALSE = grants nothing
  readonly denyWhen: ResourceFilter; // FALSE = denies nothing
  readonly denies?: readonly { readonly when: ResourceFilter; readonly reason: DenyReason }[]; // one per deny source; OR = denyWhen
  readonly error?: string; // set => indeterminate (B04)
  readonly reason?: DenyReason; // why it does not permit
  readonly roles?: Readonly<Record<string, string>>; // RBAC: effective role per ladder on the resource
  readonly fields?: FieldSet;
  readonly validUntil?: Date;
  readonly cacheable: boolean; // false when it read env (time, ip)
  readonly trace?: readonly TraceStep[];
}

export type CombiningAlgorithm = 'deny-overrides' | 'permit-overrides' | 'first-applicable';

export interface Decision {
  readonly allowed: boolean; // true also when a residual remains
  readonly permission: Permission;
  readonly resource: ResourceRef;
  readonly principal: PrincipalRef;
  readonly actor?: PrincipalRef;
  readonly residual: ResourceFilter; // TRUE when unconditional; FALSE when denied
  readonly fields: { readonly read: readonly string[]; readonly write: readonly string[] };
  readonly roles: Readonly<Record<string, string>>; // effective role per ladder (C6 Decision.role = roles.project)
  readonly reason?: DenyReason; // the deny reason with the lowest (priority, sortKey)
  readonly validUntil?: Date;
  readonly domain: string;
  readonly trace?: Trace;
}

export interface TraceStep {
  readonly by: 'core' | string;
  readonly step: string;
  readonly note: string;
  readonly data?: unknown;
}

export interface Trace {
  readonly domain: string;
  readonly algorithm: CombiningAlgorithm;
  readonly models: readonly string[]; // routed, in order
  readonly votes: readonly Vote[]; // every routed model, even after a short-circuit
  readonly steps: readonly TraceStep[];
  readonly durationMs: number;
}

// Source-dependent rows (ABAC policies 100/500, threshold rules 300/600,
// role_too_low on the provenance rank 440, a ceiling with its own reason)
// are set by the model or core through DenyReason.priority.
export const DEFAULT_DENY_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  unknown_resource: 0,
  unattended: 0,
  anonymous: 0,
  role_denied: 150,
  ceiling: 200,
  delegate: 200,
  no_access: 400,
  role_too_low: 410,
  tag_missing: 420,
  provenance: 430,
  needs_subject: 500,
  model_error: 900,
  residual_false: 900,
});

export const UNKNOWN_DENY_PRIORITY = 500;

export function denyPriority(r: DenyReason): number {
  if (typeof r.priority === 'number' && Number.isFinite(r.priority)) {
    return r.priority;
  }

  return Object.prototype.hasOwnProperty.call(DEFAULT_DENY_PRIORITY, r.code) ? DEFAULT_DENY_PRIORITY[r.code] : UNKNOWN_DENY_PRIORITY;
}

// Surrogates (D800-DFFF) move above E000-FFFF, so UTF-16 units sort in code point order.
const fixup = (c: number): number => (c >= 0xe000 ? c - 0x800 : c >= 0xd800 ? c + 0x2000 : c);

const cmp = (a: unknown, b: unknown): number => {
  const x = String(a ?? '');
  const y = String(b ?? '');
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const cx = x.charCodeAt(i);
    const cy = y.charCodeAt(i);
    if (cx !== cy) {
      return fixup(cx) - fixup(cy);
    }
  }
  return x.length - y.length;
};

const sortedKeys = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort(cmp)
        .map((k) => [k, o[k]]),
    );
  }
  return value;
};

// Last tie-break: the payload of the reason, so that equal (priority, sortKey, code, model) still order the same in any input order (B36).
const payloadKey = (r: DenyReason): string => {
  try {
    // Null prototype: a '__proto__' key from parsed JSON stays an ordinary key.
    const rest: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(r)) {
      if (k !== 'code' && k !== 'model' && k !== 'priority' && k !== 'sortKey') {
        rest[k] = r[k];
      }
    }
    return JSON.stringify(rest, sortedKeys) ?? '';
  } catch {
    return '\u0000unserializable';
  }
};

export function compareDenyReasons(a: DenyReason, b: DenyReason): number {
  return denyPriority(a) - denyPriority(b) || cmp(a.sortKey, b.sortKey) || cmp(a.code, b.code) || cmp(a.model, b.model) || cmp(payloadKey(a), payloadKey(b));
}
