import type { AuthzSection, Diagnostic, Manifest, PolicyRef } from '@spinajs/manifest';
import { configAt } from '../rule.js';

export type EntryPoint = AuthzSection['entryPoints'][number];

/** The object an `AccessPolicy` ref of an entry point carries after its permissions. */
export interface AccessExtras {
  allowAnonymous?: true;
  resource?: { type?: string; model?: string };
}

export const accessRefs = (entry: EntryPoint): PolicyRef[] => entry.access.flat().filter((r) => r.type === 'AccessPolicy');
export const permissionsOf = (ref: PolicyRef): string[] => (ref.options ?? []).filter((o): o is string => typeof o === 'string');
export const extrasOf = (ref: PolicyRef): AccessExtras | undefined => (ref.options ?? []).find((o): o is AccessExtras => typeof o === 'object' && o !== null);
export const resourceOf = (permission: string): string => permission.slice(0, Math.max(0, permission.indexOf(':')));

/** Entry points the app declares itself; the framework's own carry their declarations in the 5.0 program. */
export const ownEntries = (manifest: Manifest): EntryPoint[] => (manifest.authz?.entryPoints ?? []).filter((e) => e.source.package === manifest.app.name);

export type PermissionConfig = { fields?: boolean; types?: string[] };

/** `authz.permissions` of the root and of every domain, when doctor runs with `--config`. */
export function configPermissions(config: Record<string, unknown> | undefined): Map<string, PermissionConfig> {
  const out = new Map<string, PermissionConfig>();
  const add = (section: unknown): void => {
    if (section === null || typeof section !== 'object') return;
    for (const [name, def] of Object.entries(section as Record<string, unknown>)) out.set(name, { ...out.get(name), ...((def ?? {}) as PermissionConfig) });
  };
  add(configAt(config, 'authz.permissions'));
  for (const domain of Object.values((configAt(config, 'authz.domains') ?? {}) as Record<string, unknown>)) add(configAt(domain as Record<string, unknown>, 'permissions'));
  return out;
}

/** Drops the findings a `// spinajs-authz-ignore <code>: <reason>` comment on, or just above, their line silences. */
export function withoutIgnored(manifest: Manifest, findings: Diagnostic[]): Diagnostic[] {
  const ignores = manifest.authz?.ignores ?? [];
  return findings.filter((d) => {
    const at = d.source;
    return !at || !ignores.some((i) => i.code === d.code && i.source.package === at.package && i.source.file === at.file && (i.source.line === at.line || i.source.line === at.line - 1));
  });
}

const KIND_NAMES: Record<EntryPoint['kind'], string> = { route: 'route', 'socket-command': 'socket command', 'socket-event': 'socket event', 'queue-handler': 'queue handler', schedule: 'schedule', cli: 'CLI command' };
export const entryName = (entry: EntryPoint): string => `${KIND_NAMES[entry.kind]} ${entry.id}`;
