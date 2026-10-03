import { AuthzConfigError, FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Assignment, PermissionInput, ResourceRef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { DEFAULT_RBAC_EXTENSIONS, LadderExtension, MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacService, compileGrants, compileLadders, compileRoles, ladderEdges, modelTables } from '../../src/index.js';
import type { GrantDef, LadderDef, RbacExtension, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1: ResourceRef = { type: 'org', id: 'o1' };
const P1: ResourceRef = { type: 'project', id: 'p1' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const assignment = (id: string, roleName: string, scope: ResourceRef = GLOBAL): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope, source: 'test' });

const TYPES = ['org', 'project', 'file'];
const PERMISSIONS: PermissionInput[] = ['file:read', 'file:comment', 'file:edit', 'project:settings', 'org:audit'].map((name) => ({ name, types: TYPES }));

const LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'], resourceTypes: ['project', 'file'] },
  { name: 'org', roles: ['org.member', 'org.admin'] },
];
const ROLES: RoleDef[] = [role('viewer', ['file:read'], { ladder: 'project' }), role('commenter', ['file:comment'], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['project:settings', 'file:edit'], { ladder: 'project' }), role('org.member', [], { ladder: 'org' }), role('org.admin', ['org:audit'], { ladder: 'org' }), role('reader', ['file:read'])];

function registry() {
  const r = new PermissionRegistryImpl();
  r.register(PERMISSIONS, 'test');
  r.freeze();
  return r;
}

const edges = (roles: readonly RoleDef[], ladders: readonly LadderDef[]) => new LadderExtension().extraEdges(new Map(roles.map((r) => [r.name, r])), ladders);
const graphOf = (roles: readonly RoleDef[] = ROLES, ladders: readonly LadderDef[] = LADDERS) => compileRoles(roles, ladders, { extraEdges: new LadderExtension().extraEdges });

function refused(roles: readonly RoleDef[], ladders: readonly LadderDef[], ...parts: string[]): void {
  let thrown: unknown;
  try {
    graphOf(roles, ladders);
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected AuthzConfigError').to.be.instanceOf(AuthzConfigError);
  for (const part of parts) expect((thrown as Error).message).to.contain(part);
}

const scopes = new FakeScopeResolver({ types: TYPES, nodes: [{ ref: O1 }, { ref: P1, parent: O1 }, { ref: f1, parent: P1 }] });
const ctx = () => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

async function model(assignments: readonly Assignment[], roles: readonly RoleDef[] = ROLES, ladders: readonly LadderDef[] = LADDERS) {
  const m = new RbacModel({ roles: new MemoryRoleStore(roles, ladders), assignments: new MemoryAssignmentStore(assignments), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  m.grantIndex();
  return m;
}

const vote = async (m: RbacModel, permission: string, resource: ResourceRef): Promise<Vote> => m.evaluate({ principal: alice, permission, resource }, ctx());

describe('authz-rbac ladders: rank tables and implicit extends', () => {
  describe('ladder edges', () => {
    it('each ladder role holds the grants of every lower role of its ladder, nearest first', () => {
      const graph = graphOf();
      expect(graph.get('maintainer')!.closure).to.deep.equal(['maintainer', 'editor', 'commenter', 'viewer']);
      expect(graph.get('viewer')!.closure).to.deep.equal(['viewer']);
      expect(graph.get('org.admin')!.closure).to.deep.equal(['org.admin', 'org.member']);
      expect(graph.get('reader')!.closure).to.deep.equal(['reader']);
    });

    it('the edge points to the role right below and names the ladder', () => {
      expect([...edges(ROLES, LADDERS)]).to.deep.equal([
        { from: 'commenter', to: 'viewer', via: "ladder 'project'" },
        { from: 'editor', to: 'commenter', via: "ladder 'project'" },
        { from: 'maintainer', to: 'editor', via: "ladder 'project'" },
        { from: 'org.admin', to: 'org.member', via: "ladder 'org'" },
      ]);
    });

    it('ladderEdges gives the same edges without an extension instance', () => {
      expect([...ladderEdges(new Map(ROLES.map((r) => [r.name, r])), LADDERS)]).to.deep.equal([...edges(ROLES, LADDERS)]);
    });

    it('the grant index of a higher role lists the permissions of the lower ones', () => {
      const index = compileGrants(graphOf(), registry());
      expect(index.permissions('maintainer')).to.deep.equal(['file:comment', 'file:edit', 'file:read', 'project:settings']);
      expect(index.permissions('commenter')).to.deep.equal(['file:comment', 'file:read']);
      expect(index.permissions('viewer')).to.deep.equal(['file:read']);
    });
  });

  describe('boot rules (design §6.5 rule 9)', () => {
    const two = [role('viewer', ['file:read']), role('editor', []), role('owner', [])];

    it('a role in two ladders', () => {
      refused(
        two,
        [
          { name: 'project', roles: ['viewer', 'editor'] },
          { name: 'org', roles: ['editor', 'owner'] },
        ],
        'rbac',
        "'editor'",
        "'project'",
        "'org'",
      );
    });

    it('a ladder role that extends a higher role of its own ladder, naming both roles and the rule', () => {
      const roles = [role('viewer', ['file:read'], { ladder: 'project', extends: ['owner'] }), role('editor', [], { ladder: 'project' }), role('owner', [], { ladder: 'project' })];
      refused(roles, [{ name: 'project', roles: ['viewer', 'editor', 'owner'] }], 'rbac', "'viewer'", "'owner'", 'rule 9');
    });

    it('a ladder role may extend a lower role of its own ladder or a role outside it', () => {
      const roles = [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', [], { ladder: 'project', extends: ['viewer', 'extra'] }), role('extra', ['file:edit'])];
      expect(graphOf(roles, [{ name: 'project', roles: ['viewer', 'editor'] }]).get('editor')!.closure).to.deep.equal(['editor', 'viewer', 'extra']);
    });

    it('a ladder naming an unknown role', () => {
      refused([role('viewer', [], { ladder: 'project' })], [{ name: 'project', roles: ['viewer', 'ghost'] }], 'rbac', "'project'", "'ghost'");
    });

    it('a role naming an unknown ladder', () => {
      refused([role('viewer', [], { ladder: 'galaxy' })], [], 'rbac', "'viewer'", "'galaxy'");
    });

    it('a role naming a ladder that does not list it (RoleDef.ladder alone is refused: the rank needs the ladder order)', () => {
      refused([role('viewer', [], { ladder: 'project' }), role('editor', [], { ladder: 'project' })], [{ name: 'project', roles: ['viewer'] }], 'rbac', "'editor'", "'project'");
    });

    it('a role listed in a ladder whose definition names another ladder', () => {
      refused(
        [role('viewer', [], { ladder: 'org' }), role('org.member', [], { ladder: 'org' })],
        [
          { name: 'project', roles: ['viewer'] },
          { name: 'org', roles: ['org.member'] },
        ],
        'rbac',
        "'viewer'",
        "'project'",
        "'org'",
      );
    });

    it('a role listed in a ladder whose definition names no ladder', () => {
      refused([role('viewer', [])], [{ name: 'project', roles: ['viewer'] }], 'rbac', "'viewer'", "'project'");
    });

    it('malformed ladders: no name, a duplicate name, no roles, a role twice, empty or malformed resourceTypes', () => {
      const viewer = role('viewer', [], { ladder: 'project' });
      refused([viewer], [{ name: '', roles: ['viewer'] } as LadderDef], 'rbac', 'ladder #0');
      refused(
        [viewer],
        [
          { name: 'project', roles: ['viewer'] },
          { name: 'project', roles: [] },
        ],
        'rbac',
        "'project'",
        'twice',
      );
      refused([viewer], [{ name: 'project', roles: [] }], 'rbac', "'project'");
      refused([viewer], [{ name: 'project', roles: ['viewer', 'viewer'] }], 'rbac', "'project'", "'viewer'");
      refused([viewer], [{ name: 'project', roles: ['viewer'], resourceTypes: [] }], 'rbac', "'project'", 'resourceTypes');
      refused([viewer], [{ name: 'project', roles: ['viewer'], resourceTypes: [1] } as unknown as LadderDef], 'rbac', "'project'", 'resourceTypes');
      refused([role('viewer', [], { ladder: 7 } as unknown as Partial<RoleDef>)], [], 'rbac', "'viewer'", 'ladder');
    });

    it('implies naming an unknown role', () => {
      refused([role('owner', [], { implies: [{ role: 'ghost', at: 'descendants' }] })], [], 'rbac', "'owner'", "'ghost'");
    });

    it('a malformed implies list or entry', () => {
      refused([role('owner', [], { implies: 'viewer' } as unknown as Partial<RoleDef>)], [], 'rbac', "'owner'", 'implies');
      refused([role('viewer', []), role('owner', [], { implies: [{ role: 'viewer', at: 'everywhere' }] } as unknown as Partial<RoleDef>)], [], 'rbac', "'owner'", 'at');
    });

    it('a model whose role store breaks a rule fails its init', async () => {
      const roles = [role('viewer', [], { ladder: 'project', extends: ['editor'] }), role('editor', [], { ladder: 'project' })];
      const m = new RbacModel({ roles: new MemoryRoleStore(roles, [{ name: 'project', roles: ['viewer', 'editor'] }]), assignments: new MemoryAssignmentStore(), log: { warn: () => undefined } });
      let thrown: unknown;
      try {
        await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(AuthzConfigError);
    });
  });

  describe('rank tables and needed[(permission, ladder)]', () => {
    const index = () => {
      const graph = graphOf();
      return compileLadders(graph, compileGrants(graph, registry()));
    };

    it('ranks are indexes, weakest first, per ladder', () => {
      const l = index();
      expect(l.ladders.map((x) => x.name)).to.deep.equal(['project', 'org']);
      expect(['viewer', 'commenter', 'editor', 'maintainer', 'org.member', 'org.admin', 'reader'].map((r) => l.rankOf(r))).to.deep.equal([0, 1, 2, 3, 0, 1, undefined]);
      expect(l.ladderOf('editor')!.name).to.equal('project');
      expect(l.ladderOf('reader')).to.equal(undefined);
    });

    it('needed is the lowest role of the ladder that holds the permission', () => {
      const l = index();
      const project = l.ladderOf('viewer')!;
      expect(l.needed('file:read', project)).to.equal('viewer');
      expect(l.needed('file:comment', project)).to.equal('commenter');
      expect(l.needed('file:edit', project)).to.equal('editor');
      expect(l.needed('project:settings', project)).to.equal('maintainer');
      expect(l.needed('org:audit', project)).to.equal(undefined);
      expect(l.needed('org:audit', l.ladderOf('org.admin')!)).to.equal('org.admin');
    });

    it("needed on a type counts only grants that apply there: none outside the ladder's resourceTypes", () => {
      const l = index();
      const project = l.ladderOf('viewer')!;
      expect(l.needed('file:read', project, 'file')).to.equal('viewer');
      expect(l.needed('file:read', project, 'org')).to.equal(undefined);
    });

    it("a grant a ladder role declares applies only on the ladder's resourceTypes; other grants everywhere", () => {
      const graph = graphOf();
      const grants = compileGrants(graph, registry());
      const l = compileLadders(graph, grants);
      const [viewerRead] = grants.grants('viewer', 'file:read');
      const [readerRead] = grants.grants('reader', 'file:read');
      const [audit] = grants.grants('org.admin', 'org:audit');
      expect(['file', 'project', 'org', '$global'].map((t) => l.appliesAt(viewerRead, t))).to.deep.equal([true, true, false, false]);
      expect(['file', 'project', 'org', '$global'].map((t) => l.appliesAt(readerRead, t))).to.deep.equal([true, true, true, true]);
      expect(['file', 'org', '$global'].map((t) => l.appliesAt(audit, t))).to.deep.equal([true, true, true]);
    });
  });

  describe('the default model', () => {
    it('gets ladders with no option: DEFAULT_RBAC_EXTENSIONS holds the ladder extension', async () => {
      expect(DEFAULT_RBAC_EXTENSIONS).to.have.length(1);
      const m = await model([]);
      expect(m.extensions.some((e) => e instanceof LadderExtension)).to.equal(true);
      expect(m.roleGraph().get('editor')!.closure).to.deep.equal(['editor', 'commenter', 'viewer']);
      expect(modelTables(m).ladders!.rankOf('editor')).to.equal(2);
    });

    it('a model built with other extensions has no ladder semantics', async () => {
      const m = new RbacModel({ roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore(), extensions: [], log: { warn: () => undefined } });
      await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
      expect(modelTables(m).ladders).to.equal(undefined);
      expect(m.roleGraph().get('editor')!.closure).to.deep.equal(['editor']);
    });
  });

  describe("ladder grants apply only to the ladder's resourceTypes (B31)", () => {
    it('a viewer at GLOBAL reads a file and a project, not an org', async () => {
      const m = await model([assignment('a1', 'viewer')]);
      expect((await vote(m, 'file:read', f1)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'file:read', P1)).permitWhen).to.deep.equal(TRUE);
      const org = await vote(m, 'file:read', O1);
      expect(org.permitWhen).to.deep.equal(FALSE);
      expect(org.reason).to.include({ code: 'no_access' });
    });

    it('the same permission from a role outside every ladder applies everywhere', async () => {
      const m = await model([assignment('a1', 'reader')]);
      expect((await vote(m, 'file:read', O1)).permitWhen).to.deep.equal(TRUE);
    });

    it('a ladder without resourceTypes applies everywhere', async () => {
      const m = await model([assignment('a1', 'org.admin')]);
      expect((await vote(m, 'org:audit', O1)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'org:audit', f1)).permitWhen).to.deep.equal(TRUE);
      expect((await vote(m, 'org:audit', GLOBAL)).permitWhen).to.deep.equal(TRUE);
    });

    it('a request on $global is outside a ladder with resourceTypes', async () => {
      const m = await model([assignment('a1', 'maintainer')]);
      expect((await vote(m, 'file:read', GLOBAL)).permitWhen).to.deep.equal(FALSE);
    });

    it('a type-level request follows the requested type, for GLOBAL and scoped holders alike', async () => {
      const global = await model([assignment('a1', 'viewer')]);
      expect((await vote(global, 'file:read', { type: 'file' })).permitWhen).to.deep.equal(TRUE);
      expect((await vote(global, 'file:read', { type: 'org' })).permitWhen).to.deep.equal(FALSE);
      const scoped = await model([assignment('a1', 'viewer', O1)]);
      expect((await vote(scoped, 'file:read', { type: 'file' })).permitWhen).to.deep.equal({ op: 'under', scopes: [O1] });
      expect((await vote(scoped, 'file:read', { type: 'org' })).permitWhen).to.deep.equal(FALSE);
    });
  });

  describe('RbacService and summarize with ladder edges', () => {
    it('grantsOf a ladder role lists the grants of the lower roles', async () => {
      const service = new RbacService(await model([]));
      expect(service.grantsOf('editor').map((g) => [g.permission, g.role])).to.deep.equal([
        ['file:comment', 'commenter'],
        ['file:edit', 'editor'],
        ['file:read', 'viewer'],
      ]);
    });

    it('covers: a higher ladder role covers the lower ones, not the reverse', async () => {
      const service = new RbacService(await model([]));
      expect(service.covers(['maintainer'], ['viewer', 'commenter', 'editor'])).to.equal(true);
      expect(service.covers(['editor'], ['maintainer'])).to.equal(false);
      expect(service.covers(['viewer'], ['commenter'])).to.equal(false);
    });

    it("covers: a ladder grant limited to the ladder's resourceTypes does not cover the same grant everywhere", async () => {
      const service = new RbacService(await model([]));
      expect(service.covers(['maintainer'], ['reader'])).to.equal(false);
      expect(service.covers(['reader'], ['viewer'])).to.equal(true);
    });

    it('covers: a ladder whose resourceTypes hold every type of the permission covers a grant without limits', async () => {
      const covers = async (resourceTypes: string[]) => {
        const r = new PermissionRegistryImpl();
        r.register([{ name: 'file:read', types: ['file'] }], 'test');
        r.freeze();
        const m = new RbacModel({ roles: new MemoryRoleStore([role('viewer', ['file:read'], { ladder: 'project' }), role('reader', ['file:read'])], [{ name: 'project', roles: ['viewer'], resourceTypes }]), assignments: new MemoryAssignmentStore(), log: { warn: () => undefined } });
        await m.init(fakeModelInitContext({ model: 'rbac', permissions: r }));
        return new RbacService(m).covers(['viewer'], ['reader']);
      };
      expect(await covers(['file', '$global'])).to.equal(true);
      // A $global check is a type the permission is checked on too: the reader grant applies there, the ladder grant does not.
      expect(await covers(['file'])).to.equal(false);
    });

    describe('one source for the ladder tables (RbacExtension.tables)', () => {
      const withExtensions = async (extensions: RbacExtension[], assignments: readonly Assignment[] = []) => {
        const m = new RbacModel({ roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore(assignments), extensions, log: { warn: () => undefined } });
        await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
        m.grantIndex();
        return m;
      };
      // Ladder edges and tables from an extension that is not a LadderExtension.
      const custom = (): RbacExtension => {
        const inner = new LadderExtension();
        return { extraEdges: inner.extraEdges, tables: (graph, grants) => inner.tables(graph, grants) };
      };

      it('covers reads the tables of any extension, as the votes do', async () => {
        const m = await withExtensions([custom()], [assignment('a1', 'maintainer')]);
        expect(new RbacService(m).covers(['maintainer'], ['reader'])).to.equal(false);
        expect((await vote(m, 'file:read', O1)).permitWhen).to.deep.equal(FALSE);
      });

      it('a gather may not set a table: the vote fails instead of disagreeing with covers', async () => {
        const inner = new LadderExtension();
        const m = await withExtensions([{ extraEdges: inner.extraEdges, gather: (_r, _c, input) => ({ ladders: inner.index(input.roles, input.grants) }) }]);
        let thrown: unknown;
        try {
          await vote(m, 'file:read', f1);
        } catch (e) {
          thrown = e;
        }
        expect((thrown as Error).message).to.contain("set 'ladders'");
      });

      it('two extensions giving one table are refused', async () => {
        const m = await withExtensions([custom(), { tables: custom().tables }]);
        expect(() => modelTables(m)).to.throw(AuthzConfigError, "'ladders'");
      });
    });

    it("summarize: a viewer's summary lists no editor permission; a maintainer's lists every lower one", async () => {
      const names = async (roleName: string, at: ResourceRef) => (await (await model([assignment('a1', roleName)])).summarize(alice, at, ctx())).permissions.map((p) => p.name);
      expect(await names('viewer', f1)).to.deep.equal(['file:read']);
      expect(await names('commenter', f1)).to.deep.equal(['file:comment', 'file:read']);
      expect(await names('maintainer', P1)).to.deep.equal(['file:comment', 'file:edit', 'file:read', 'project:settings']);
      expect(await names('maintainer', O1)).to.deep.equal([]);
      expect(await names('maintainer', GLOBAL)).to.deep.equal(['file:comment', 'file:edit', 'file:read', 'project:settings']);
    });
  });
});
