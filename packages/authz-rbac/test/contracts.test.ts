import type * as core from '@spinajs/authz';
import type { FieldSet, ResourceType } from '@spinajs/authz';
import * as chai from 'chai';
import 'mocha';

import { AssignmentStore, LinkStore, MembershipStore, RoleStore, RuleStore, SubjectResolver } from '../src/index.js';
import * as root from '../src/index.js';
import type { Assignment, AssignmentSubject, GrantDef, ImpliedRole, LadderDef, LinkDef, ResourcePattern, RoleDef, RuleDef, SubjectKey, SubjectSelector } from '../src/index.js';
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
    const full: RoleDef = { ...r, ladder: 'project', implies: [], subjectSet: true, deny: false, scopeTypes: ['org'], description: 'd' };
    const blocked: RoleDef = { name: 'blocked', deny: true, extends: [], grants: [{ permission: 'invoice:edit' }], assignable: true, source: 'config' };
    expect(blocked.deny).to.equal(true);
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
    for (const k of ['RoleStore', 'RuleStore', 'AssignmentStore', 'LinkStore', 'SubjectResolver', 'MembershipStore']) {
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
      async byId(_id: string): Promise<Assignment | null> {
        return null;
      }
    }
    const a = new A();
    expect(a.assign).to.equal(undefined);
    expect(a.revoke).to.equal(undefined);
    expect(await a.holders('admin', scope, new Date())).to.have.length(0);
    expect(await a.byId('missing')).to.equal(null);
  });

  it('AssignmentStore requires byId (AdminGuard and handlers resolve id-only commands)', () => {
    // @ts-expect-error byId is abstract
    class NoById extends AssignmentStore {
      readonly name = 'a';
      async forSubjects() {
        return [];
      }
      async holders() {
        return [];
      }
    }
    expect(NoById).to.be.a('function');
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
      async byId() {
        return null;
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

  it('MembershipStore fake answers sets with their expiry and members of a set', async () => {
    const until = new Date('2030-01-01T00:00:00Z');
    const closure: Record<string, { setKey: string; expiresAt?: Date }[]> = {
      'user:42': [{ setKey: 'team:7#member' }, { setKey: 'team:1#member', expiresAt: until }],
      'team:7#member': [{ setKey: 'team:1#member' }],
    };
    class M extends MembershipStore {
      async setsOf(memberKeys: readonly string[], _at: Date) {
        return memberKeys.flatMap((k) => closure[k] ?? []);
      }
      async membersOf(setKey: string, _at: Date) {
        return Object.keys(closure).filter((k) => closure[k].some((s) => s.setKey === setKey));
      }
    }
    const m = new M();
    const key: SubjectKey = 'user:42';
    expect(await m.setsOf([key, 'user:*'], new Date(0))).to.deep.equal([{ setKey: 'team:7#member' }, { setKey: 'team:1#member', expiresAt: until }]);
    expect(await m.membersOf('team:1#member', new Date(0))).to.deep.equal(['user:42', 'team:7#member']);
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Shape<C> = Pick<C, keyof C>;
const yes = <_T extends true>(): void => {};

describe('authz-rbac pinned shapes', () => {
  it('match the design exactly', () => {
    yes<Equal<GrantDef, { readonly permission: string; readonly relation?: string | readonly string[]; readonly on?: readonly ResourcePattern[]; readonly fields?: FieldSet; readonly requiresTag?: string; readonly grantedAt?: readonly ResourceType[] }>>();
    yes<Equal<ResourcePattern, { readonly type: ResourceType; readonly id?: string }>>();
    yes<Equal<LadderDef, { readonly name: string; readonly roles: readonly string[]; readonly resourceTypes?: readonly ResourceType[] }>>();
    yes<Equal<ImpliedRole, { readonly role: string; readonly at: 'self-and-descendants' | 'descendants'; readonly tags?: readonly string[]; readonly bypass?: readonly ('restrict' | 'cap')[] }>>();
    yes<
      Equal<
        RoleDef,
        {
          readonly name: string;
          readonly ladder?: string;
          readonly extends: readonly string[];
          readonly grants: readonly GrantDef[];
          readonly implies?: readonly ImpliedRole[];
          readonly subjectSet?: boolean;
          readonly deny?: boolean;
          readonly assignable: boolean;
          readonly scopeTypes?: readonly ResourceType[];
          readonly description?: string;
          readonly source: string;
        }
      >
    >();
    yes<Equal<Shape<RoleStore>, { readonly name: string; load(): Promise<{ roles: readonly RoleDef[]; ladders: readonly LadderDef[] }>; version(): Promise<string> }>>();
    yes<Equal<Shape<RuleStore>, { readonly name: string; forPath(path: readonly ResourceRef[], at: Date): Promise<readonly RuleDef[]>; version(): Promise<string> }>>();
    yes<
      Equal<
        Shape<AssignmentStore>,
        {
          readonly name: string;
          forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]>;
          holders(role: string, scope: ResourceRef, at: Date): Promise<readonly AssignmentSubject[]>;
          byId(id: string): Promise<Assignment | null>;
          assign?(a: Omit<Assignment, 'id' | 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<Assignment>;
          revoke?(id: string, actor: PrincipalRef, tx: AuthzTx): Promise<void>;
        }
      >
    >();
    yes<
      Equal<
        Shape<LinkStore>,
        {
          byToken(token: string): Promise<LinkDef | null>;
          byId(id: string): Promise<LinkDef | null>;
          create?(l: Omit<LinkDef, 'id'>, grant: { role: string; tags?: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<{ link: LinkDef; token: string }>;
          revoke?(id: string, actor: PrincipalRef, tx: AuthzTx): Promise<void>;
        }
      >
    >();
    yes<Equal<Shape<SubjectResolver>, { subjects(p: Principal): Promise<readonly AssignmentSubject[]> | readonly AssignmentSubject[] }>>();
    yes<Equal<Shape<MembershipStore>, { setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]>; membersOf(setKey: string, at: Date): Promise<readonly string[]> }>>();
    yes<Equal<SubjectKey, string>>();
    yes<Equal<AssignmentSubject, core.AssignmentSubject>>();
    yes<Equal<Assignment, core.Assignment>>();
    yes<Equal<SubjectSelector, core.SubjectSelector>>();
    yes<Equal<RuleDef, core.RuleDef>>();
    yes<Equal<LinkDef, core.LinkDef>>();
    expect(true).to.equal(true);
  });
});

describe('authz-rbac native ops', () => {
  it('the native list ops are gone (RFC RA8-1)', () => {
    const exported = root as Record<string, unknown>;
    expect(exported.RBAC_ASSIGNMENT_OP).to.equal(undefined);
    expect(exported.RBAC_THRESHOLD_OP).to.equal(undefined);
    expect(exported.RBAC_RESIDUALS).to.equal(undefined);
    expect(exported.rbacAssignmentExtension).to.equal(undefined);
  });
});
