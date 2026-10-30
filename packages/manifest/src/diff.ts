import { canonicalize } from './hash.js';
import { compareSchemaRefs } from './schema-compare.js';
import type { Finding } from './schema-compare.js';
import type { ControllerEntry, Manifest, ParamEntry, PolicyRef, RouteEntry, TypeRef } from './types.js';

export type ChangeKind = 'added' | 'removed' | 'changed';
export interface Change { section: 'routes' | 'schemas' | 'permissions' | 'config' | 'migrations' | 'services' | 'commands' | 'socket'; kind: ChangeKind; id: string; breaking: boolean; detail?: string }
export interface ManifestDiff { base: string; head: string; changes: Change[]; breaking: boolean }

type Section = Change['section'];
const SECTIONS: Section[] = ['routes', 'permissions', 'schemas', 'config', 'migrations', 'services', 'commands', 'socket'];

interface Keyed<T> { key: string; item: T }

function diffKeyed<T>(section: Section, base: Keyed<T>[], head: Keyed<T>[], opts: { removedBreaking?: boolean; changed: (b: T, h: T) => Finding[] | string | undefined }): Change[] {
  const before = new Map(base.map((e) => [e.key, e.item]));
  const after = new Map(head.map((e) => [e.key, e.item]));
  const changes: Change[] = [];

  for (const id of before.keys()) {
    if (!after.has(id)) changes.push({ section, kind: 'removed', id, breaking: opts.removedBreaking ?? false });
  }
  for (const [id, item] of after) {
    const old = before.get(id);
    if (old === undefined) {
      changes.push({ section, kind: 'added', id, breaking: false });
      continue;
    }
    const result = opts.changed(old, item);
    if (result === undefined) continue;
    if (typeof result === 'string') changes.push({ section, kind: 'changed', id, breaking: false, detail: result });
    else if (result.length > 0) changes.push({ section, kind: 'changed', id, breaking: result.some((f) => f.breaking), detail: result.map((f) => f.detail).join('; ') });
  }
  return changes;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const differs = (a: unknown, b: unknown): boolean => canonicalize(a) !== canonicalize(b);
const routeKey = (r: RouteEntry): string => `${r.method.toUpperCase()} ${r.fullPath}`;
// Kinds the compiler emits for injected and user-agent arguments; used only for params recorded before `wire` existed.
const NOT_SENT_KINDS = new Set(['FromDi', 'Req', 'Res', 'IpRouteArgs', 'RequestIdRouteArgs', 'UserAgentRouteArgs', 'RefererRouteArgs', 'RequestTypeRouteArgs', 'FromModel']);
const requestParams = (r: RouteEntry): ParamEntry[] => r.params.filter((p) => (p.wire ? p.wire.in !== 'none' : !NOT_SENT_KINDS.has(p.kind)));

/** A param is identified by where it travels, so renaming a whole-body or header argument in code is not a change. */
const legacyKey = (p: ParamEntry): string => `${p.kind}:${p.name}`;
const wireKey = (p: ParamEntry): string => {
  const { wire } = p;
  if (!wire) return legacyKey(p);
  return wire.shape === 'whole' ? `${wire.in}:*:${p.kind}` : `${wire.in}:${wire.name ?? p.name}`;
};

function compareTypes(b: TypeRef, h: TypeRef, direction: 'request' | 'response', label: string, base: Manifest, head: Manifest): Finding[] {
  if (b.schema && h.schema) return compareSchemaRefs(b.schema, h.schema, direction, base.schemas, head.schemas, label);
  return b.text === h.text ? [] : [{ breaking: true, detail: `${label} type changed from ${b.text} to ${h.text}` }];
}

function compareParams(b: RouteEntry, h: RouteEntry, base: Manifest, head: Manifest): Finding[] {
  const key = [...b.params, ...h.params].every((p) => p.wire) ? wireKey : legacyKey;
  const before = new Map(requestParams(b).map((p) => [key(p), p]));
  const after = new Map(requestParams(h).map((p) => [key(p), p]));
  const findings: Finding[] = [];

  for (const [k, p] of before) {
    const next = after.get(k);
    if (!next) findings.push({ breaking: true, detail: `parameter ${p.name} (${p.kind}) removed` });
    else if (!p.required && next.required) findings.push({ breaking: true, detail: `parameter ${p.name} is now required` });
    else findings.push(...compareTypes(p.runtimeType, next.runtimeType, 'request', `parameter ${p.name}`, base, head));
  }
  for (const [k, p] of after) {
    if (!before.has(k)) findings.push({ breaking: p.required, detail: `${p.required ? 'required' : 'optional'} parameter ${p.name} (${p.kind}) added` });
  }
  return findings;
}

function compareRoute(b: RouteEntry, h: RouteEntry, base: Manifest, head: Manifest): Finding[] {
  return [...compareParams(b, h, base, head), ...compareTypes(b.returnType, h.returnType, 'response', 'response', base, head)];
}

interface RouteRef { route: RouteEntry; controller: ControllerEntry }

const routeRefs = (m: Manifest): Keyed<RouteRef>[] => m.controllers.flatMap((controller) => controller.routes.map((route) => ({ key: routeKey(route), item: { route, controller } })));

const policyName = (p: PolicyRef): string => `policy ${p.type}${p.options?.length ? `(${p.options.map((o) => (typeof o === 'string' ? o : canonicalize(o))).join(',')})` : ''}`;

function requirements({ route, controller }: RouteRef): Set<string> {
  const policies = [...controller.policies, ...route.policies].flat();
  return new Set([...(controller.access ?? []), ...(route.access ?? []), ...policies.map(policyName)]);
}

function diffPermissions(base: Manifest, head: Manifest): Change[] {
  return diffKeyed<RouteRef>('permissions', routeRefs(base), routeRefs(head), {
    changed: (b, h) => {
      const before = requirements(b);
      const after = requirements(h);
      const id = routeKey(h.route);
      const added = [...after].filter((r) => !before.has(r));
      const removed = [...before].filter((r) => !after.has(r));
      const findings: Finding[] = [];
      if (added.length > 0) findings.push({ breaking: before.size === 0, detail: `${added.join(', ')} now required on ${id}` });
      if (removed.length > 0) findings.push({ breaking: false, detail: `${removed.join(', ')} no longer required on ${id}` });
      return findings;
    },
  }).filter((c) => c.kind === 'changed');
}

function diffRoutes(base: Manifest, head: Manifest): Change[] {
  return diffKeyed<RouteRef>('routes', routeRefs(base), routeRefs(head), {
    removedBreaking: true,
    changed: (b, h) => compareRoute(b.route, h.route, base, head),
  });
}

const schemaFingerprint = (m: Manifest, t: TypeRef): string => canonicalize({ text: t.text, schema: t.schema ? m.schemas[t.schema] : undefined });

function socketEntries(m: Manifest): Keyed<string>[] {
  const entries: Keyed<string>[] = [];
  for (const c of m.socketControllers) {
    for (const cmd of c.commands) entries.push({ key: `${c.prefix}:${cmd.name}`, item: `${schemaFingerprint(m, cmd.payload)}>${schemaFingerprint(m, cmd.result)}` });
    for (const e of c.events) entries.push({ key: `${c.prefix}#${e.name}`, item: schemaFingerprint(m, e.payload) });
  }
  for (const c of m.socketContracts) {
    for (const [name, cmd] of Object.entries(c.commands)) entries.push({ key: `${c.id}:${name}`, item: `${schemaFingerprint(m, cmd.payload)}>${schemaFingerprint(m, cmd.result)}` });
    for (const [name, t] of Object.entries(c.events)) entries.push({ key: `${c.id}#${name}`, item: schemaFingerprint(m, t) });
    for (const [name, t] of Object.entries(c.clientEvents)) entries.push({ key: `${c.id}<${name}`, item: schemaFingerprint(m, t) });
  }
  return entries;
}

const byKey = <T>(items: T[], key: (item: T) => string): Keyed<T>[] => items.map((item) => ({ key: key(item), item }));
const schemaEntries = (m: Manifest): Keyed<unknown>[] => Object.entries(m.schemas).map(([key, item]) => ({ key, item }));

function diffMisc(base: Manifest, head: Manifest): Change[] {
  const changedIf = (b: unknown, h: unknown, what: string): string | undefined => (differs(b, h) ? what : undefined);

  return [
    ...diffKeyed('schemas', schemaEntries(base), schemaEntries(head), { changed: (b, h) => changedIf(b, h, 'schema changed') }),
    ...diffKeyed('config', byKey(base.configModules, (c) => c.module), byKey(head.configModules, (c) => c.module), {
      removedBreaking: true,
      changed: (b, h) => changedIf([b.schemaId, base.schemas[b.schemaId]], [h.schemaId, head.schemas[h.schemaId]], 'config schema changed'),
    }),
    ...diffKeyed('migrations', byKey(base.migrations, (m) => m.id), byKey(head.migrations, (m) => m.id), {
      removedBreaking: true,
      changed: (b, h) => changedIf([b.connection, b.env, b.file], [h.connection, h.env, h.file], 'migration settings changed'),
    }),
    ...diffKeyed('services', byKey(base.services, (s) => s.id), byKey(head.services, (s) => s.id), {
      changed: (b, h) => changedIf([b.registeredAs, b.lifetime, b.async], [h.registeredAs, h.lifetime, h.async], 'registration changed'),
    }),
    ...diffKeyed('commands', byKey(base.commands, (c) => c.name), byKey(head.commands, (c) => c.name), {
      changed: (b, h) => changedIf([b.options, b.arguments], [h.options, h.arguments], 'options or arguments changed'),
    }),
    ...diffKeyed('socket', socketEntries(base), socketEntries(head), { changed: (b, h) => changedIf(b, h, 'payload or result changed') }),
  ];
}

export function diffManifest(base: Manifest, head: Manifest): ManifestDiff {
  const all = [...diffRoutes(base, head), ...diffPermissions(base, head), ...diffMisc(base, head)];
  const changes = all.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || compareCodeUnits(a.id, b.id) || compareCodeUnits(a.kind, b.kind));
  return { base: base.hash, head: head.hash, changes, breaking: changes.some((c) => c.breaking) };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const short = (hash: string): string => hash.slice(0, 12);

export function renderMarkdown(diff: ManifestDiff): string {
  const lines: string[] = [];
  const breakingCount = diff.changes.filter((c) => c.breaking).length;
  const verdict = diff.changes.length === 0 ? 'no changes' : diff.breaking ? `**BREAKING** (${breakingCount} breaking of ${diff.changes.length} changes)` : `non-breaking (${diff.changes.length} changes)`;

  lines.push('## Manifest diff', '', `Result: ${verdict}`, '', `\`${short(diff.base)}\` -> \`${short(diff.head)}\``);

  for (const section of SECTIONS) {
    const changes = diff.changes.filter((c) => c.section === section);
    if (changes.length === 0) continue;
    lines.push('', `### ${section}`, '', '| Change | Id | Breaking | Detail |', '| --- | --- | --- | --- |');
    for (const c of changes) lines.push(`| ${c.kind} | \`${cell(c.id)}\` | ${c.breaking ? 'yes' : 'no'} | ${cell(c.detail ?? '')} |`);
  }
  return `${lines.join('\n')}\n`;
}
