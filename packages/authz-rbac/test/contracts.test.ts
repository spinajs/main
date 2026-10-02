import * as chai from 'chai';
import 'mocha';

import { AssignmentStore, LinkStore, RoleStore, RuleStore, SubjectResolver } from '../src/index.js';
import * as root from '../src/index.js';
import type { Assignment, AssignmentSubject, GrantDef, ImpliedRole, LadderDef, LinkDef, ResourcePattern, RoleDef, RuleDef, SubjectSelector } from '../src/index.js';
import type { Assignment as CoreAssignment, AssignmentSubject as CoreSubject, AuthzTx, LinkDef as CoreLinkDef, Principal, PrincipalRef, ResourceRef, RuleDef as CoreRuleDef, SubjectSelector as CoreSelector } from '@spinajs/authz';

const expect = chai.expect;

const scope: ResourceRef = { type: 'org', id: 'o1' };
const actor: PrincipalRef = { type: 'user', id: 'u1' };
const tx = {} as AuthzTx;

describe('authz-rbac contracts', () => {
  it('GrantDef accepts relation as string or array and every optional member', () => {
    const a: GrantDef = { permission: 'file:read' };
    const b: GrantDef = { permission: 'file:read', relation: 'owner', on: [{ type: 'file', id: '{principal.id}/*' }], fields: undefined, requiresTag: 'addon', grantedAt: ['project'] };
    const c: GrantDef = { permission: 'file:read', relation: ['owner', 'editor'] };
    expect([a, b, c]).to.have.length(3);
  });

  it('ResourcePattern, LadderDef, ImpliedRole', () => {
    const p: ResourcePattern = { type: 'file' };
    const q: ResourcePattern = { type: 'file', id: 'x*' };
    const l: LadderDef = { name: 'project', roles: ['viewer', 'editor'] };
    const l2: LadderDef = { name: 'project', roles: ['viewer'], resourceTypes: ['project'] };
    const i1: ImpliedRole = { role: 'maintainer', at: 'self-and-descendants' };
    const i2: ImpliedRole = { role: 'maintainer', at: 'descendants', tags: ['t'], bypass: ['restrict', 'cap'] };
    // @ts-expect-error the ceiling can never be bypassed (D19)
    const i3: ImpliedRole = { role: 'maintainer', at: 'descendants', bypass: ['ceiling'] };
    expect([p, q, l, l2, i1, i2, i3]).to.have.length(7);
  });

  it('RoleDef has no namespace and requires assignable', () => {
    const r: RoleDef = { name: 'admin', extends: [], grants: [], assignable: true, source: 'config' };
    const full: RoleDef = { ...r, ladder: 'project', implies: [], subjectSet: true, scopeTypes: ['org'], description: 'd' };
    // @ts-expect-error role definitions are global in 3.0
    const ns: RoleDef = { ...r, namespace: 'x' };
    // @ts-expect-error assignable is required
    const missing: RoleDef = { name: 'admin', extends: [], grants: [], source: 'config' };
    expect([full, ns, missing]).to.have.length(3);
  });

  it('Assignment and AssignmentSubject are exported', () => {
    const s1: AssignmentSubject = actor;
    const s2: AssignmentSubject = { set: { role: 'admin', scope } };
    const a: Assignment = { id: '1', subject: s2, role: 'admin', scope, tags: ['t'], expiresAt: null, grantedBy: actor, source: 'db' };
    expect(a.subject).to.equal(s2);
    expect(s1).to.equal(actor);
  });

  it('re-exported types are the core types', () => {
    const rule: CoreRuleDef = { id: 'r', kind: 'restrict', scope, source: 'config' };
    const fwd: RuleDef = rule;
    const back: CoreRuleDef = fwd;
    const a: CoreAssignment = {} as Assignment;
    const b: Assignment = a;
    const s: CoreSubject = {} as AssignmentSubject;
    const s2: AssignmentSubject = s;
    const l: CoreLinkDef = {} as LinkDef;
    const l2: LinkDef = l;
    const sel: CoreSelector = {} as SubjectSelector;
    const sel2: SubjectSelector = sel;
    expect([back, b, s2, l2, sel2]).to.have.length(5);
  });

  it('store classes are runtime exports of the root', () => {
    for (const k of ['RoleStore', 'RuleStore', 'AssignmentStore', 'LinkStore', 'SubjectResolver']) {
      expect((root as any)[k], k).to.be.a('function');
    }
  });

  it('RoleStore and RuleStore fakes', async () => {
    class R extends RoleStore {
      readonly name = 'r';
      async load() {
        return { roles: [], ladders: [] };
      }
      async version() {
        return '1';
      }
    }
    class U extends RuleStore {
      readonly name = 'u';
      async forPath(_path: readonly ResourceRef[], _at: Date) {
        return [];
      }
      async version() {
        return '1';
      }
    }
    expect((await new R().load()).roles).to.have.length(0);
    expect(await new U().forPath([scope], new Date())).to.have.length(0);
  });

  it('AssignmentStore fake without write methods', async () => {
    class A extends AssignmentStore {
      readonly name = 'a';
      async forSubjects(_s: readonly AssignmentSubject[], _at: Date) {
        return [];
      }
      async holders(_role: string, _scope: ResourceRef, _at: Date) {
        return [];
      }
    }
    const a = new A();
    expect(a.assign).to.equal(undefined);
    expect(a.revoke).to.equal(undefined);
    expect(await a.holders('admin', scope, new Date())).to.have.length(0);
  });

  it('AssignmentStore fake with write methods taking an AuthzTx', async () => {
    class A extends AssignmentStore {
      readonly name = 'a';
      async forSubjects() {
        return [];
      }
      async holders() {
        return [];
      }
      async assign(a: Omit<Assignment, 'id' | 'source'>, _actor: PrincipalRef, _tx: AuthzTx): Promise<Assignment> {
        return { ...a, id: '1', source: 'db' };
      }
      async revoke(_id: string, _actor: PrincipalRef, _tx: AuthzTx): Promise<void> {}
    }
    const a = new A();
    const made = await a.assign({ subject: actor, role: 'admin', scope }, actor, tx);
    expect(made.id).to.equal('1');
    await a.revoke('1', actor, tx);
  });

  it('LinkStore fakes with and without write methods', async () => {
    const link: LinkDef = { id: 'l', scope, attributes: { org_only: true } };
    class Plain extends LinkStore {
      async byToken(_t: string) {
        return null;
      }
      async byId(_id: string) {
        return link;
      }
    }
    class Writable extends Plain {
      async create(l: Omit<LinkDef, 'id'>, grant: { role: string; tags?: readonly string[] }, _actor: PrincipalRef, _tx: AuthzTx) {
        return { link: { ...l, id: 'l' }, token: grant.role };
      }
      async revoke(_id: string, _actor: PrincipalRef, _tx: AuthzTx) {}
    }
    expect(new Plain().create).to.equal(undefined);
    expect(await new Plain().byToken('x')).to.equal(null);
    const w = new Writable();
    expect((await w.create({ scope, attributes: {} }, { role: 'viewer' }, actor, tx)).token).to.equal('viewer');
    await w.revoke('l', actor, tx);
  });

  it('SubjectResolver may return sync or async', async () => {
    class Sync extends SubjectResolver {
      subjects(p: Principal) {
        return [p] as readonly AssignmentSubject[];
      }
    }
    class Async extends SubjectResolver {
      async subjects(_p: Principal) {
        return [] as readonly AssignmentSubject[];
      }
    }
    const p = { ...actor } as Principal;
    expect(await new Sync().subjects(p)).to.have.length(1);
    expect(await new Async().subjects(p)).to.have.length(0);
  });
});
