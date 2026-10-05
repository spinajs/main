import { TRUE } from '@spinajs/authz';
import type { Decision as EngineDecision, DenyReason as EngineDenyReason, Principal as EnginePrincipal, ResourceRef } from '@spinajs/authz';
import * as chai from 'chai';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CAPABILITY_NAMES } from './c6/access.js';
import type { Capability } from './c6/access.js';
import type { Principal, Resource } from './c6/authz.js';
import { canvasAuthzConfig } from './config.js';
import { AgentScopeError, agentPrincipal, C6Facade, toDecision, toDenyReason, toPermission, toPrincipal, toResourceRef } from './facade.js';
import type { AgentPrincipal, C6FacadeDeps, CheckRequest } from './facade.js';
import { CANVAS_FIXTURES_DIR, loadCanvasFixtures } from './fixtures.js';
import { parseBranchId } from './scope.js';

const expect = chai.expect;

const capabilities: unknown = JSON.parse(readFileSync(`${CANVAS_FIXTURES_DIR}capabilities.json`, 'utf8'));
const ORG_PERMISSIONS = ['org:manage', 'org:billing', 'audit:read'];

const user = (id: string) => ({ type: 'user', id, attributes: {}, authenticated: true, source: 'session' });

function engineDecision(over: { allowed: boolean; residual?: EngineDecision['residual']; roles?: Record<string, string>; reason?: EngineDenyReason; permission?: string }): EngineDecision {
  return {
    allowed: over.allowed,
    permission: over.permission ?? 'project:read',
    resource: { type: 'project', id: 'P' },
    principal: { type: 'user', id: 'U' },
    residual: over.residual ?? (over.allowed ? TRUE : { op: 'false' }),
    fields: { read: [], write: [] },
    roles: over.roles ?? {},
    ...(over.reason ? { reason: over.reason } : {}),
    domain: 'default',
  };
}

const deny = (reason: EngineDenyReason, permission = 'file:edit') => toDecision(engineDecision({ allowed: false, reason }), permission, ORG_PERMISSIONS);

const agent = (scope: AgentPrincipal['scope'], on_behalf_of = 'ED'): AgentPrincipal => ({ kind: 'agent', session: 'S1', task: 'T1', on_behalf_of, scope });

const FILES = new Map([
  ['F1', 'P1'],
  ['F2', 'P1'],
  ['F3', 'P2'],
]);
const fileProject = (f: string) => FILES.get(f);

interface Fakes {
  deps: C6FacadeDeps;
  checks: CheckRequest[];
  links: { id: string; companion?: EnginePrincipal }[];
  linkResult: EnginePrincipal;
}

function fakes(answer: EngineDecision = engineDecision({ allowed: true, roles: { project: 'editor' } })): Fakes {
  const checks: CheckRequest[] = [];
  const links: Fakes['links'] = [];
  const linkResult: EnginePrincipal = Object.freeze({ type: 'link', id: 'authz-link', authenticated: true, source: 'link', attributes: Object.freeze({ org_only: false }) });
  const deps: C6FacadeDeps = {
    check: async (req) => {
      checks.push(req);
      return answer;
    },
    linkPrincipal: async (id, companion) => {
      links.push(companion === undefined ? { id } : { id, companion });
      return linkResult;
    },
    linkIds: new Map([['C6-LINK', 'authz-link']]),
    capabilities,
    fileProject,
  };
  return { deps, checks, links, linkResult };
}

describe('canvas c6 facade', () => {
  describe('capabilities', () => {
    it('maps x.y to x:y and export to project:export', () => {
      expect(toPermission('project.read')).to.equal('project:read');
      expect(toPermission('export')).to.equal('project:export');
      expect(toPermission('org.billing')).to.equal('org:billing');
      expect(toPermission('repo.push')).to.equal('repo:push');
    });

    it('maps every capability to a permission of the generated config', () => {
      const permissions = Object.keys(canvasAuthzConfig(capabilities).permissions);
      expect(CAPABILITY_NAMES.map(toPermission)).to.deep.equal(permissions);
    });
  });

  describe('resources', () => {
    it('maps org, project and file to typed refs', () => {
      assert.deepStrictEqual(toResourceRef({ kind: 'org', org: 'O' }), { type: 'org', id: 'O' });
      assert.deepStrictEqual(toResourceRef({ kind: 'project', project: 'P' }), { type: 'project', id: 'P' });
      assert.deepStrictEqual(toResourceRef({ kind: 'file', file: 'F' }), { type: 'file', id: 'F' });
    });

    it('maps a branch with a file through branchRef', () => {
      const ref = toResourceRef({ kind: 'branch', project: 'P', file: 'F', branch: 'release/1:x' });
      expect(ref.type).to.equal('branch');
      assert.deepStrictEqual(parseBranchId(ref.id!), { project: 'P', file: 'F', name: 'release/1:x' });
    });

    it('maps a branch without a file through branchRef', () => {
      const ref = toResourceRef({ kind: 'branch', project: 'P', file: null, branch: 'main' });
      expect(ref.type).to.equal('branch');
      assert.deepStrictEqual(parseBranchId(ref.id!), { project: 'P', file: null, name: 'main' });
    });
  });

  describe('principals', () => {
    it('maps a user to a frozen session user', async () => {
      const p = await toPrincipal({ kind: 'user', user: 'U1' }, fakes().deps);
      assert.deepStrictEqual(p, user('U1'));
      expect(Object.isFrozen(p)).to.equal(true);
    });

    it('maps a group to a group principal', async () => {
      const p = await toPrincipal({ kind: 'group', group: 'G1' }, fakes().deps);
      assert.deepStrictEqual(p, { type: 'group', id: 'G1', attributes: {}, authenticated: true, source: 'session' });
    });

    it('asks linkPrincipal for a signed-in link with the user as companion', async () => {
      const f = fakes();
      const p = await toPrincipal({ kind: 'link', link: 'C6-LINK', user: 'U1' }, f.deps);
      expect(p).to.equal(f.linkResult);
      assert.deepStrictEqual(f.links, [{ id: 'authz-link', companion: user('U1') }]);
    });

    it('asks linkPrincipal for an anonymous link without a companion', async () => {
      const f = fakes();
      await toPrincipal({ kind: 'link', link: 'C6-LINK', user: null }, f.deps);
      assert.deepStrictEqual(f.links, [{ id: 'authz-link' }]);
    });

    it('passes an unknown link id through unchanged', async () => {
      const f = fakes();
      await toPrincipal({ kind: 'link', link: 'NOT-LOADED', user: null }, f.deps);
      assert.deepStrictEqual(f.links, [{ id: 'NOT-LOADED' }]);
    });

    it('maps an agent with all files of its projects to a project ceiling', () => {
      const p = agentPrincipal(agent({ projects: ['P1', 'P2'], files: null, capabilities: ['file.edit', 'export'] }), fileProject);
      assert.deepStrictEqual(p, {
        type: 'agent',
        id: 'S1',
        attributes: {},
        authenticated: true,
        source: 'token',
        onBehalfOf: user('ED'),
        delegation: 'inherit',
        ceiling: {
          permissions: ['file:edit', 'project:export'],
          resources: [
            { type: 'project', id: 'P1' },
            { type: 'project', id: 'P2' },
          ],
          reason: 'out_of_scope',
        },
      });
      expect(Object.isFrozen(p)).to.equal(true);
      expect(Object.isFrozen(p.ceiling)).to.equal(true);
    });

    it('maps an agent with listed files to a file ceiling', () => {
      const p = agentPrincipal(agent({ projects: ['P1', 'P2'], files: ['F1', 'F3'], capabilities: ['project.read'] }), fileProject);
      assert.deepStrictEqual(p.ceiling, {
        permissions: ['project:read'],
        resources: [
          { type: 'file', id: 'F1' },
          { type: 'file', id: 'F3' },
        ],
        reason: 'out_of_scope',
      });
    });

    it('maps an agent with no files to a ceiling that covers nothing', () => {
      const p = agentPrincipal(agent({ projects: ['P1'], files: [], capabilities: [] }), fileProject);
      assert.deepStrictEqual(p.ceiling, { permissions: [], resources: [], reason: 'out_of_scope' });
    });

    it('refuses an agent with a file outside its projects', () => {
      expect(() => agentPrincipal(agent({ projects: ['P1'], files: ['F1', 'F3'], capabilities: ['project.read'] }), fileProject)).to.throw(AgentScopeError, /F3.*P2/);
    });

    it('refuses an agent with an unknown file', () => {
      expect(() => agentPrincipal(agent({ projects: ['P1'], files: ['GHOST'], capabilities: ['project.read'] }), fileProject)).to.throw(AgentScopeError, /GHOST/);
    });

    it('goes through toPrincipal for an agent', async () => {
      const a = agent({ projects: ['P1'], files: null, capabilities: ['file.edit'] });
      assert.deepStrictEqual(await toPrincipal(a, fakes().deps), agentPrincipal(a, fileProject));
    });

    it('builds every agent of the fixture cases', () => {
      const fx = loadCanvasFixtures();
      const agents = fx.cases.map((c) => c.principal).filter((p): p is AgentPrincipal => p.kind === 'agent');
      expect(agents).to.have.length(6);
      for (const a of agents) {
        const p = agentPrincipal(a, (f) => fx.state.files.get(f)?.project);
        expect(p.ceiling!.resources).to.have.length(a.scope.files === null ? a.scope.projects.length : a.scope.files.length);
      }
    });
  });

  describe('decisions', () => {
    it('maps an unconditional allow to roles.project', () => {
      assert.deepStrictEqual(toDecision(engineDecision({ allowed: true, roles: { project: 'editor', org: 'org.member' } }), 'file:edit', ORG_PERMISSIONS), { allowed: true, role: 'editor' });
    });

    it('reports role none for an allow without a project role', () => {
      assert.deepStrictEqual(toDecision(engineDecision({ allowed: true, roles: { org: 'org.owner' } }), 'org:billing', ORG_PERMISSIONS), { allowed: true, role: 'none' });
    });

    it('turns a conditional residual into the unmapped deny residual', () => {
      const d = engineDecision({ allowed: true, residual: { op: 'cmp', field: 'name', cmp: 'eq', value: 'x' }, roles: { project: 'viewer' } });
      assert.deepStrictEqual(toDecision(d, 'project:read', ORG_PERMISSIONS), { allowed: false, reason: { code: 'residual' } });
    });

    it('renames tag_missing to addon_missing', () => {
      assert.deepStrictEqual(deny({ code: 'tag_missing', tag: 'inspect', model: 'rbac', priority: 420 }, 'inspect:view'), { allowed: false, reason: { code: 'addon_missing', addon: 'inspect' } });
    });

    it('renames provenance to file_only and drops needed', () => {
      assert.deepStrictEqual(deny({ code: 'provenance', needed: ['project', 'org'], model: 'rbac', priority: 430 }, 'repo:read'), { allowed: false, reason: { code: 'file_only' } });
    });

    it('keeps role and needed of role_too_low and drops the engine keys', () => {
      assert.deepStrictEqual(deny({ code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor', model: 'rbac', priority: 410 }), { allowed: false, reason: { code: 'role_too_low', role: 'viewer', needed: 'editor' } });
      assert.deepStrictEqual(deny({ code: 'role_too_low', ladder: 'project', role: 'commenter', needed: 'editor', model: 'rbac', priority: 440 }, 'branch:create'), { allowed: false, reason: { code: 'role_too_low', role: 'commenter', needed: 'editor' } });
    });

    it('reports role none for role_too_low without a role', () => {
      assert.deepStrictEqual(deny({ code: 'role_too_low', ladder: 'project', needed: 'editor', model: 'rbac' }), { allowed: false, reason: { code: 'role_too_low', role: 'none', needed: 'editor' } });
    });

    for (const permission of ORG_PERMISSIONS) {
      it(`renames role_too_low and no_access on ${permission} to org_role_needed`, () => {
        assert.deepStrictEqual(deny({ code: 'role_too_low', ladder: 'org', role: 'org.member', needed: 'org.admin', model: 'rbac', priority: 410 }, permission), { allowed: false, reason: { code: 'org_role_needed' } });
        assert.deepStrictEqual(deny({ code: 'no_access', model: 'rbac', priority: 400 }, permission), { allowed: false, reason: { code: 'org_role_needed' } });
      });
    }

    it('keeps other codes on an org-level permission', () => {
      assert.deepStrictEqual(deny({ code: 'link_invalid', priority: 200 }, 'org:manage'), { allowed: false, reason: { code: 'link_invalid' } });
      assert.deepStrictEqual(deny({ code: 'agents_disabled', model: 'abac', priority: 100 }, 'audit:read'), { allowed: false, reason: { code: 'agents_disabled' } });
    });

    it('keeps no_access on a project-level permission', () => {
      assert.deepStrictEqual(deny({ code: 'no_access', model: 'rbac', priority: 400 }, 'project:read'), { allowed: false, reason: { code: 'no_access' } });
    });

    it('keeps only rule of policy', () => {
      assert.deepStrictEqual(deny({ code: 'policy', rule: 'no_download', model: 'rbac', priority: 600, sortKey: 'no-download' }, 'project:export'), { allowed: false, reason: { code: 'policy', rule: 'no_download' } });
    });

    it('keeps only pattern and needed of branch_protected', () => {
      assert.deepStrictEqual(deny({ code: 'branch_protected', pattern: 'release/*', needed: 'maintainer', model: 'rbac', priority: 700, sortKey: 'release/*', ladder: 'project' }), { allowed: false, reason: { code: 'branch_protected', pattern: 'release/*', needed: 'maintainer' } });
    });

    for (const code of ['link_invalid', 'out_of_scope', 'agents_disabled', 'no_access', 'unknown_resource']) {
      it(`keeps ${code} without payload`, () => {
        assert.deepStrictEqual(deny({ code, model: 'rbac', priority: 300, sortKey: 'k', ladder: 'org', extra: 1 }), { allowed: false, reason: { code } });
      });
    }

    it('passes an unknown code through with its payload and without the engine keys', () => {
      assert.deepStrictEqual(deny({ code: 'ceiling', priority: 200 }), { allowed: false, reason: { code: 'ceiling' } });
      assert.deepStrictEqual(deny({ code: 'model_error', model: 'abac', priority: 900, error: 'boom' }), { allowed: false, reason: { code: 'model_error', error: 'boom' } });
      assert.deepStrictEqual(toDenyReason({ code: 'delegate', ladder: 'project', depth: 3 }, false), { code: 'delegate', depth: 3 });
    });

    it('marks a deny without a reason as no_reason', () => {
      assert.deepStrictEqual(toDecision(engineDecision({ allowed: false }), 'project:read', ORG_PERMISSIONS), { allowed: false, reason: { code: 'no_reason' } });
    });

    it('accepts the org-level permissions as a set', () => {
      assert.deepStrictEqual(toDecision(engineDecision({ allowed: false, reason: { code: 'no_access' } }), 'org:manage', new Set(ORG_PERMISSIONS)), { allowed: false, reason: { code: 'org_role_needed' } });
    });
  });

  describe('C6Facade', () => {
    async function can(f: Fakes, principal: Principal, capability: Capability, resource: Resource) {
      return new C6Facade(f.deps).can(principal, capability, resource);
    }

    it('sends the mapped request and maps the answer', async () => {
      const f = fakes();
      const d = await can(f, { kind: 'user', user: 'U1' }, 'export', { kind: 'branch', project: 'P', file: null, branch: 'main' });
      assert.deepStrictEqual(d, { allowed: true, role: 'editor' });
      expect(f.checks).to.have.length(1);
      const req = f.checks[0];
      assert.deepStrictEqual(req, { principal: user('U1'), permission: 'project:export', resource: toResourceRef({ kind: 'branch', project: 'P', file: null, branch: 'main' }) as ResourceRef });
    });

    it('sends the principal linkPrincipal returned', async () => {
      const f = fakes();
      await can(f, { kind: 'link', link: 'C6-LINK', user: 'U1' }, 'project.read', { kind: 'project', project: 'P' });
      expect(f.checks[0].principal).to.equal(f.linkResult);
      assert.deepStrictEqual(f.links, [{ id: 'authz-link', companion: user('U1') }]);
    });

    it('sends an agent principal', async () => {
      const f = fakes();
      const a = agent({ projects: ['P1'], files: ['F2'], capabilities: ['file.edit'] });
      await can(f, a, 'file.edit', { kind: 'file', file: 'F2' });
      assert.deepStrictEqual(f.checks[0], { principal: agentPrincipal(a, fileProject), permission: 'file:edit', resource: { type: 'file', id: 'F2' } });
    });

    it('rejects an agent outside its projects without a check', async () => {
      const f = fakes();
      const a = agent({ projects: ['P2'], files: ['F1'], capabilities: ['file.edit'] });
      let error: unknown;
      await can(f, a, 'file.edit', { kind: 'file', file: 'F1' }).catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(AgentScopeError);
      expect(f.checks).to.have.length(0);
    });

    it('renames on org-level capabilities from the capability table', async () => {
      const f = fakes(engineDecision({ allowed: false, reason: { code: 'role_too_low', ladder: 'org', role: 'org.admin', needed: 'org.owner', model: 'rbac', priority: 410 } }));
      assert.deepStrictEqual(await can(f, { kind: 'user', user: 'U1' }, 'org.billing', { kind: 'org', org: 'O' }), { allowed: false, reason: { code: 'org_role_needed' } });
      assert.deepStrictEqual(await can(f, { kind: 'user', user: 'U1' }, 'file.edit', { kind: 'file', file: 'F1' }), { allowed: false, reason: { code: 'role_too_low', role: 'org.admin', needed: 'org.owner' } });
    });
  });
});
