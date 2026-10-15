import { expect } from 'chai';
import 'mocha';
import type { AuthzService, PrincipalRef } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

import { DbAssignmentStore, DbAuthzAdminBackend, DbMembershipStore, MembershipRebuildCommand, MembershipVerifyCommand, MemoryRoleStore, RoleStore, loadRoleIndex } from '../../src/index.js';
import type { MembershipCliContext, RoleDef } from '../../src/index.js';
import { bootDb } from '../support/db.js';
import type { TestDb } from '../support/db.js';
import { capture } from './fixture.js';

const ROLES: RoleDef[] = [{ name: 'group.member', extends: [], grants: [], assignable: true, subjectSet: true, scopeTypes: ['group'], source: 'test' }];
const alice: PrincipalRef = { type: 'user', id: 'alice' };
const g = (id: string) => ({ type: 'group', id });
const passThrough = { runAs: (_p: unknown, _r: unknown, fn: () => Promise<unknown>) => fn() } as unknown as AuthzService;

describe('authz:membership-verify and authz:membership-rebuild (sqlite)', function () {
  this.timeout(60000);
  let db: TestDb;
  let ctx: MembershipCliContext;

  before(async function () {
    db = await bootDb(this, 'sqlite', 'membership_cli');
    const roles = db.container.child();
    roles.register(testHost.instance(new MemoryRoleStore(ROLES, []))).as(RoleStore);
    ctx = {
      roles: await loadRoleIndex(roles, 'test'),
      assignments: db.container.resolve(DbAssignmentStore),
      memberships: db.container.resolve(DbMembershipStore),
      backend: new DbAuthzAdminBackend({ container: db.container }),
      maxDepth: 8,
    };
    // Rows written past AuthzAdmin, as an import would: the closure table stays empty.
    await ctx.backend.transaction('root', async (tx) => {
      await ctx.assignments.assign({ subject: alice, role: 'group.member', scope: g('g2') }, alice, tx);
      await ctx.assignments.assign({ subject: { set: { role: 'group.member', scope: g('g2') } }, role: 'group.member', scope: g('g1') }, alice, tx);
    });
  });
  after(async () => {
    await db?.dispose();
  });

  const run = async (cmd: MembershipVerifyCommand | MembershipRebuildCommand) => {
    cmd.Authz = passThrough;
    cmd.Membership = ctx;
    const io = capture();
    try {
      await cmd.execute();
      return { out: [...io.out], err: [...io.err], exitCode: io.exitCode() };
    } finally {
      io.restore();
    }
  };

  it('verify reports the missing rows and exits 1', async () => {
    const r = await run(new MembershipVerifyCommand());
    expect(r.out).to.deep.equal(['missing group:g2#group.member in group:g1#group.member depth 1', 'missing user:alice in group:g1#group.member depth 2', 'missing user:alice in group:g2#group.member depth 1']);
    expect(r.err[0]).to.contain('3 difference(s)');
    expect(r.exitCode).to.eq(1);
  });

  it('rebuild writes the closure, and verify is clean after it', async () => {
    const rebuilt = await run(new MembershipRebuildCommand());
    expect(rebuilt.out[0]).to.match(/^3 membership row\(s\) written/);
    expect(rebuilt.exitCode).to.eq(undefined);
    expect(await ctx.memberships.setsOf(['user:alice'], new Date())).to.deep.equal([{ setKey: 'group:g1#group.member' }, { setKey: 'group:g2#group.member' }]);
    const verified = await run(new MembershipVerifyCommand());
    expect(verified).to.deep.equal({ out: ['OK: authz_subject_membership matches the assignments'], err: [], exitCode: undefined });
  });

  it('verify reports a row no assignment explains, and rebuild removes it', async () => {
    await ctx.backend.transaction('root', (tx) => ctx.memberships.replace('user:ghost', [{ memberKey: 'user:ghost', setKey: 'group:g9#group.member', depth: 1, expiresAt: null }], tx));
    expect((await run(new MembershipVerifyCommand())).out).to.deep.equal(['extra user:ghost in group:g9#group.member depth 1']);
    await run(new MembershipRebuildCommand());
    expect(await ctx.memberships.memberKeys()).to.not.include('user:ghost');
  });
});
