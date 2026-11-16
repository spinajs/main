import { canonicalize } from './hash.js';
import { entryTenancies } from './tenancy.js';
import type { Manifest, ModelTenant, TenancyEntryPoint, TenancyEscape, TenancyModel } from './types.js';

export interface TenancyChange { kind: 'added' | 'removed' | 'changed'; id: string; breaking: boolean; detail: string }

type Facet = readonly [name: string, of: (tenant: ModelTenant) => string];

const FACETS: readonly Facet[] = [
  ['isolation', (t) => t.isolation ?? 'default'],
  ['column', (t) => (t.column === false ? 'none' : (t.column ?? 'default'))],
  ['rls', (t) => (t.rls === undefined ? 'default' : t.rls ? 'on' : 'off')],
];

const describeTenant = (tenant: ModelTenant): string => FACETS.map(([name, of]) => `${name} ${of(tenant)}`).join(', ');

function modelChanges(base: TenancyModel[], head: TenancyModel[]): TenancyChange[] {
  const before = new Map(base.map((m) => [m.model, m.tenant]));
  const after = new Map(head.map((m) => [m.model, m.tenant]));
  const out: TenancyChange[] = [];
  for (const model of before.keys()) {
    if (!after.has(model)) out.push({ kind: 'removed', id: `model ${model}`, breaking: false, detail: 'no longer a tenant model: its rows are not confined to a tenant' });
  }
  for (const [model, tenant] of after) {
    const old = before.get(model);
    if (old === undefined) {
      out.push({ kind: 'added', id: `model ${model}`, breaking: false, detail: `now a tenant model (${describeTenant(tenant)})` });
      continue;
    }
    const moved = FACETS.filter(([, of]) => of(old) !== of(tenant)).map(([name, of]) => `${name} changed from ${of(old)} to ${of(tenant)}`);
    if (moved.length > 0) out.push({ kind: 'changed', id: `model ${model}`, breaking: false, detail: moved.join('; ') });
  }
  return out;
}

const entryId = (entry: TenancyEntryPoint): string => `${entry.kind} ${entry.id}`;
const stated = (entry: TenancyEntryPoint): string => (entry.tenancy === 'all' ? `all (${entry.reason ?? 'no literal reason'})` : entry.tenancy);

/** A client that sends no tenant is refused once a route requires one. */
const refusesClients = (before: TenancyEntryPoint, after: TenancyEntryPoint): boolean => after.kind === 'route' && after.tenancy === 'required' && before.tenancy !== 'required';

/** An entry point that disappears is a row of its own section (routes, socket, commands), so only the head is walked. */
function entryChanges(base: TenancyEntryPoint[], head: TenancyEntryPoint[]): TenancyChange[] {
  const before = new Map(base.map((e) => [entryId(e), e]));
  const out: TenancyChange[] = [];
  for (const entry of head) {
    const old = before.get(entryId(entry));
    if (old === undefined) {
      if (entry.declared !== undefined) out.push({ kind: 'added', id: entryId(entry), breaking: false, detail: `declares tenancy ${stated(entry)}` });
      continue;
    }
    if (stated(old) !== stated(entry)) out.push({ kind: 'changed', id: entryId(entry), breaking: refusesClients(old, entry), detail: `tenancy changed from ${stated(old)} to ${stated(entry)}` });
  }
  return out;
}

const escapeId = (escape: TenancyEscape): string => `${escape.kind} ${escape.source.package}:${escape.source.file}${escape.model ? ` on ${escape.model}` : ''}`;

interface Counted { escape: TenancyEscape; count: number }

/** Keyed without the line, which moves with every edit above it. */
function countEscapes(escapes: TenancyEscape[]): Map<string, Counted> {
  const out = new Map<string, Counted>();
  for (const escape of escapes) {
    const key = canonicalize([escapeId(escape), escape.reason ?? null]);
    const found = out.get(key);
    if (found) found.count++;
    else out.set(key, { escape, count: 1 });
  }
  return out;
}

function escapeChanges(base: TenancyEscape[], head: TenancyEscape[]): TenancyChange[] {
  const before = countEscapes(base);
  const after = countEscapes(head);
  const out: TenancyChange[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const escape = (after.get(key) ?? before.get(key))?.escape;
    const delta = (after.get(key)?.count ?? 0) - (before.get(key)?.count ?? 0);
    if (!escape || delta === 0) continue;
    const reason = escape.reason === undefined ? 'no literal reason' : `reason: ${escape.reason}`;
    const sites = Math.abs(delta) > 1 ? ` (${Math.abs(delta)} call sites)` : '';
    out.push({ kind: delta > 0 ? 'added' : 'removed', id: escapeId(escape), breaking: false, detail: `${reason}${sites}` });
  }
  return out;
}

/** The tenancy rows of a manifest diff: tenant models, entry points whose scope moved, and escapes with their reasons. */
export function tenancyChanges(base: Manifest, head: Manifest): TenancyChange[] {
  const [b, h] = [base.tenancy, head.tenancy];
  return [...modelChanges(b?.models ?? [], h?.models ?? []), ...entryChanges(entryTenancies(base), entryTenancies(head)), ...escapeChanges(b?.escapes ?? [], h?.escapes ?? [])];
}
