import 'mocha';
import { expect } from 'chai';
import { FALSE, SYSTEM, TRUE, UNATTENDED } from '@spinajs/authz';
import type { Decision, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import type { PrincipalRef } from '@spinajs/principal';
import { AuthzSignalAuthorizer, StampedSignalPrincipalFactory } from '../src/index.js';

const CTX = { instanceId: 'wf-1', workflow: 'order', event: 'approved' };

interface Check {
  principal: Principal;
  permission: string;
  resource: ResourceRef;
}

/** The authorizer with its three seams replaced: the stamped factory without its warning, a scripted decision, a counted refusal. */
class TestAuthorizer extends AuthzSignalAuthorizer {
  public checked: Check[] = [];
  public refusals = 0;
  /** `principal id|permission` to the residual of an allow; anything else is denied. */
  public allows = new Map<string, ResourceFilter>();
  private readonly stamped = new StampedSignalPrincipalFactory({ warn: false });

  protected principalOf(ref: PrincipalRef): Promise<Principal> {
    return this.stamped.principalOf(ref);
  }

  protected decide(principal: Principal, permission: string, resource: ResourceRef): Promise<Decision> {
    this.checked.push({ principal, permission, resource });
    const residual = this.allows.get(`${principal.id}|${permission}`);
    return Promise.resolve({
      allowed: residual !== undefined,
      permission,
      resource,
      principal: { type: principal.type, id: principal.id },
      residual: residual ?? FALSE,
      fields: { read: [], write: [] },
      roles: {},
      domain: 'root',
    });
  }

  protected refused(): void {
    this.refusals++;
  }
}

describe('AuthzSignalAuthorizer', () => {
  let authorizer: TestAuthorizer;

  beforeEach(() => {
    authorizer = new TestAuthorizer();
  });

  it('allows a principal the engine allows, checked as the stamped identity on the type of the permission', async () => {
    authorizer.allows.set('approver|orders:approve', TRUE);
    expect(await authorizer.authorize('user:approver', 'orders:approve', undefined, CTX)).to.equal(true);
    const [check] = authorizer.checked;
    expect([check.permission, check.resource]).to.deep.equal(['orders:approve', { type: 'orders' }]);
    expect(check.principal).to.deep.include({ type: 'user', id: 'approver', authenticated: true, source: 'workflow' });
  });

  it('passes a { type, id } resource and denies a conditional allow on that row', async () => {
    authorizer.allows.set('approver|orders:approve', { op: 'relation', relation: 'owner' });
    expect(await authorizer.authorize('user:approver', 'orders:approve', { type: 'orders', id: 'A-1' }, CTX)).to.equal(false);
    expect(authorizer.checked[0].resource).to.deep.equal({ type: 'orders', id: 'A-1' });
  });

  it('allows a conditional allow at the type level, as authz-queue does', async () => {
    authorizer.allows.set('approver|orders:approve', { op: 'relation', relation: 'owner' });
    expect(await authorizer.authorize('user:approver', 'orders:approve', { type: 'orders' }, CTX)).to.equal(true);
  });

  it('denies what the engine denies', async () => {
    expect(await authorizer.authorize('user:clerk', 'orders:approve', undefined, CTX)).to.equal(false);
    expect(authorizer.checked).to.have.length(1);
  });

  it('denies an unknown or malformed principal without asking the engine', async () => {
    expect(await authorizer.authorize(undefined, 'orders:approve', undefined, CTX)).to.equal(false);
    expect(await authorizer.authorize('no-colon', 'orders:approve', undefined, CTX)).to.equal(false);
    expect([authorizer.checked, authorizer.refusals]).to.deep.equal([[], 0]);
  });

  it('denies and reports a resource that is not { type, id? } and a permission that is not resource:action', async () => {
    authorizer.allows.set('approver|orders:approve', TRUE);
    authorizer.allows.set('approver|approve', TRUE);
    expect(await authorizer.authorize('user:approver', 'orders:approve', { kind: 'orders' }, CTX)).to.equal(false);
    expect(await authorizer.authorize('user:approver', 'orders:approve', { type: 'orders', id: 7 }, CTX)).to.equal(false);
    expect(await authorizer.authorize('user:approver', 'approve', undefined, CTX)).to.equal(false);
    expect(await authorizer.authorize('user:approver', 'orders:approve', null, CTX)).to.equal(false);
    expect([authorizer.checked, authorizer.refusals]).to.deep.equal([[], 4]);
  });
});

describe('StampedSignalPrincipalFactory', () => {
  it('maps system and unattended stamps to the singletons', async () => {
    const factory = new StampedSignalPrincipalFactory({ warn: false });
    expect(await factory.principalOf({ type: 'system', id: 'system' })).to.equal(SYSTEM);
    expect(await factory.principalOf({ type: 'unattended', id: 'x' })).to.equal(UNATTENDED);
    expect(await factory.principalOf({ type: 'anonymous', id: 'a' })).to.deep.include({ authenticated: false });
  });
});
