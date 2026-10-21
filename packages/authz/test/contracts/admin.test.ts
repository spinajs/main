import * as chai from 'chai';
import 'mocha';
import { Exception } from '@spinajs/exceptions';

import { AuthzAdmin, AuthzAdminFailure, AdminGuard, AuthzCommandValidator, AuthzEventSink, AuthzWriteHandler } from '../../src/index.js';
import type { AdminContext, AuthzAdminError, AuthzAdminQuery, AuthzAdminQueryMap, AuthzCommand, AuthzCommandFields, AuthzCommandMap, AuthzCommandOf, AuthzCommandResult, AuthzCommandRow, AuthzEvent, AuthzService, AuthzTx, Principal, PrincipalRef, ResourceRef } from '../../src/index.js';
import * as root from '../../src/index.js';
import type { AuthzAdminOptions, Permission } from '../../src/index.js';

const expect = chai.expect;

const scope: ResourceRef = { type: 'file', id: 'f1' };
const user: PrincipalRef = { type: 'user', id: 'u1' };

describe('AuthzCommand', () => {
  it('accepts one literal per core kind', () => {
    const commands: AuthzCommand[] = [{ kind: 'scope.setAttributes', scope, patch: { a: null } }, { kind: 'scope.replaceAttributes', scope, attributes: {} }, { kind: 'scope.forget', scope }];
    expect(commands).to.have.length(3);
  });

  it('rejects malformed commands and the kinds no model declared', () => {
    // @ts-expect-error unknown kind
    const a: AuthzCommand = { kind: 'assignment.nope' };
    // @ts-expect-error the RBAC kinds are declared by @spinajs/authz-rbac, not by the core
    const b: AuthzCommand = { kind: 'assignment.revoke', id: '1' };
    // @ts-expect-error scope is required
    const c: AuthzCommand = { kind: 'scope.forget' };
    // @ts-expect-error patch, not attributes
    const d: AuthzCommand = { kind: 'scope.setAttributes', scope, attributes: {} };
    expect([a, b, c, d]).to.have.length(4);
  });
});

describe('AuthzCommandResult', () => {
  it('narrows on ok', () => {
    const results: AuthzCommandResult[] = [
      { ok: true, kind: 'scope.setAttributes', id: 'l', token: 't', affected: 1 },
      { ok: false, kind: 'scope.forget', error: { code: 'not_found', message: 'x', field: 'id' } },
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
    async assign(): Promise<AuthzCommandRow<'assignment.grant'>> {
      return { id: '1' };
    }
    async revoke(): Promise<void> {}
    async createLink(): Promise<{ link: AuthzCommandRow<'link.create'>; token: string }> {
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

  it('is implementable; without a model the sugar rows are unknown', async () => {
    const admin: AuthzAdmin = new Fake();
    const actor = {} as Principal;
    const a = await admin.assign(actor, {}, { reason: 'x', idempotencyKey: 'k', dryRun: true });
    expect(a).to.deep.eq({ id: '1' });
    const out = await admin.execute(actor, [{ kind: 'scope.forget', scope }]);
    expect(out[0].ok).to.eq(true);
  });

  it('types the core query', () => {
    const queries: AuthzAdminQuery[] = [{ kind: 'attributes', scope }];
    // @ts-expect-error attributes requires scope
    const bad: AuthzAdminQuery = { kind: 'attributes' };
    // @ts-expect-error the assignments query is declared by @spinajs/authz-rbac
    const rbac: AuthzAdminQuery = { kind: 'assignments' };
    expect([queries, bad, rbac]).to.have.length(3);
  });
});

describe('handler, guard, validator, sink', () => {
  const tx: AuthzTx = { driver: {} };
  const ctx: AdminContext = { domain: 'root', now: new Date(0), authz: {} as AuthzService, reason: 'x' };

  it('are implementable', async () => {
    const events: AuthzEvent[] = [{ type: 'RoleAssigned', domain: 'root', actor: user, at: new Date(0), data: {} }];
    class H extends AuthzWriteHandler {
      readonly kinds = ['scope.forget' as const];
      async validate(): Promise<void> {}
      permission() {
        return { permission: 'authz:assignments.manage', resource: scope };
      }
      async apply() {
        return { affected: 1, tags: ['t'], events };
      }
    }
    class AsyncH extends AuthzWriteHandler {
      readonly kinds = ['scope.forget' as const];
      async validate(): Promise<void> {}
      async permission(_c: AuthzCommand, x: AdminContext) {
        return { permission: 'authz:assignments.manage', resource: { type: 'file', id: x.domain } };
      }
      async apply() {
        return { affected: 1, tags: [], events: [] };
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
    const c: AuthzCommand = { kind: 'scope.forget', scope };
    const h: AuthzWriteHandler = new H();
    await h.validate(c, ctx);
    expect((await h.permission(c, ctx)).permission).to.eq('authz:assignments.manage');
    expect((await (new AsyncH() as AuthzWriteHandler).permission(c, ctx)).resource).to.deep.eq({ type: 'file', id: 'root' });
    expect((await h.apply(c, ctx, tx)).affected).to.eq(1);
    await (new G() as AdminGuard).check({} as Principal, c, ctx);
    await (new V() as AuthzCommandValidator).validate({} as Principal, c, ctx);
    await new S().publish(events);
    expect(published).to.have.length(1);
    expect(ctx.authz).to.not.eq(undefined);
  });
});

describe('AuthzAdminFailure', () => {
  it('is an Exception carrying code and field', () => {
    const e = new AuthzAdminFailure('not_found', 'no such id', 'id');
    expect(e).to.be.instanceOf(Exception);
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

  type DCommand = { readonly kind: 'scope.setAttributes'; readonly scope: ResourceRef; readonly patch: Readonly<Record<string, unknown>> } | { readonly kind: 'scope.replaceAttributes'; readonly scope: ResourceRef; readonly attributes: Readonly<Record<string, unknown>> } | { readonly kind: 'scope.forget'; readonly scope: ResourceRef };

  type DResult = { readonly ok: true; readonly kind: DCommand['kind']; readonly id?: string; readonly token?: string; readonly affected: number } | { readonly ok: false; readonly kind: DCommand['kind']; readonly error: { readonly code: string; readonly message: string; readonly field?: string } };

  type DQuery = { readonly kind: 'attributes'; readonly scope: ResourceRef };

  type Opts = { readonly reason?: string; readonly idempotencyKey?: string; readonly dryRun?: boolean };
  type Extra = Readonly<Record<string, unknown>>;

  it('pins the maps a model augments', () => {
    yes<Equal<keyof AuthzCommandMap, DCommand['kind']>>();
    yes<Equal<AuthzCommandMap['scope.forget'], Extract<DCommand, { kind: 'scope.forget' }>>>();
    yes<Equal<AuthzCommandOf<'scope.forget'>, Extract<DCommand, { kind: 'scope.forget' }>>>();
    yes<Equal<AuthzCommandOf<'assignment.grant'>, never>>();
    yes<Equal<AuthzCommandFields<'scope.forget'>, { readonly scope: ResourceRef }>>();
    yes<Equal<AuthzCommandRow<'assignment.grant'>, unknown>>();
    yes<Equal<keyof AuthzAdminQueryMap, 'attributes'>>();
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
    yes<Equal<AuthzAdmin['assign'], (actor: Principal, a: AuthzCommandFields<'assignment.grant'>, opts?: Opts) => Promise<AuthzCommandRow<'assignment.grant'>>>>();
    yes<Equal<AuthzAdmin['revoke'], (actor: Principal, id: string, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['createLink'], (actor: Principal, l: AuthzCommandFields<'link.create'>, opts?: Opts) => Promise<{ link: AuthzCommandRow<'link.create'>; token: string }>>>();
    yes<Equal<AuthzAdmin['revokeLink'], (actor: Principal, id: string, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['setTags'], (actor: Principal, assignmentId: string, tags: readonly string[], opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['putRule'], (actor: Principal, rule: AuthzCommandOf<'rule.put'>['rule'], opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['deleteRule'], (actor: Principal, id: string, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['putPolicy'], (actor: Principal, policy: AuthzCommandOf<'policy.put'>['policy'], opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['deletePolicy'], (actor: Principal, id: string, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['setScopeAttributes'], (actor: Principal, scope: ResourceRef, patch: Extra, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['forgetScope'], (actor: Principal, scope: ResourceRef, opts?: Opts) => Promise<void>>>();
    yes<Equal<AuthzAdmin['list'], (actor: Principal, q: DQuery) => Promise<{ items: readonly unknown[]; total: number; next?: string }>>>();

    yes<Equal<keyof AuthzWriteHandler, 'kinds' | 'validate' | 'permission' | 'apply'>>();
    yes<Equal<Pick<AuthzWriteHandler, 'kinds'>, { readonly kinds: readonly DCommand['kind'][] }>>();
    yes<Equal<AuthzWriteHandler['validate'], (c: DCommand, ctx: AdminContext) => Promise<void>>>();
    yes<Equal<AuthzWriteHandler['permission'], (c: DCommand, ctx: AdminContext) => { permission: Permission; resource: ResourceRef } | Promise<{ permission: Permission; resource: ResourceRef }>>>();
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
    expect({ ...new AuthzAdminFailure('x', undefined, undefined, { cause: 'c' }) }).to.not.have.property('cause');
  });
});
