import * as chai from 'chai';
import 'mocha';

import { AuthzAdmin, AuthzAdminFailure, AdminGuard, AuthzCommandValidator, AuthzEventSink, AuthzWriteHandler } from '../../src/index.js';
import type { AdminContext, Assignment, AssignmentSubject, AuthzAdminError, AuthzAdminQuery, AuthzCommand, AuthzCommandResult, AuthzEvent, AuthzService, AuthzTx, LinkDef, Policy, Principal, PrincipalRef, ResourceRef, RuleDef } from '../../src/index.js';
import * as root from '../../src/index.js';

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
