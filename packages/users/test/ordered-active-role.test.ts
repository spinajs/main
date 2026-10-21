import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { RoleSource, SessionStartHook } from '@spinajs/authn/contracts';
import type { Principal, SessionHandle, SessionIssuer } from '@spinajs/authn/contracts';
import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

import { INITIAL_ROLE_KEY, OrderedActiveRoleHook } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';

const configured = (initial: unknown) => ({ authz: { principals: { roleSwitch: { initial } } } });
const ALICE: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'session', attributes: {} };
const HANDLE: SessionHandle = { id: 'raw-id', state: 'active' };
const SESSIONS = {} as SessionIssuer;

class HeldRoles extends RoleSource {
  public readonly asked: Principal[] = [];

  constructor(private readonly names: readonly string[]) {
    super();
  }

  public async rolesOf(principal: Principal): Promise<readonly { role: string; requirePassword: boolean }[]> {
    this.asked.push(principal);
    return this.names.map((role) => ({ role, requirePassword: true }));
  }
}

/** The hook reading `values` through a child Configuration, with `held` as the RoleSource's answer (none: no RoleSource). */
async function hookOver(values: Record<string, unknown>, held?: readonly string[]): Promise<{ hook: OrderedActiveRoleHook; roles?: HeldRoles }> {
  const { child } = await bootChild(values, AUTHZ_CONFIGURATION_SCHEMA);
  const hook = new OrderedActiveRoleHook();
  (hook as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;
  const roles = held ? new HeldRoles(held) : undefined;
  Object.defineProperty(hook, 'Roles', { value: roles });
  return { hook, roles };
}

describe('authz.principals.roleSwitch.initial and OrderedActiveRoleHook', () => {
  afterEach(disposeChildren);

  it('users registers it as a SessionStartHook', () => {
    expect((DI.getRegisteredTypes(SessionStartHook) ?? []).map((t) => (t as { name: string }).name)).to.include('OrderedActiveRoleHook');
  });

  for (const bad of ['admin', ['admin'], {}, { order: 'admin' }, { order: [] }, { order: [''] }, { order: ['admin', 'admin'] }]) {
    it(`fails the boot for ${JSON.stringify(bad)}, naming the key`, async () => {
      expect((await violationPaths(configured(bad), AUTHZ_CONFIGURATION_SCHEMA)).some((p) => p.startsWith(INITIAL_ROLE_KEY))).to.eq(true);
    });
  }

  for (const good of [null, { order: ['admin'] }, { order: ['user', 'admin'] }]) {
    it(`boots with ${JSON.stringify(good)}`, async () => {
      const { config } = await bootChild(configured(good), AUTHZ_CONFIGURATION_SCHEMA);
      expect(config.get(INITIAL_ROLE_KEY)).to.deep.eq(good);
    });
  }

  it('narrows a new session to the first role of the order the user holds, for a login and an MFA completion', async () => {
    const { hook, roles } = await hookOver(configured({ order: ['a', 'b'] }), ['b', 'a']);
    expect(await hook.onStart('login', HANDLE, ALICE, SESSIONS)).to.deep.eq({ roles: ['a'] });
    expect(await hook.onStart('mfa', HANDLE, ALICE, SESSIONS)).to.deep.eq({ roles: ['a'] });
    expect(roles!.asked).to.deep.eq([ALICE, ALICE]);

    const later = await hookOver(configured({ order: ['c', 'b', 'a'] }), ['a', 'b']);
    expect(await later.hook.onStart('login', HANDLE, ALICE, SESSIONS)).to.deep.eq({ roles: ['b'] });
  });

  it('leaves every held role when the user holds no listed role', async () => {
    const { hook } = await hookOver(configured({ order: ['x', 'y'] }), ['a', 'b']);
    expect(await hook.onStart('login', HANDLE, ALICE, SESSIONS)).to.eq(undefined);
  });

  for (const [label, values] of [
    ['unset', {}],
    ['null', configured(null)],
  ] as const) {
    it(`asks no RoleSource and narrows nothing while the key is ${label}`, async () => {
      const { hook, roles } = await hookOver(values, ['a']);
      expect(await hook.onStart('login', HANDLE, ALICE, SESSIONS)).to.eq(undefined);
      expect(roles!.asked).to.deep.eq([]);
    });
  }

  it('narrows nothing without a RoleSource', async () => {
    const { hook } = await hookOver(configured({ order: ['a'] }));
    expect(await hook.onStart('login', HANDLE, ALICE, SESSIONS)).to.eq(undefined);
  });
});
