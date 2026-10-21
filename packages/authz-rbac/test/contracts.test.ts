import type { Condition, DenyReason, FieldSet, Permission, PrincipalType, ResourceType } from '@spinajs/authz';
import * as chai from 'chai';
import 'mocha';

import { AssignmentStore, LinkStore, MembershipStore, RoleStore, RuleStore, SubjectResolver } from '../src/index.js';
import * as root from '../src/index.js';
import type { Assignment, AssignmentSubject, GrantDef, ImpliedRole, LadderDef, LinkDef, ResourcePattern, RoleDef, RuleDef, SubjectKey, SubjectSelector } from '../src/index.js';
import type { AuthzAdmin, AuthzAdminQuery, AuthzCommand, AuthzCommandOf, AuthzTx, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';

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
    expect(true).to.equal(true);
  });
});

describe('authz-rbac admin commands (declared in AuthzCommandMap)', () => {
  type DSubject = PrincipalRef | { readonly set: { readonly role: string; readonly scope: ResourceRef } };
  type DPage = { limit: number; offset: number };
  type DCommand =
    | { readonly kind: 'assignment.grant'; readonly subject: AssignmentSubject; readonly role: string; readonly scope: ResourceRef; readonly tags?: readonly string[]; readonly expiresAt?: Date | null; readonly replaceLadder?: boolean }
    | { readonly kind: 'assignment.revoke'; readonly id: string }
    | { readonly kind: 'assignment.revokeWhere'; readonly scope: ResourceRef; readonly subject?: AssignmentSubject; readonly role?: string }
    | { readonly kind: 'assignment.setTags' | 'assignment.addTags' | 'assignment.removeTags'; readonly id: string; readonly tags: readonly string[] }
    | { readonly kind: 'assignment.setExpiry'; readonly id: string; readonly expiresAt: Date | null }
    | { readonly kind: 'set.addMember'; readonly set: { readonly role: string; readonly scope: ResourceRef }; readonly member: PrincipalRef; readonly expiresAt?: Date | null }
    | { readonly kind: 'set.removeMember'; readonly set: { readonly role: string; readonly scope: ResourceRef }; readonly member: PrincipalRef }
    | { readonly kind: 'link.create'; readonly scope: ResourceRef; readonly role: string; readonly tags?: readonly string[]; readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>> }
    | { readonly kind: 'link.update'; readonly id: string; readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>>; readonly role?: string; readonly tags?: readonly string[] }
    | { readonly kind: 'link.revoke'; readonly id: string }
    | { readonly kind: 'rule.put'; readonly rule: Omit<RuleDef, 'source'> }
    | { readonly kind: 'rule.delete'; readonly id: string };
  type DQuery =
    | { readonly kind: 'assignments'; readonly scope?: ResourceRef; readonly subject?: AssignmentSubject; readonly role?: string; readonly includeExpired?: boolean; readonly page?: DPage }
    | { readonly kind: 'links'; readonly scope?: ResourceRef; readonly page?: DPage }
    | { readonly kind: 'rules'; readonly scope?: ResourceRef; readonly page?: DPage }
    | { readonly kind: 'holders'; readonly scope: ResourceRef; readonly permission: Permission; readonly expandSets?: boolean; readonly page?: DPage };
  type RbacKind = `${'assignment' | 'set' | 'link' | 'rule'}.${string}`;
  type Opts = { readonly reason?: string; readonly idempotencyKey?: string; readonly dryRun?: boolean };

  interface DAssignment {
    readonly id: string;
    readonly subject: DSubject;
    readonly role: string;
    readonly scope: ResourceRef;
    readonly tags?: readonly string[];
    readonly expiresAt?: Date | null;
    readonly grantedBy?: PrincipalRef;
    readonly source: string;
  }

  interface DSelector {
    readonly principalTypes?: readonly PrincipalType[];
    readonly actorTypes?: readonly PrincipalType[];
    readonly refs?: readonly PrincipalRef[];
    readonly rank?: { readonly ladder: string; readonly at: ResourceType; readonly lt?: string; readonly eq?: string; readonly gte?: string };
    readonly when?: Condition;
  }

  interface DRule {
    readonly id: string;
    readonly kind: 'restrict' | 'cap' | 'threshold';
    readonly scope: ResourceRef;
    readonly resourceTypes?: readonly ResourceType[];
    readonly subjects?: DSelector;
    readonly when?: Condition;
    readonly expiresAt?: Date | null;
    readonly source: string;
    readonly allow?: readonly DSubject[];
    readonly ladder?: string;
    readonly maxRole?: string | { readonly ref: string } | null;
    readonly stripTags?: boolean;
    readonly assignments?: { readonly scopeTypes?: readonly ResourceType[]; readonly subjectTypes?: readonly PrincipalType[] };
    readonly permissions?: readonly string[];
    readonly resource?: Condition;
    readonly minRole?: string | { readonly ref: string };
    readonly at?: ResourceType;
    readonly reason?: DenyReason & { readonly model?: never };
  }

  interface DLink {
    readonly id: string;
    readonly scope: ResourceRef;
    readonly expiresAt?: Date | null;
    readonly attributes: Readonly<Record<string, unknown>>;
    readonly createdBy?: PrincipalRef;
  }

  it('owns the data shapes the commands carry', () => {
    yes<Equal<AssignmentSubject, DSubject>>();
    yes<Equal<Assignment, DAssignment>>();
    yes<Equal<SubjectSelector, DSelector>>();
    yes<Equal<RuleDef, DRule>>();
    yes<Equal<LinkDef, DLink>>();
    expect(true).to.equal(true);
  });

  it('adds its commands and queries to AuthzCommand and AuthzAdminQuery', () => {
    yes<Equal<Extract<AuthzCommand, { kind: RbacKind }>, DCommand>>();
    yes<Equal<Extract<AuthzAdminQuery, { kind: 'assignments' | 'links' | 'rules' | 'holders' }>, DQuery>>();
    yes<Equal<AuthzCommandOf<'assignment.grant'>, Extract<DCommand, { kind: 'assignment.grant' }>>>();
    const commands: AuthzCommand[] = [
      { kind: 'assignment.grant', subject: actor, role: 'editor', scope, tags: ['a'], expiresAt: null, replaceLadder: true },
      { kind: 'assignment.revoke', id: '1' },
      { kind: 'assignment.revokeWhere', scope, subject: actor, role: 'editor' },
      { kind: 'assignment.setTags', id: '1', tags: [] },
      { kind: 'assignment.addTags', id: '1', tags: ['x'] },
      { kind: 'assignment.removeTags', id: '1', tags: ['x'] },
      { kind: 'assignment.setExpiry', id: '1', expiresAt: new Date(0) },
      { kind: 'set.addMember', set: { role: 'group.member', scope }, member: actor, expiresAt: null },
      { kind: 'set.removeMember', set: { role: 'group.member', scope }, member: actor },
      { kind: 'link.create', scope, role: 'viewer', tags: [], expiresAt: null, attributes: { org_only: true } },
      { kind: 'link.update', id: 'l', expiresAt: null, attributes: {}, role: 'viewer', tags: [] },
      { kind: 'link.revoke', id: 'l' },
      { kind: 'rule.put', rule: { id: 'r', kind: 'restrict', scope } },
      { kind: 'rule.delete', id: 'r' },
      { kind: 'scope.forget', scope },
    ];
    // @ts-expect-error scope is required
    const missing: AuthzCommand = { kind: 'assignment.grant', subject: actor, role: 'r' };
    // @ts-expect-error id is required
    const noId: AuthzCommand = { kind: 'link.revoke' };
    expect([...commands, missing, noId]).to.have.length(17);
  });

  it('types the AuthzAdmin sugar of its commands', () => {
    yes<Equal<Parameters<AuthzAdmin['assign']>, [actor: Principal, a: Omit<Extract<DCommand, { kind: 'assignment.grant' }>, 'kind'>, opts?: Opts]>>();
    yes<Equal<Awaited<ReturnType<AuthzAdmin['assign']>>, DAssignment>>();
    yes<Equal<Parameters<AuthzAdmin['createLink']>, [actor: Principal, l: Omit<Extract<DCommand, { kind: 'link.create' }>, 'kind'>, opts?: Opts]>>();
    yes<Equal<Awaited<ReturnType<AuthzAdmin['createLink']>>, { link: DLink; token: string }>>();
    yes<Equal<Parameters<AuthzAdmin['putRule']>, [actor: Principal, rule: Omit<DRule, 'source'>, opts?: Opts]>>();
    expect(true).to.equal(true);
  });

  it('types RuleDef.reason as a DenyReason without model', () => {
    const base = { id: 'r', kind: 'threshold', scope, source: 'db' } as const;
    const ok: RuleDef = { ...base, reason: { code: 'x', priority: 300, sortKey: 'a', tag: 't' } };
    // @ts-expect-error code is required
    const noCode: RuleDef = { ...base, reason: {} };
    // @ts-expect-error code is a string
    const badCode: RuleDef = { ...base, reason: { code: 42 } };
    // @ts-expect-error priority is a number
    const badPriority: RuleDef = { ...base, reason: { code: 'x', priority: 'high' } };
    // @ts-expect-error model is set by the engine
    const withModel: RuleDef = { ...base, reason: { code: 'x', model: 'rbac' } };
    expect([ok, noCode, badCode, badPriority, withModel]).to.have.length(5);
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
