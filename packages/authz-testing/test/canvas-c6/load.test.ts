import { SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, AuthzCommandResult } from '@spinajs/authz';
import * as chai from 'chai';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { branchRulePermissions } from './config.js';
import { CANVAS_FIXTURES_DIR, loadCanvasFixtures } from './fixtures.js';
import { canvasCommands, loadCanvasState } from './load.js';
import type { CanvasBatch } from './load.js';

const expect = chai.expect;

const capabilities = JSON.parse(readFileSync(CANVAS_FIXTURES_DIR + 'capabilities.json', 'utf8'));
const EXPIRY = new Date('2030-01-01T00:00:00.000Z');
const opts = { capabilities, expiredLinkExpiry: EXPIRY };

describe('canvas C6 state loader', () => {
  const f = loadCanvasFixtures();
  const id = (symbol: string): string => {
    const uuid = f.ids.get(symbol);
    if (uuid === undefined) throw new Error(`no fixture id ${symbol}`);
    return uuid;
  };
  const batches = canvasCommands(f, opts);
  const batchOf = (org: string): CanvasBatch => batches.find((b) => b.org === id(org))!;
  const kinds = (b: CanvasBatch, kind: AuthzCommand['kind']): AuthzCommand[] => b.commands.filter((c) => c.kind === kind);
  const org = (s: string) => ({ type: 'org', id: id(s) });
  const project = (s: string) => ({ type: 'project', id: id(s) });
  const file = (s: string) => ({ type: 'file', id: id(s) });
  const group = (s: string) => ({ type: 'group', id: id(s) });
  const user = (s: string) => ({ type: 'user', id: id(s) });
  const GROUP_DESIGN = { set: { role: 'group.member', scope: group('DESIGN') } };
  const mut = (v: unknown): any => v;
  const { push, merge } = branchRulePermissions(capabilities);

  describe('canvasCommands', () => {
    it('makes one batch per org in state order', () => {
      expect(batches.map((b) => b.org)).to.deep.equal(['ACME', 'STRICT', 'OPEN', 'SEALED'].map(id));
    });

    it('counts the commands of each org', () => {
      // ACME: 9 members + 1 group member + 4 project grants + 4 file grants + 1 default role + 1 restrict + 8 branch rows + 4 links.
      // STRICT: 4 members + 3 project grants + 2 file grants + 1 default role + 1 link + 1 policies.
      // OPEN: 2 members + 1 project grant + 1 link + 1 policies. SEALED: 1 project grant + 1 policies.
      expect(batches.map((b) => b.commands.length)).to.deep.equal([32, 12, 5, 2]);
    });

    it('keeps the command kinds of ACME in the documented order', () => {
      const order = batchOf('ACME').commands.map((c) => c.kind);
      const collapsed = order.filter((k, i) => i === 0 || k !== order[i - 1]);
      expect(collapsed).to.deep.equal(['assignment.grant', 'set.addMember', 'assignment.grant', 'rule.put', 'link.create']);
      const grants = batchOf('ACME').commands.filter((c) => c.kind === 'assignment.grant') as Extract<AuthzCommand, { kind: 'assignment.grant' }>[];
      const scopes = grants.map((g) => g.scope.type);
      expect(scopes).to.deep.equal([...Array(9).fill('org'), ...Array(4).fill('project'), ...Array(4).fill('file'), 'project']);
    });

    it('writes every fact of the state exactly once', () => {
      const all = batches.flatMap((b) => b.commands);
      const state = f.state;
      const members = [...state.orgs.values()].reduce((n, o) => n + o.members.size, 0);
      const projectGrants = [...state.projects.values()].reduce((n, p) => n + p.grants.length, 0);
      const fileGrants = [...state.files.values()].reduce((n, x) => n + x.grants.length, 0);
      const defaults = [...state.projects.values()].filter((p) => p.org_default_role !== 'none').length;
      const groupMembers = [...state.groups.values()].reduce((n, g) => n + g.members.size, 0);
      const restricted = [...state.files.values()].filter((x) => x.restricted_to !== null).length;
      const branchRules = [...state.projects.values()].reduce((n, p) => n + p.branch_rules.length, 0);
      const policyOrgs = [...f.explicitPolicies.values()].filter((p) => Object.keys(p).length > 0).length;
      const count = (kind: string) => all.filter((c) => c.kind === kind).length;

      expect(count('assignment.grant')).to.equal(members + projectGrants + fileGrants + defaults);
      expect(count('set.addMember')).to.equal(groupMembers);
      expect(count('rule.put')).to.equal(restricted + 2 * branchRules);
      expect(count('link.create')).to.equal(state.links.size);
      expect(count('scope.setAttributes')).to.equal(policyOrgs);
      expect(all.length).to.equal(members + projectGrants + fileGrants + defaults + groupMembers + restricted + 2 * branchRules + state.links.size + policyOrgs);
      expect(all.length).to.equal(32 + 12 + 5 + 2);
    });

    it('writes an org member as an org ladder role at the org', () => {
      expect(batchOf('ACME').commands).to.deep.include({ kind: 'assignment.grant', subject: user('GUS'), role: 'org.guest', scope: org('ACME'), replaceLadder: true });
      expect(batchOf('ACME').commands).to.deep.include({ kind: 'assignment.grant', subject: user('XENA'), role: 'org.file_guest', scope: org('ACME'), replaceLadder: true });
    });

    it('writes a group member as a group.member set member', () => {
      expect(kinds(batchOf('ACME'), 'set.addMember')).to.deep.equal([{ kind: 'set.addMember', set: { role: 'group.member', scope: group('DESIGN') }, member: user('DORA') }]);
    });

    it('writes a group grant with the add-ons of the grant', () => {
      expect(batchOf('ACME').commands).to.deep.include({ kind: 'assignment.grant', subject: GROUP_DESIGN, role: 'commenter', scope: project('WEB'), tags: ['code'], replaceLadder: true });
      expect(batchOf('ACME').commands).to.deep.include({ kind: 'assignment.grant', subject: user('ED'), role: 'editor', scope: project('WEB'), tags: ['inspect', 'code'], replaceLadder: true });
    });

    it('writes a file grant at the file', () => {
      expect(batchOf('ACME').commands).to.deep.include({ kind: 'assignment.grant', subject: user('ZED'), role: 'viewer', scope: file('HOME'), tags: [], replaceLadder: true });
      expect(batchOf('STRICT').commands).to.deep.include({ kind: 'assignment.grant', subject: user('ZED'), role: 'viewer', scope: file('BRIEF'), tags: ['inspect'], replaceLadder: true });
    });

    it('writes a default role for the org.member set, and none for `none`', () => {
      expect(batchOf('ACME').commands).to.deep.include({ kind: 'assignment.grant', subject: { set: { role: 'org.member', scope: org('ACME') } }, role: 'viewer', scope: project('WEB'), tags: [], replaceLadder: true });
      const defaults = (b: CanvasBatch) => b.commands.filter((c) => c.kind === 'assignment.grant' && 'set' in c.subject && c.subject.set.role === 'org.member');
      expect(defaults(batchOf('ACME'))).to.have.length(1);
      expect(defaults(batchOf('STRICT'))).to.have.length(1);
      expect(defaults(batchOf('OPEN'))).to.have.length(0);
      expect(defaults(batchOf('SEALED'))).to.have.length(0);
    });

    it('gives an editor default role both add-ons (C6 copy of defaultAddons)', () => {
      const state = loadCanvasFixtures();
      mut(state.state.projects.get(id('WEB'))).org_default_role = 'maintainer';
      const grant = canvasCommands(state, opts)[0].commands.find((c) => c.kind === 'assignment.grant' && 'set' in c.subject && c.subject.set.role === 'org.member');
      expect(grant).to.include({ role: 'maintainer' });
      expect((grant as unknown as { tags: string[] }).tags).to.deep.equal(['inspect', 'code']);
    });

    it('writes a restrict rule for SECRET allowing ED', () => {
      expect(kinds(batchOf('ACME'), 'rule.put').find((c) => (c as { rule: { id: string } }).rule.id.startsWith('restrict:'))).to.deep.equal({
        kind: 'rule.put',
        rule: { id: `restrict:file:${id('SECRET')}`, kind: 'restrict', scope: file('SECRET'), allow: [user('ED')] },
      });
    });

    it('writes the two threshold rows of WEB release/*', () => {
      const rules = kinds(batchOf('ACME'), 'rule.put').map((c) => (c as { rule: { id: string } }).rule);
      const row = (suffix: string, permissions: string[], minRole: string) => ({
        id: `branch:${id('WEB')}:release/*:${suffix}`,
        kind: 'threshold',
        scope: project('WEB'),
        resourceTypes: ['branch'],
        resource: { attr: 'resource.name', wildcard: 'release/*' },
        permissions,
        minRole,
        reason: { code: 'branch_protected', pattern: 'release/*', needed: minRole, priority: 700, sortKey: 'release/*' },
      });
      expect(rules).to.deep.include(row('push', push, 'editor'));
      expect(rules).to.deep.include(row('merge', ['branch:merge'], 'maintainer'));
      expect(merge).to.deep.equal(['branch:merge']);
      expect(push).to.not.include('branch:merge');
      expect(push).to.have.length.greaterThan(0);
    });

    it('writes the rows of a pattern with the push list first', () => {
      const ids = kinds(batchOf('ACME'), 'rule.put').map((c) => (c as { rule: { id: string } }).rule.id);
      expect(ids.filter((x) => x.startsWith('branch:'))).to.deep.equal(['main', 'release/*', 'hotfix/*', '*-lts'].flatMap((p) => [`branch:${id('WEB')}:${p}:push`, `branch:${id('WEB')}:${p}:merge`]));
    });

    it('writes links with their add-ons, expiry and org_only', () => {
      const links = kinds(batchOf('ACME'), 'link.create');
      expect(links).to.deep.equal([
        { kind: 'link.create', scope: project('WEB'), role: 'viewer', tags: ['inspect'], expiresAt: null, attributes: { org_only: false } },
        { kind: 'link.create', scope: file('HOME'), role: 'commenter', tags: [], expiresAt: null, attributes: { org_only: false } },
        { kind: 'link.create', scope: project('WEB'), role: 'viewer', tags: [], expiresAt: EXPIRY, attributes: { org_only: false } },
        { kind: 'link.create', scope: project('WEB'), role: 'viewer', tags: [], expiresAt: null, attributes: { org_only: true } },
      ]);
      expect(kinds(batchOf('STRICT'), 'link.create')).to.have.length(1);
      expect(kinds(batchOf('OPEN'), 'link.create')).to.have.length(1);
    });

    it('writes only the explicit policies of an org', () => {
      expect(kinds(batchOf('STRICT'), 'scope.setAttributes')).to.deep.equal([
        { kind: 'scope.setAttributes', scope: org('STRICT'), patch: { policies: { agents_allowed: false, viewers_may_download: false, editors_may_invite: false, addons_for_guests: false, guest_max_role: 'maintainer' } } },
      ]);
      expect(kinds(batchOf('SEALED'), 'scope.setAttributes')).to.deep.equal([{ kind: 'scope.setAttributes', scope: org('SEALED'), patch: { policies: { external_sharing: false } } }]);
      expect(kinds(batchOf('OPEN'), 'scope.setAttributes')).to.have.length(1);
      expect(kinds(batchOf('ACME'), 'scope.setAttributes')).to.have.length(0);
    });

    it('puts the policies last in a batch', () => {
      expect(batchOf('STRICT').commands.at(-1)!.kind).to.equal('scope.setAttributes');
    });

    it('is pure: two calls give equal batches and leave the state alone', () => {
      expect(canvasCommands(f, opts)).to.deep.equal(batches);
    });

    it('keeps every rule id within the id column and encodes a long pattern', () => {
      const long = 'x'.repeat(150);
      const copy = loadCanvasFixtures();
      mut(copy.state.projects.get(id('WEB'))).branch_rules = [{ pattern: long, merge_role: 'maintainer', push_role: 'maintainer' }];
      const rules = canvasCommands(copy, opts)[0].commands.filter((c) => c.kind === 'rule.put' && c.rule.kind === 'threshold') as { rule: { id: string } }[];
      const sha = createHash('sha256').update(long).digest('hex');
      expect(rules.map((r) => r.rule.id)).to.deep.equal([`branch:${id('WEB')}:sha256-${sha}:push`, `branch:${id('WEB')}:sha256-${sha}:merge`]);
      for (const r of rules) expect(r.rule.id.length).to.be.at.most(160);
    });

    it('refuses a duplicate pattern, an empty pattern and a pattern over the sortKey limit', () => {
      const rule = (pattern: string) => ({ pattern, merge_role: 'maintainer', push_role: 'maintainer' });
      const withRules = (rules: unknown[]) => {
        const copy = loadCanvasFixtures();
        mut(copy.state.projects.get(id('WEB'))).branch_rules = rules;
        return copy;
      };
      expect(() => canvasCommands(withRules([rule('a'), rule('a')]), opts)).to.throw(/duplicate branch rule pattern/);
      expect(() => canvasCommands(withRules([rule('')]), opts)).to.throw(/empty pattern/);
      expect(() => canvasCommands(withRules([rule('y'.repeat(256))]), opts)).to.throw(/sortKey/);
    });

    it('throws on data the commands cannot carry', () => {
      const broken = (edit: (s: ReturnType<typeof loadCanvasFixtures>['state']) => void) => {
        const copy = loadCanvasFixtures();
        edit(copy.state);
        return () => canvasCommands(copy, opts);
      };
      expect(broken((s) => mut(s.files.get(id('HOME'))).project = id('GHOST'))).to.throw(/file HOME: unknown project/);
      expect(broken((s) => mut(s.projects.get(id('WEB'))).org = id('GHOST'))).to.throw(/project WEB: unknown org/);
      expect(broken((s) => mut(s.groups.get(id('DESIGN'))).org = id('GHOST'))).to.throw(/group DESIGN: unknown org/);
      expect(broken((s) => mut(s.links.get(id('VIEW_LINK'))).project = id('GHOST'))).to.throw(/link VIEW_LINK: unknown project/);
      expect(broken((s) => mut(s.links.get(id('VIEW_LINK'))).file = id('BRIEF'))).to.throw(/link VIEW_LINK: file BRIEF is not in project WEB/);
      expect(broken((s) => (mut(s.projects.get(id('WEB'))).grants[1].grantee.id = id('GHOST')))).to.throw(/unknown group/);
    });

    it('asserts the batch size', () => {
      expect(() => canvasCommands(f, { ...opts, maxBatch: 31 })).to.throw(/org ACME: 32 commands exceed authz.admin.maxBatch \(31\)/);
      expect(() => canvasCommands(f, { ...opts, maxBatch: 32 })).to.not.throw();
    });
  });

  describe('loadCanvasState', () => {
    interface Call {
      actor: unknown;
      commands: readonly AuthzCommand[];
      opts: unknown;
    }
    const fakeAdmin = (fail?: { batch: number; index: number }) => {
      const calls: Call[] = [];
      let seq = 0;
      return {
        calls,
        async execute(actor: unknown, commands: readonly AuthzCommand[], o: unknown): Promise<AuthzCommandResult[]> {
          const batch = calls.length;
          calls.push({ actor, commands, opts: o });
          return commands.map((c, i): AuthzCommandResult => {
            if (fail && fail.batch === batch && fail.index === i) return { ok: false, kind: c.kind, error: { code: 'unknown_role', message: 'no such role', field: 'role' } };
            if (c.kind === 'link.create') {
              seq++;
              return { ok: true, kind: c.kind, id: `link-${seq}`, token: `token-${seq}`, affected: 1 };
            }
            return { ok: true, kind: c.kind, affected: 1 };
          });
        },
      };
    };

    it('runs each batch in order as SYSTEM with the reason', async () => {
      const admin = fakeAdmin();
      await loadCanvasState(admin, f, opts);
      expect(admin.calls).to.have.length(4);
      expect(admin.calls.map((c) => c.commands)).to.deep.equal(batches.map((b) => b.commands));
      for (const c of admin.calls) {
        expect(c.actor).to.equal(SYSTEM);
        expect(c.opts).to.deep.equal({ reason: 'canvas c6 state load' });
      }
    });

    it('maps each C6 link to its link id and token', async () => {
      const load = await loadCanvasState(fakeAdmin(), f, opts);
      const expected = ['VIEW_LINK', 'FILE_LINK', 'OLD_LINK', 'MEMBER_LINK', 'STRICT_LINK', 'OPEN_LINK'];
      expect([...load.linkIds.keys()]).to.deep.equal(expected.map(id));
      expect([...load.linkIds.values()]).to.deep.equal(expected.map((_, i) => `link-${i + 1}`));
      expect([...load.tokens.values()]).to.deep.equal(expected.map((_, i) => `token-${i + 1}`));
      expect(load.results.get(id('ACME'))).to.have.length(32);
      expect([...load.results.keys()]).to.deep.equal(['ACME', 'STRICT', 'OPEN', 'SEALED'].map(id));
    });

    it('loads without the extra state', async () => {
      const admin = fakeAdmin();
      await loadCanvasState(admin, loadCanvasFixtures({ extra: false }), opts);
      expect(admin.calls).to.have.length(3);
    });

    it('throws an error naming org, index, kind and code on a failed result', async () => {
      const admin = fakeAdmin({ batch: 1, index: 4 });
      let error: Error | undefined;
      try {
        await loadCanvasState(admin, f, opts);
      } catch (e) {
        error = e as Error;
      }
      expect(error).to.be.instanceOf(Error);
      expect(error!.message).to.include('org STRICT');
      expect(error!.message).to.include('command 4');
      expect(error!.message).to.include('(assignment.grant)');
      expect(error!.message).to.include('unknown_role');
      expect(error!.message).to.include('no such role');
      expect(error!.message).to.include('field role');
      expect(admin.calls).to.have.length(2);
    });
  });
});
