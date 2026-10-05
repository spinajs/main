import { InvalidOption } from '@spinajs/exceptions';

import { AUTHN_LEGACY_KEYS } from '../../schemas/legacy-keys.js';
import type { AuthnLegacyKey } from '../../schemas/legacy-keys.js';
import type { AuthnConfigSource } from './env.js';

/** A 2.x key found in the configuration, and the 3.0 key it moved to (null: dropped). */
export interface AuthnLegacyKeyFinding {
  readonly path: string;
  readonly to: string | null;
  readonly note?: string;
}

// The users rows belong to the users detector; rbac keys of no row belong to authz's.
const ROWS = AUTHN_LEGACY_KEYS.filter((r) => r.family === 'authn');

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// The config loader marks each file's root keys with __file__.
function leaves(v: unknown, path: string, out: string[], seen: Set<object>): void {
  if (isObject(v) && Object.keys(v).length > 0) {
    if (seen.has(v)) return;
    seen.add(v);
    for (const [k, c] of Object.entries(v)) if (k !== '__file__') leaves(c, `${path}.${k}`, out, seen);
    return;
  }
  out.push(path);
}

function rowFor(path: string): AuthnLegacyKey | undefined {
  let best: AuthnLegacyKey | undefined;
  for (const row of ROWS) {
    if ((path === row.from || path.startsWith(`${row.from}.`)) && (!best || row.from.length > best.from.length)) best = row;
  }
  return best;
}

/** Every leaf of the 2.x `rbac` tree that a row of the old-key table moved to authn.*, in tree order. */
export function findAuthnLegacyKeys(rbac: unknown): AuthnLegacyKeyFinding[] {
  if (rbac === undefined || rbac === null) return [];
  const paths: string[] = [];
  leaves(rbac, 'rbac', paths, new Set());
  const found: AuthnLegacyKeyFinding[] = [];
  for (const path of paths) {
    const row = rowFor(path);
    if (!row) continue;
    const to = row.to === null ? null : row.scope === 'subtree' ? `${row.to}${path.slice(row.from.length)}` : row.to;
    found.push(row.note ? { path, to, note: row.note } : { path, to });
  }
  return found;
}

/** `authn.config.rejectLegacyKeys`; false unless it is true (the schema refuses any other value). */
export function rejectsAuthnLegacyKeys(config: AuthnConfigSource): boolean {
  return config.get<boolean | undefined>('authn.config.rejectLegacyKeys') === true;
}

/** One message naming each key and where it goes; never a value. */
export function authnLegacyKeysText(found: readonly AuthnLegacyKeyFinding[]): string {
  const lines = found.map((f) => `${f.path} -> ${f.to ?? 'dropped'}${f.note ? ` (${f.note})` : ''}`);
  return `Authn 3.0 does not read these 2.x keys; move them (authn.config.rejectLegacyKeys: true fails boot on them): ${lines.join('; ')}`;
}

/** The boot detector: warns once about the keys it finds, and fails boot on them when authn.config.rejectLegacyKeys is true. */
export function checkAuthnLegacyKeys(config: AuthnConfigSource, log: { warn(message: string): void }): AuthnLegacyKeyFinding[] {
  const reject = rejectsAuthnLegacyKeys(config);
  const found = findAuthnLegacyKeys(config.get<unknown>('rbac'));
  if (found.length === 0) return found;
  const text = authnLegacyKeysText(found);
  if (reject) throw new InvalidOption(text);
  log.warn(text);
  return found;
}
