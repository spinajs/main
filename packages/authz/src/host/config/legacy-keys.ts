import { AuthzConfigError } from '../../contracts/errors.js';
import type { EngineLog } from '../../engine/authorizer.js';

export interface LegacyKeyRow {
  readonly from: string;
  readonly to: string | null;
  readonly note?: string;
}

export interface LegacyKeyFinding {
  readonly path: string;
  readonly to: string | null;
  readonly note?: string;
}

export const AUTHZ_LEGACY_KEYS: readonly LegacyKeyRow[] = Object.freeze([
  { from: 'rbac.grants', to: 'authz.rbac.roles', note: 'grants become role permissions' },
  { from: 'rbac.roles', to: 'authz.rbac.roles' },
  { from: 'rbac.defaultRole', to: 'authz.rbac.defaultRoles', note: 'also authz.rbac.anonymousRoles' },
  { from: 'rbac.enableGuestAccount', to: 'authz.principals.anonymous.enabled' },
  { from: 'rbac.requireKnownRole', to: null, note: 'removed' },
  { from: 'rbac.systemRole', to: null, note: 'removed' },
  { from: 'rbac.roleColumn', to: null, note: 'removed' },
  { from: 'rbac.roleSwitch', to: 'authz.principals.roleSwitch' },
  { from: 'rbac.impersonation.protectedRoles', to: 'authz.impersonation.protectedRoles' },
  { from: 'rbac.password.lockoutTime', to: null, note: 'H31: authn throttles with back-off and never locks; nearest knob is authn.throttle.login.account.maxDelayMs' },
  { from: 'rbac.user', to: 'users.user' },
  { from: 'rbac.email', to: 'users.email' },
  { from: 'rbac.actions', to: 'users.actions' },
  { from: 'rbac.admin.roleGuard', to: 'authz.admin.guard' },
  { from: 'rbac.token.rolePolicy', to: 'authz.token.rolePolicy' },
  { from: 'rbac.token.excludedRoles', to: 'authz.token.excludedRoles' },
]);

const AUTHN_FALLBACK = 'authn.* or users.*';

// The config loader marks each file's root keys with __file__.
function leaves(value: unknown, path: string, out: string[], seen: Set<object>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !seen.has(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0) {
      seen.add(value);
      for (const k of keys) if (k !== '__file__') leaves((value as Record<string, unknown>)[k], `${path}.${k}`, out, seen);
      seen.delete(value);
      return;
    }
  }
  out.push(path);
}

function rowFor(path: string): LegacyKeyRow | undefined {
  let best: LegacyKeyRow | undefined;
  for (const row of AUTHZ_LEGACY_KEYS) {
    if ((path === row.from || path.startsWith(`${row.from}.`)) && (!best || row.from.length > best.from.length)) best = row;
  }
  return best;
}

export function findLegacyKeys(rbac: unknown): LegacyKeyFinding[] {
  const paths: string[] = [];
  leaves(rbac, 'rbac', paths, new Set());
  return paths.map((path) => {
    const row = rowFor(path);
    if (!row) return { path, to: AUTHN_FALLBACK };
    return row.note ? { path, to: row.to, note: row.note } : { path, to: row.to };
  });
}

export function checkLegacyKeys(rbac: unknown, reject: boolean, log: Pick<EngineLog, 'warn'>): void {
  if (rbac === undefined || rbac === null) return;

  const found = findLegacyKeys(rbac);
  if (found.length === 0) return;
  const lines = found.map((f) => `${f.path} -> ${f.to ?? 'removed'}${f.note && f.note !== 'removed' ? ` (${f.note})` : ''}`);
  const text = `Authz 3.x does not read the 2.x "rbac" configuration. Move these keys (run spinajs-authz-convert, or set authz.config.rejectLegacyKeys: false to only warn): ${lines.join('; ')}`;

  if (reject) throw new AuthzConfigError(text);
  log.warn(text);
}
