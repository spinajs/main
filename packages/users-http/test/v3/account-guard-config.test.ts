import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA, AuthzConfigError } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { CONFIGURATION_CONTAINER_KEY, Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { User } from '@spinajs/users';

import { DefaultAccountGuard } from '../../src/index.js';

/** `authz.admin.guard` as the Configuration of a fresh child, checked by the authz schema; no file source. */
async function boot(guard: unknown): Promise<IContainer> {
  const json = JSON.stringify({ authz: { admin: { guard } } });
  const child = DI.RootContainer.child();
  child.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  child
    .register(
      class extends FrameworkConfiguration {
        protected loadSources(): void {
          this.Sources = [];
        }
        protected onLoad(): unknown {
          return JSON.parse(json) as unknown;
        }
      },
    )
    .as(Configuration);
  try {
    await child.resolve(Configuration);
    return child;
  } catch (e) {
    await child.dispose();
    throw e;
  }
}

describe('users-http v3: DefaultAccountGuard reads authz.admin.guard through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it('from the Configuration of its container, with every absent switch on', async () => {
    const child = await boot({ service: 'DefaultAdminGuard', privilegedPermission: 'users:update', preventSelfLockout: false });
    children.push(child);
    const guard = new DefaultAccountGuard();
    (guard as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;

    expect((guard as unknown as { Guard: unknown }).Guard).to.deep.include({ privilegedPermission: 'users:update', preventSelfLockout: false, preventLastPrivilegedRemoval: true });
  });

  it('names itself when a check is on without privilegedPermission, set past the schema', async () => {
    const child = await boot({ service: 'DefaultAdminGuard', privilegedPermission: 'users:update' });
    children.push(child);
    ((await child.resolve(Configuration)) as Configuration).set(['authz', 'admin', 'guard'], { preventSelfLockout: true });
    const guard = new DefaultAccountGuard();
    (guard as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;
    const actor = { type: 'user', id: 'actor' } as unknown as Principal;
    const target = { Uuid: 'target' } as unknown as User;

    for (const call of [() => guard.assertCanDisable(actor, target, 'ban'), () => guard.assertCanDemote(actor, target, [])]) {
      let error: unknown;
      try {
        await call();
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.match(/^users-http AccountGuard: authz\.admin\.guard\.privilegedPermission/);
    }
  });

  it('a check that is on without privilegedPermission fails the boot, not the first lifecycle call', async () => {
    let error: unknown;
    try {
      children.push(await boot({ service: 'DefaultAdminGuard', preventLastPrivilegedRemoval: true }));
    } catch (e) {
      error = e;
    }

    expect(error).to.be.instanceOf(InvalidConfiguration);
    expect((error as InvalidConfiguration).violations.map((v) => v.path)).to.include('authz.admin.guard.privilegedPermission');
  });
});
