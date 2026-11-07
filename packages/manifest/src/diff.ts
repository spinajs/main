import { loadsFromManifest, publishedManifest } from './mounted.js';
import { canonicalize } from './hash.js';
import { compareSchemaRefs } from './schema-compare.js';
import type { Finding } from './schema-compare.js';
import type { ColumnSqlSpec, ControllerEntry, Manifest, ModelColumn, ParamEntry, PolicyRef, RouteEntry, TypeRef, WorkflowEntry } from './types.js';

export type ChangeKind = 'added' | 'removed' | 'changed';
export interface Change { section: 'routes' | 'schemas' | 'permissions' | 'config' | 'migrations' | 'models' | 'services' | 'commands' | 'socket' | 'workflows'; kind: ChangeKind; id: string; breaking: boolean; detail?: string }
export interface ManifestDiff {
  base: string;
  head: string;
  changes: Change[];
  breaking: boolean;
  /** Reasons the changes may not all come from the code, such as base and head built by different compilers. Absent when there are none. */
  warnings?: string[];
}

type Section = Change['section'];
const SECTIONS: Section[] = ['routes', 'permissions', 'schemas', 'config', 'migrations', 'models', 'services', 'commands', 'socket', 'workflows'];

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
// Kinds of injected and user-agent arguments, for params recorded without `wire`; `Req`/`Res` are what compilers before the runtime names wrote.
const NOT_SENT_KINDS = new Set(['FromDi', 'ArgAsRequest', 'ArgAsResponse', 'Req', 'Res', 'IpRouteArgs', 'RequestIdRouteArgs', 'UserAgentRouteArgs', 'RefererRouteArgs', 'RequestTypeRouteArgs', 'FromModel']);
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

/** A route only a registration serves is no part of the contract, but who may call it, if it runs, is worth a reviewer's eye. */
function diffFlaggedPermissions(base: Manifest, head: Manifest): Change[] {
  const flagged = (m: Manifest): Manifest => {
    const published = new Set(publishedManifest(m).controllers);
    return { ...m, controllers: m.controllers.filter((c) => !loadsFromManifest(c) && !published.has(c)) };
  };
  return diffPermissions(flagged(base), flagged(head)).map((c) => ({ ...c, breaking: false, detail: `${c.detail ?? ''}; the route is served only if a registration runs` }));
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
    // A removed version strands its unfinished instances, hence breaking.
    ...diffKeyed('workflows', byKey(base.workflows ?? [], (w) => `${w.name}@${w.version}`), byKey(head.workflows ?? [], (w) => `${w.name}@${w.version}`), {
      removedBreaking: true,
      changed: workflowChanges,
    }),
  ];
}

const signalKeys = (w: WorkflowEntry): string[] => w.signals.map((s) => `${s.name}\u0000${s.permission ?? ''}`).sort(compareCodeUnits);

/** The permissions each signal is waited for with, `''` for none. */
function signalPermissions(w: WorkflowEntry): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of w.signals) out.set(s.name, (out.get(s.name) ?? new Set<string>()).add(s.permission ?? ''));
  return out;
}

/** A sender breaks when a signal it sends goes away or newly needs a permission; a new signal breaks no one. */
function workflowChanges(b: WorkflowEntry, h: WorkflowEntry): Finding[] {
  const findings: Finding[] = [];
  if (b.className !== h.className) findings.push({ breaking: false, detail: 'class changed' });
  if (differs(signalKeys(b), signalKeys(h))) {
    const after = signalPermissions(h);
    const breaking = [...signalPermissions(b)].some(([name, before]) => {
      const now = after.get(name);
      return !now || [...now].some((p) => p !== '' && !before.has(p));
    });
    findings.push({ breaking, detail: 'signals changed' });
  }
  return findings;
}

function compilerWarnings(base: Manifest, head: Manifest): string[] {
  if (base.compilerVersion === head.compilerVersion) return [];
  const version = (m: Manifest): string => m.compilerVersion ?? 'unrecorded';
  return [
    `base and head were built by different compilers (@spinajs/compiler ${version(base)} and ${version(head)}): a change in what the compiler records, such as inherited routes, shows up as a change. Rebuild the base with the head's compiler to compare like with like.`,
  ];
}

const SIZES = ['length', 'precision', 'scale'] as const;

function compareSpec(name: string, b: ColumnSqlSpec, h: ColumnSqlSpec): Finding[] {
  if (!b.inferred && !h.inferred && b.family !== h.family) return [{ breaking: true, detail: `column ${name} changed from ${b.family} to ${h.family}` }];
  const narrowed = SIZES.filter((k) => {
    const before = b[k];
    const after = h[k];
    return before !== undefined && after !== undefined && after < before;
  });
  if (narrowed.length > 0) return [{ breaking: true, detail: `column ${name} narrowed (${narrowed.map((k) => `${k} ${String(b[k])} -> ${String(h[k])}`).join(', ')})` }];
  return differs(b, h) ? [{ breaking: false, detail: `column ${name} SQL spec changed` }] : [];
}

function compareColumn(name: string, b: ModelColumn, h: ModelColumn): Finding[] {
  const findings: Finding[] = [];
  if (b.nullable && !h.nullable) findings.push({ breaking: true, detail: `column ${name} is now NOT NULL` });
  if (!b.nullable && h.nullable) findings.push({ breaking: false, detail: `column ${name} is now nullable` });
  if (b.sql && h.sql) findings.push(...compareSpec(name, b.sql, h.sql));
  return findings;
}

function compareTable(b: Map<string, ModelColumn>, h: Map<string, ModelColumn>): Finding[] {
  const findings: Finding[] = [];
  for (const [name, column] of b) {
    const next = h.get(name);
    findings.push(...(next ? compareColumn(name, column, next) : [{ breaking: true, detail: `column ${name} removed` }]));
  }
  for (const [name, column] of h) {
    if (!b.has(name)) findings.push({ breaking: false, detail: `column ${name} added${column.nullable ? '' : ' (NOT NULL)'}` });
  }
  return findings;
}

/** A table is the union of the models mapped to it (D19). */
function tables(m: Manifest): Keyed<Map<string, ModelColumn>>[] {
  const out = new Map<string, Map<string, ModelColumn>>();
  for (const model of m.models) {
    const key = `${model.connection ?? 'default'}:${model.tableName}`;
    const columns = out.get(key) ?? new Map<string, ModelColumn>();
    for (const c of model.columns) if (!columns.has(c.name)) columns.set(c.name, c);
    out.set(key, columns);
  }
  return [...out].map(([key, item]) => ({ key, item }));
}

function diffModels(base: Manifest, head: Manifest): Change[] {
  return diffKeyed('models', tables(base), tables(head), { removedBreaking: true, changed: compareTable });
}

export function diffManifest(baseManifest: Manifest, headManifest: Manifest): ManifestDiff {
  const base = publishedManifest(baseManifest);
  const head = publishedManifest(headManifest);
  const all = [...diffRoutes(base, head), ...diffPermissions(base, head), ...diffFlaggedPermissions(baseManifest, headManifest), ...diffMisc(base, head), ...diffModels(base, head)];
  const changes = all.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || compareCodeUnits(a.id, b.id) || compareCodeUnits(a.kind, b.kind));
  const warnings = compilerWarnings(baseManifest, headManifest);
  return { base: base.hash, head: head.hash, changes, breaking: changes.some((c) => c.breaking), ...(warnings.length > 0 ? { warnings } : {}) };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const short = (hash: string): string => hash.slice(0, 12);

export function renderMarkdown(diff: ManifestDiff): string {
  const lines: string[] = [];
  const breakingCount = diff.changes.filter((c) => c.breaking).length;
  const verdict = diff.changes.length === 0 ? 'no changes' : diff.breaking ? `**BREAKING** (${breakingCount} breaking of ${diff.changes.length} changes)` : `non-breaking (${diff.changes.length} changes)`;

  lines.push('## Manifest diff', '', `Result: ${verdict}`, '');
  for (const warning of diff.warnings ?? []) lines.push(`> **Warning:** ${warning}`, '');
  lines.push(`\`${short(diff.base)}\` -> \`${short(diff.head)}\``);

  for (const section of SECTIONS) {
    const changes = diff.changes.filter((c) => c.section === section);
    if (changes.length === 0) continue;
    lines.push('', `### ${section}`, '', '| Change | Id | Breaking | Detail |', '| --- | --- | --- | --- |');
    for (const c of changes) lines.push(`| ${c.kind} | \`${cell(c.id)}\` | ${c.breaking ? 'yes' : 'no'} | ${cell(c.detail ?? '')} |`);
  }
  return `${lines.join('\n')}\n`;
}
