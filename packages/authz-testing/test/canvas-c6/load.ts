import { createHash } from 'node:crypto';

import { SYSTEM } from '@spinajs/authz';
import type { AuthzAdmin, AuthzAdminError, AuthzCommand, AuthzCommandResult, ResourceRef } from '@spinajs/authz';

import { defaultAddons } from './c6/access.js';
import type { Role } from './c6/access.js';
import type { BranchRule, Grant, Grantee } from './c6/state.js';
import { branchRulePermissions } from './config.js';
import type { CapabilityTable } from './config.js';
import type { CanvasFixtures } from './fixtures.js';

export interface CanvasLoadOptions {
  capabilities: CapabilityTable | unknown;
  /** Must lie after the admin clock: `link.create` refuses a past expiry. The run advances the clock past it. */
  expiredLinkExpiry: Date;
  /** `authz.admin.maxBatch`, default 100. */
  maxBatch?: number;
}

export interface CanvasBatch {
  org: string;
  commands: AuthzCommand[];
}

export interface CanvasLoad {
  /** C6 link UUID to the id AuthzAdmin gave the link. */
  linkIds: ReadonlyMap<string, string>;
  /** C6 link UUID to its bearer token. */
  tokens: ReadonlyMap<string, string>;
  /** Per org UUID, the results of its batch. */
  results: ReadonlyMap<string, readonly AuthzCommandResult[]>;
}

type Subject = Extract<AuthzCommand, { kind: 'assignment.grant' }>['subject'];
type Rule = Extract<AuthzCommand, { kind: 'rule.put' }>['rule'];

const DEFAULT_MAX_BATCH = 100;
// authz_rule.id is varchar(160) and reason.sortKey varchar(255) (rule-sql-form LEN).
const RULE_ID_MAX = 160;
const SORT_KEY_MAX = 255;

const ref = (type: 'org' | 'group' | 'project' | 'file', id: string): ResourceRef => ({ type, id });

/** A rule id carries the raw pattern; a pattern that would overflow the id column is replaced by its sha256. */
function branchRuleId(project: string, pattern: string, suffix: 'push' | 'merge'): string {
  const raw = `branch:${project}:${pattern}:${suffix}`;
  if (raw.length <= RULE_ID_MAX) return raw;
  return `branch:${project}:sha256-${createHash('sha256').update(pattern).digest('hex')}:${suffix}`;
}

export function canvasCommands(fixtures: CanvasFixtures, opts: CanvasLoadOptions): CanvasBatch[] {
  const { state } = fixtures;
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  const { push, merge } = branchRulePermissions(opts.capabilities);
  const sym = fixtures.symbolOf;

  const subjectOf = (g: Grantee, what: string): Subject => {
    if (g.kind === 'user') return { type: 'user', id: g.id };
    if (!state.groups.has(g.id)) throw new Error(`${what}: unknown group ${sym(g.id)}`);
    return { set: { role: 'group.member', scope: ref('group', g.id) } };
  };

  const grantCommand = (g: Grant, scope: ResourceRef, what: string): AuthzCommand => ({
    kind: 'assignment.grant',
    subject: subjectOf(g.grantee, what),
    role: g.role,
    scope,
    tags: [...g.addons],
    replaceLadder: true,
  });

  const branchRows = (project: string, rule: BranchRule): AuthzCommand[] => {
    const what = `project ${sym(project)} branch rule ${JSON.stringify(rule.pattern)}`;
    if (rule.pattern === '') throw new Error(`${what}: empty pattern`);
    if (rule.pattern.length > SORT_KEY_MAX) throw new Error(`${what}: pattern longer than the ${SORT_KEY_MAX} character sortKey`);
    const row = (suffix: 'push' | 'merge', permissions: string[], minRole: Role): AuthzCommand => ({
      kind: 'rule.put',
      rule: {
        id: branchRuleId(project, rule.pattern, suffix),
        kind: 'threshold',
        scope: ref('project', project),
        resourceTypes: ['branch'],
        resource: { attr: 'resource.name', wildcard: rule.pattern },
        permissions,
        minRole,
        reason: { code: 'branch_protected', pattern: rule.pattern, needed: minRole, priority: 700, sortKey: rule.pattern },
      } as Rule,
    });
    return [row('push', push, rule.push_role), row('merge', merge, rule.merge_role)];
  };

  for (const [id, g] of state.groups) if (!state.orgs.has(g.org)) throw new Error(`group ${sym(id)}: unknown org ${sym(g.org)}`);
  for (const [id, p] of state.projects) if (!state.orgs.has(p.org)) throw new Error(`project ${sym(id)}: unknown org ${sym(p.org)}`);
  for (const [id, f] of state.files) if (!state.projects.has(f.project)) throw new Error(`file ${sym(id)}: unknown project ${sym(f.project)}`);
  for (const [id, l] of state.links) {
    if (!state.projects.has(l.project)) throw new Error(`link ${sym(id)}: unknown project ${sym(l.project)}`);
    if (l.file !== null && state.files.get(l.file)?.project !== l.project) throw new Error(`link ${sym(id)}: file ${l.file === null ? '' : sym(l.file)} is not in project ${sym(l.project)}`);
  }

  const batches: CanvasBatch[] = [];
  for (const [orgId, org] of state.orgs) {
    const O = ref('org', orgId);
    const projects = [...state.projects].filter(([, p]) => p.org === orgId);
    const projectIds = new Set(projects.map(([id]) => id));
    const files = [...state.files].filter(([, f]) => projectIds.has(f.project));
    const c: AuthzCommand[] = [];

    for (const [user, role] of org.members) c.push({ kind: 'assignment.grant', subject: { type: 'user', id: user }, role: `org.${role}`, scope: O, replaceLadder: true });

    for (const [groupId, g] of state.groups) {
      if (g.org !== orgId) continue;
      for (const user of g.members) c.push({ kind: 'set.addMember', set: { role: 'group.member', scope: ref('group', groupId) }, member: { type: 'user', id: user } });
    }

    for (const [id, p] of projects) for (const g of p.grants) c.push(grantCommand(g, ref('project', id), `project ${sym(id)} grant`));
    for (const [id, f] of files) for (const g of f.grants) c.push(grantCommand(g, ref('file', id), `file ${sym(id)} grant`));

    for (const [id, p] of projects) {
      if (p.org_default_role === 'none') continue;
      c.push({ kind: 'assignment.grant', subject: { set: { role: 'org.member', scope: O } }, role: p.org_default_role, scope: ref('project', id), tags: defaultAddons(p.org_default_role), replaceLadder: true });
    }

    for (const [id, f] of files) {
      if (f.restricted_to === null) continue;
      c.push({ kind: 'rule.put', rule: { id: `restrict:file:${id}`, kind: 'restrict', scope: ref('file', id), allow: f.restricted_to.map((g) => subjectOf(g, `file ${sym(id)} restricted_to`)) } as Rule });
    }

    for (const [id, p] of projects) {
      const seen = new Set<string>();
      for (const rule of p.branch_rules) {
        if (seen.has(rule.pattern)) throw new Error(`project ${sym(id)}: duplicate branch rule pattern ${JSON.stringify(rule.pattern)}`);
        seen.add(rule.pattern);
        c.push(...branchRows(id, rule));
      }
    }

    for (const [, l] of state.links) {
      if (!projectIds.has(l.project)) continue;
      c.push({
        kind: 'link.create',
        scope: l.file === null ? ref('project', l.project) : ref('file', l.file),
        role: l.role,
        tags: [...l.addons],
        expiresAt: l.expired ? opts.expiredLinkExpiry : null,
        attributes: { org_only: l.org_only },
      });
    }

    const policies = fixtures.explicitPolicies.get(orgId);
    if (policies !== undefined && Object.keys(policies).length > 0) c.push({ kind: 'scope.setAttributes', scope: O, patch: { policies: { ...policies } } });

    if (c.length > maxBatch) throw new Error(`org ${sym(orgId)}: ${c.length} commands exceed authz.admin.maxBatch (${maxBatch})`);
    batches.push({ org: orgId, commands: c });
  }
  return batches;
}

const describeError = (e: AuthzAdminError): string => `${e.code}: ${e.message}${e.field === undefined ? '' : ` (field ${e.field})`}`;

export async function loadCanvasState(admin: Pick<AuthzAdmin, 'execute'>, fixtures: CanvasFixtures, opts: CanvasLoadOptions): Promise<CanvasLoad> {
  const linkIds = new Map<string, string>();
  const tokens = new Map<string, string>();
  const results = new Map<string, readonly AuthzCommandResult[]>();
  const linksOf = (org: string): string[] => [...fixtures.state.links].filter(([, l]) => fixtures.state.projects.get(l.project)?.org === org).map(([id]) => id);

  for (const batch of canvasCommands(fixtures, opts)) {
    const where = `canvas c6 load: org ${fixtures.symbolOf(batch.org)}`;
    const res = await admin.execute(SYSTEM, batch.commands, { reason: 'canvas c6 state load' });
    results.set(batch.org, res);
    res.forEach((r, i) => {
      if (!r.ok) throw new Error(`${where} command ${i} (${r.kind}) failed: ${describeError(r.error)}`);
    });
    if (res.length !== batch.commands.length) throw new Error(`${where}: ${res.length} results for ${batch.commands.length} commands`);

    const order = linksOf(batch.org);
    let next = 0;
    res.forEach((r, i) => {
      if (batch.commands[i].kind !== 'link.create' || !r.ok) return;
      if (r.id === undefined || r.token === undefined) throw new Error(`${where} command ${i}: link.create returned no id or token`);
      const c6 = order[next++];
      linkIds.set(c6, r.id);
      tokens.set(c6, r.token);
    });
  }
  return { linkIds, tokens, results };
}
