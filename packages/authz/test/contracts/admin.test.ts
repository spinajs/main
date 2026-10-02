import * as chai from 'chai';
import 'mocha';

import { AuthzAdmin, AuthzAdminFailure, AdminGuard, AuthzCommandValidator, AuthzEventSink, AuthzWriteHandler } from '../../src/index.js';
import type { AdminContext, Assignment, AssignmentSubject, AuthzAdminError, AuthzAdminQuery, AuthzCommand, AuthzCommandResult, AuthzEvent, AuthzService, AuthzTx, LinkDef, Policy, Principal, PrincipalRef, ResourceRef, RuleDef } from '../../src/index.js';
import * as root from '../../src/index.js';
import type { AuthzAdminOptions, Condition, DenyReason, FieldSet, Permission, PrincipalType, ResourceType, SubjectSelector } from '../../src/index.js';

const expect = chai.expect;

const scope: ResourceRef = { type: 'file', id: 'f1' };
const user: PrincipalRef = { type: 'user', id: 'u1' };

describe('AuthzCommand', () => {
  it('accepts one literal per kind', () => {
    const commands: AuthzCommand[] = [
      { kind: 'assignment.grant', subject: user, role: 'editor', scope, tags: ['a'], expiresAt: null, replaceLadder: true },
      { kind: 'assignment.revoke', id: '1' },
      { kind: 'assignment.revokeWhere', scope, subject: user, role: 'editor' },
      { kind: 'assignment.setTags', id: '1', tags: [] },
      { kind: 'assignment.addTags', id: '1', tags: ['x'] },
      { kind: 'assignment.removeTags', id: '1', tags: ['x'] },
      { kind: 'assignment.setExpiry', id: '1', expiresAt: new Date(0) },
      { kind: 'set.addMember', set: { role: 'group.member', scope }, member: user, expiresAt: null },
      { kind: 'set.removeMember', set: { role: 'group.member', scope }, member: user },
      { kind: 'link.create', scope, role: 'viewer', tags: [], expiresAt: null, attributes: { org_only: true } },
      { kind: 'link.update', id: 'l', expiresAt: null, attributes: {}, role: 'viewer', tags: [] },
      { kind: 'link.revoke', id: 'l' },
      { kind: 'rule.put', rule: { id: 'r', kind: 'restrict', scope } },
      { kind: 'rule.delete', id: 'r' },
      { kind: 'policy.put', policy: { id: 'p', effect: 'permit', permissions: ['*:read'] } },
      { kind: 'policy.delete', id: 'p' },
      { kind: 'scope.setAttributes', scope, patch: { a: null } },
      { kind: 'scope.replaceAttributes', scope, attributes: {} },
      { kind: 'scope.forget', scope },
    ];
    expect(commands).to.have.length(19);
  });

  it('rejects malformed commands', () => {
    // @ts-expect-error unknown kind
    const a: AuthzCommand = { kind: 'assignment.nope' };
    // @ts-expect-error scope is required
    const b: AuthzCommand = { kind: 'assignment.grant', subject: user, role: 'r' };
    // @ts-expect-error id is required
    const c: AuthzCommand = { kind: 'link.revoke' };
    // @ts-expect-error patch, not attributes
    const d: AuthzCommand = { kind: 'scope.setAttributes', scope, attributes: {} };
    expect([a, b, c, d]).to.have.length(4);
  });
});

describe('AuthzCommandResult', () => {
  it('narrows on ok', () => {
    const results: AuthzCommandResult[] = [
      { ok: true, kind: 'link.create', id: 'l', token: 't', affected: 1 },
      { ok: false, kind: 'link.create', error: { code: 'not_found', message: 'x', field: 'id' } },
    ];
    for (const r of results) {
      if (r.ok) {
        const token: string | undefined = r.token;
        // @ts-expect-error no error on the ok branch
        r.error;
        expect(token).to.eq('t');
      } else {
        const error: AuthzAdminError = r.error;
        // @ts-expect-error no token on the failed branch
        r.token;
        expect(error.code).to.eq('not_found');
      }
    }
  });
});

describe('AuthzAdmin', () => {
  class Fake extends AuthzAdmin {
    async execute(_a: Principal, commands: readonly AuthzCommand[]): Promise<readonly AuthzCommandResult[]> {
      return commands.map((c) => ({ ok: true as const, kind: c.kind, affected: 1 }));
    }
    async assign(_a: Principal, a: Omit<Extract<AuthzCommand, { kind: 'assignment.grant' }>, 'kind'>): Promise<Assignment> {
      return { id: '1', subject: a.subject, role: a.role, scope: a.scope, source: 'test' };
    }
    async revoke(): Promise<void> {}
    async createLink(): Promise<{ link: LinkDef; token: string }> {
      return { link: { id: 'l', scope, attributes: {} }, token: 't' };
    }
    async revokeLink(): Promise<void> {}
    async setTags(): Promise<void> {}
    async putRule(): Promise<void> {}
    async deleteRule(): Promise<void> {}
    async putPolicy(): Promise<void> {}
    async deletePolicy(): Promise<void> {}
    async setScopeAttributes(): Promise<void> {}
    async forgetScope(): Promise<void> {}
    async list(): Promise<{ items: readonly unknown[]; total: number }> {
      return { items: [], total: 0 };
    }
  }

  it('is implementable and its sugar takes the grant without kind', async () => {
    const admin: AuthzAdmin = new Fake();
    const actor = {} as Principal;
    const a = await admin.assign(actor, { subject: user, role: 'editor', scope }, { reason: 'x', idempotencyKey: 'k', dryRun: true });
    // @ts-expect-error kind is stripped from the sugar parameter
    await admin.assign(actor, { kind: 'assignment.grant', subject: user, role: 'editor', scope });
    expect(a.role).to.eq('editor');
    const out = await admin.execute(actor, [{ kind: 'assignment.revoke', id: '1' }]);
    expect(out[0].ok).to.eq(true);
  });

  it('types the query variants', () => {
    const queries: AuthzAdminQuery[] = [{ kind: 'assignments', scope, subject: user, role: 'r', includeExpired: true, page: { limit: 1, offset: 0 } }, { kind: 'links' }, { kind: 'rules', scope, page: { limit: 1, offset: 0 } }, { kind: 'policies' }, { kind: 'attributes', scope }];
    // @ts-expect-error attributes requires scope
    const bad: AuthzAdminQuery = { kind: 'attributes' };
    expect([queries, bad]).to.have.length(2);
  });
});

describe('handler, guard, validator, sink', () => {
  const tx: AuthzTx = { driver: {} };
  const ctx: AdminContext = { domain: 'root', now: new Date(0), authz: {} as AuthzService, reason: 'x' };

  it('are implementable', async () => {
    const events: AuthzEvent[] = [{ type: 'RoleAssigned', domain: 'root', actor: user, at: new Date(0), data: {} }];
    class H extends AuthzWriteHandler {
      readonly kinds = ['assignment.revoke' as const];
      async validate(): Promise<void> {}
      permission() {
        return { permission: 'authz:assignments.manage', resource: scope };
      }
      async apply() {
        return { affected: 1, tags: ['t'], events };
      }
    }
    class G extends AdminGuard {
      async check(): Promise<void> {}
    }
    class V extends AuthzCommandValidator {
      async validate(): Promise<void> {}
    }
    const published: AuthzEvent[] = [];
    class S extends AuthzEventSink {
      async publish(e: readonly AuthzEvent[]): Promise<void> {
        published.push(...e);
      }
    }
    const c: AuthzCommand = { kind: 'assignment.revoke', id: '1' };
    const h: AuthzWriteHandler = new H();
    await h.validate(c, ctx);
    expect(h.permission(c).permission).to.eq('authz:assignments.manage');
    expect((await h.apply(c, ctx, tx)).affected).to.eq(1);
    await (new G() as AdminGuard).check({} as Principal, c, ctx);
    await (new V() as AuthzCommandValidator).validate({} as Principal, c, ctx);
    await new S().publish(events);
    expect(published).to.have.length(1);
    expect(ctx.authz).to.not.eq(undefined);
  });
});

describe('data shapes', () => {
  it('AssignmentSubject', () => {
    const p: AssignmentSubject = user;
    const s: AssignmentSubject = { set: { role: 'group.member', scope } };
    // @ts-expect-error set needs a scope
    const bad: AssignmentSubject = { set: { role: 'group.member' } };
    expect([p, s, bad]).to.have.length(3);
  });

  it('RuleDef of each kind, Policy and LinkDef', () => {
    const restrict: RuleDef = { id: 'r1', kind: 'restrict', scope, resourceTypes: ['file'], subjects: { principalTypes: ['user'], actorTypes: ['agent'], refs: [user], rank: { ladder: 'l', at: 'org', lt: 'a', eq: 'b', gte: 'c' }, when: { attr: 'principal.id', eq: '1' } }, when: { attr: 'env.x', eq: 1 }, expiresAt: null, source: 'db', allow: [user, { set: { role: 'r', scope } }] };
    const cap: RuleDef = { id: 'r2', kind: 'cap', scope, source: 'db', ladder: 'l', maxRole: { ref: 'scope.org.role' }, stripTags: true, assignments: { scopeTypes: ['file'], subjectTypes: ['user'] } };
    const capNull: RuleDef = { id: 'r3', kind: 'cap', scope, source: 'db', maxRole: null };
    const threshold: RuleDef = { id: 'r4', kind: 'threshold', scope, source: 'db', permissions: ['file:write'], resource: { attr: 'resource.name', wildcard: 'release/*' }, minRole: 'maintainer', at: 'project', reason: { code: 'protected', priority: 100 } };
    const policy: Policy = { id: 'p', effect: 'deny', permissions: ['*:*'], resourceTypes: ['file'], principalTypes: ['user'], actorTypes: ['agent'], scope, when: { attr: 'principal.id', eq: '1' }, fields: { hide: ['x'] }, reason: 'why', priority: 10, expiresAt: null, source: 'db' };
    const link: LinkDef = { id: 'l', scope, expiresAt: null, attributes: { org_only: true }, createdBy: user };
    expect([restrict, cap, capNull, threshold, policy, link]).to.have.length(6);
  });
});

describe('AuthzAdminFailure', () => {
  it('is an Error carrying code and field', () => {
    const e = new AuthzAdminFailure('not_found', 'no such id', 'id');
    expect(e).to.be.instanceOf(Error);
    expect(e.name).to.eq('AuthzAdminFailure');
    expect(e.code).to.eq('not_found');
    expect(e.field).to.eq('id');
    expect(e.message).to.eq('no such id');
    const err: AuthzAdminError = { code: e.code, message: e.message, field: e.field };
    expect(err.code).to.eq('not_found');
  });

  it('defaults the message to the code', () => {
    const e = new AuthzAdminFailure('forbidden');
    expect(e.message).to.eq('forbidden');
    expect(e.field).to.eq(undefined);
  });

  it('is exported from the package root', () => {
    expect(root.AuthzAdminFailure).to.eq(AuthzAdminFailure);
  });
});

describe('pinned shapes (copies of design 6.6.1 and 5.8)', () => {
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  const yes = <_T extends true>(): void => {};

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
    | { readonly kind: 'rule.delete'; readonly id: string }
    | { readonly kind: 'policy.put'; readonly policy: Omit<Policy, 'source'> }
    | { readonly kind: 'policy.delete'; readonly id: string }
    | { readonly kind: 'scope.setAttributes'; readonly scope: ResourceRef; readonly patch: Readonly<Record<string, unknown>> }
    | { readonly kind: 'scope.replaceAttributes'; readonly scope: ResourceRef; readonly attributes: Readonly<Record<string, unknown>> }
    | { readonly kind: 'scope.forget'; readonly scope: ResourceRef };

  type DResult = { readonly ok: true; readonly kind: DCommand['kind']; readonly id?: string; readonly token?: string; readonly affected: number } | { readonly ok: false; readonly kind: DCommand['kind']; readonly error: { readonly code: string; readonly message: string; readonly field?: string } };

  type DQuery = { readonly kind: 'assignments'; readonly scope?: ResourceRef; readonly subject?: AssignmentSubject; readonly role?: string; readonly includeExpired?: boolean; readonly page?: { limit: number; offset: number } } | { readonly kind: 'links' | 'rules' | 'policies'; readonly scope?: ResourceRef; readonly page?: { limit: number; offset: number } } | { readonly kind: 'attributes'; readonly scope: ResourceRef };

  type DSubject = PrincipalRef | { readonly set: { readonly role: string; readonly scope: ResourceRef } };

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

  interface DPolicy {
    readonly id: string;
    readonly effect: 'permit' | 'deny';
    readonly permissions: readonly string[];
    readonly resourceTypes?: readonly ResourceType[];
    readonly principalTypes?: readonly PrincipalType[];
    readonly actorTypes?: readonly PrincipalType[];
    readonly scope?: ResourceRef;
    readonly when?: Condition;
    readonly fields?: FieldSet;
    readonly reason?: string;
    readonly priority?: number;
    readonly expiresAt?: Date | null;
    readonly source: string;
  }

  type Opts = { readonly reason?: string; readonly idempotencyKey?: string; readonly dryRun?: boolean };
  type Extra = Readonly<Record<string, unknown>>;

  it('pins the data shapes', () => {
    yes<Equal<AssignmentSubject, DSubject>>();
    yes<Equal<Assignment, DAssignment>>();
    yes<Equal<SubjectSelector, DSelector>>();
    yes<Equal<RuleDef, DRule>>();
    yes<Equal<LinkDef, DLink>>();
    yes<Equal<Policy, DPolicy>>();
  });

  it('pins the command, result, query and plain interfaces', () => {
    yes<Equal<AuthzCommand, DCommand>>();
    yes<Equal<AuthzCommand['kind'], DCommand['kind']>>();
    yes<Equal<AuthzCommandResult, DResult>>();
    yes<Equal<AuthzAdminQuery, DQuery>>();
    yes<Equal<AuthzAdminError, { readonly code: string; readonly message: string; readonly field?: string }>>();
    yes<Equal<AuthzAdminOptions, Opts>>();
    yes<Equal<AuthzEvent, { readonly type: string; readonly domain: string; readonly actor: PrincipalRef; readonly at: Date; readonly data: Readonly<Record<string, unknown>> }>>();
    yes<Equal<AuthzTx, { readonly driver: unknown }>>();
    yes<Equal<AdminContext, { readonly domain: string; readonly now: Date; readonly authz: AuthzService; readonly reason?: string }>>();
  });

  it('pins the abstract classes', () => {
    yes<Equal<keyof AuthzAdmin, 'execute' | 'assign' | 'revoke' | 'createLink' | 'revokeLink' | 'setTags' | 'putRule' | 'deleteRule' | 'putPolicy' | 'deletePolicy' | 'setScopeAttributes' | 'forgetScope' | 'list'>>();
    yes<Equal<AuthzAdmin['execute'], (actor: Principal, commands: readonly DCommand[], opts?: Opts) => Promise<readonly DResult[]>>>();
    yes<Equal<AuthzAdmin['assign'], (actor: Principal, a: Omit<Extract<DCommand, { kind: 'assignment.grant' }>, 'kind'>, opts?: Opts) => Promise<DAssignment>>>();
    yes<Equal<AuthzAdmin['revoke'], (actor: Principal, id: string, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['createLink'], (actor: Principal, l: Omit<Extract<DCommand, { kind: 'link.create' }>, 'kind'>, opts?: Opts) => Promise<{ link: DLink; token: string }>>>();
    yes<Equal<AuthzAdmin['revokeLink'], (actor: Principal, id: string, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['setTags'], (actor: Principal, assignmentId: string, tags: readonly string[], opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['putRule'], (actor: Principal, rule: Omit<DRule, 'source'>, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['deleteRule'], (actor: Principal, id: string, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['putPolicy'], (actor: Principal, policy: Omit<DPolicy, 'source'>, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['deletePolicy'], (actor: Principal, id: string, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['setScopeAttributes'], (actor: Principal, scope: ResourceRef, patch: Extra, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['forgetScope'], (actor: Principal, scope: ResourceRef, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['list'], (actor: Principal, q: DQuery) => Promise<{ items: readonly unknown[]; total: number }>>>();

    yes<Equal<keyof AuthzWriteHandler, 'kinds' | 'validate' | 'permission' | 'apply'>>();
    yes<Equal<Pick<AuthzWriteHandler, 'kinds'>, { readonly kinds: readonly DCommand['kind'][] }>>();
    yes<Equal<AuthzWriteHandler['validate'], (c: DCommand, ctx: AdminContext) => Promise<void>>>();
    yes<Equal<AuthzWriteHandler['permission'], (c: DCommand) => { permission: Permission; resource: ResourceRef }>>();
    yes<Equal<AuthzWriteHandler['apply'], (c: DCommand, ctx: AdminContext, tx: AuthzTx) => Promise<{ id?: string; token?: string; affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }>>>();

    yes<Equal<keyof AdminGuard, 'check'>>();
    yes<Equal<AdminGuard['check'], (actor: Principal, c: DCommand, ctx: AdminContext) => Promise<void>>>();
    yes<Equal<keyof AuthzCommandValidator, 'validate'>>();
    yes<Equal<AuthzCommandValidator['validate'], (actor: Principal, c: DCommand, ctx: AdminContext) => Promise<void>>>();
    yes<Equal<keyof AuthzEventSink, 'publish'>>();
    yes<Equal<AuthzEventSink['publish'], (events: readonly AuthzEvent[]) => Promise<void>>>();
  });

  it('pins AuthzAdminFailure', () => {
    yes<Equal<ConstructorParameters<typeof AuthzAdminFailure>, [code: string, message?: string, field?: string, options?: ErrorOptions]>>();
    yes<Equal<Pick<AuthzAdminFailure, 'code' | 'field'>, { readonly code: string; readonly field?: string }>>();
    expect(new AuthzAdminFailure('x', undefined, undefined, { cause: 'c' }).cause).to.eq('c');
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
