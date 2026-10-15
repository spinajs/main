import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, AuthzCommandValidator, AuthzConfigError, AuthzWriteHandler, GLOBAL, ListSupportGuard, ListSupportValidator } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzEvent, Permission, ResourceRef } from '@spinajs/authz';
import { adminConfig, adminDomain, installHost, instance, rejection, resetHost, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');

class PolicyRuleHandler extends AuthzWriteHandler {
  readonly kinds = ['policy.put', 'rule.put'] as const;

  async validate(): Promise<void> {}

  permission(): { permission: Permission; resource: ResourceRef } {
    return { permission: 'app:settings.manage', resource: { type: 'project', id: 'p1' } };
  }

  async apply(): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 1, tags: ['policy:changed'], events: [] };
  }
}

/** Refuses ids starting with "bad"; `error`, when set, is thrown instead. */
class RecordingGuard extends ListSupportGuard {
  readonly seen: string[] = [];
  error: unknown;

  async checkCommand(c: AuthzCommand, _ctx: AdminContext): Promise<void> {
    this.seen.push(c.kind);
    if (this.error !== undefined) throw this.error;
    const id = c.kind === 'policy.put' ? c.policy.id : c.kind === 'rule.put' ? c.rule.id : '';
    if (id.startsWith('bad')) throw new Error(`${c.kind} ${id} reads resource.status, so doc:read is not list-filterable`);
  }
}

const putPolicy = (id: string): AuthzCommand => ({ kind: 'policy.put', policy: { id, effect: 'permit', permissions: ['doc:read'] } });
const putRule = (id: string): AuthzCommand => ({ kind: 'rule.put', rule: { id, kind: 'cap', scope: GLOBAL } });
const errorOf = (r: unknown) => (r as { error: { code: string; message: string; field?: string } }).error;

async function domain(guard?: RecordingGuard): Promise<AdminDomain> {
  return adminDomain('test', {
    register(c) {
      c.register(PolicyRuleHandler).as(AuthzWriteHandler);
      if (guard) c.register(instance(guard)).as(ListSupportGuard);
    },
  });
}

describe('ListSupportValidator', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
  });

  it('is a built-in AuthzCommandValidator', () => {
    expect(new ListSupportValidator()).to.be.instanceOf(AuthzCommandValidator);
  });

  it('refuses a policy.put a guard refuses with not_list_filterable', async () => {
    const d = await domain(new RecordingGuard());
    const out = await d.admin.execute(alice, [putPolicy('bad1')]);
    expect(out[0]).to.deep.include({ ok: false, kind: 'policy.put' });
    expect(errorOf(out[0])).to.deep.include({ code: 'not_list_filterable', field: 'policy' });
    expect(errorOf(out[0]).message).to.contain('resource.status');
    expect(d.bus.published).to.deep.equal([]);
  });

  it('refuses a rule.put the same way', async () => {
    const d = await domain(new RecordingGuard());
    const out = await d.admin.execute(alice, [putRule('bad-rule')]);
    expect(errorOf(out[0])).to.deep.include({ code: 'not_list_filterable', field: 'rule' });
  });

  it('lets an accepted policy.put through', async () => {
    const d = await domain(new RecordingGuard());
    expect(await d.admin.execute(alice, [putPolicy('good')])).to.deep.equal([{ ok: true, kind: 'policy.put', affected: 1 }]);
  });

  it('asks the guards about policy.put and rule.put only', async () => {
    const guard = new RecordingGuard();
    const d = await domain(guard);
    await d.admin.execute(alice, [{ kind: 'assignment.grant', subject: { type: 'user', id: 'bob' }, role: 'editor', scope: { type: 'project', id: 'p1' } }, putPolicy('good'), putRule('good')]);
    expect(guard.seen).to.deep.equal(['policy.put', 'rule.put']);
  });

  it('passes an AuthzAdminFailure of a guard through as is', async () => {
    const guard = new RecordingGuard();
    guard.error = new AuthzAdminFailure('conflict', 'busy', 'policy.id');
    const d = await domain(guard);
    expect(errorOf((await d.admin.execute(alice, [putPolicy('good')]))[0])).to.deep.equal({ code: 'conflict', message: 'busy', field: 'policy.id' });
  });

  it('lets an AuthzConfigError of a guard reject the batch', async () => {
    const guard = new RecordingGuard();
    guard.error = new AuthzConfigError('broken guard');
    const d = await domain(guard);
    expect(await rejection(d.admin.execute(alice, [putPolicy('good')]))).to.be.instanceOf(AuthzConfigError);
  });

  it('accepts every policy.put when no guard is registered', async () => {
    const d = await domain();
    expect(await d.admin.execute(alice, [putPolicy('bad1')])).to.deep.equal([{ ok: true, kind: 'policy.put', affected: 1 }]);
  });
});
