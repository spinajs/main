import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DefaultQueueService } from '@spinajs/queue';
import type { User } from '@spinajs/users';

import { Users } from '../../src/admin/controllers/Users/Users.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { UsersHttpApp } from '../support/http-app.js';

/**
 * With a manifest in effect, argument names come from the manifest. `@Filter` is not a decorator the compiler records,
 * so the list's `filter` must still bind by its source name next to the recorded `@Query` arguments.
 */
describe('users-http v3: the admin user list in manifest mode', function () {
  this.timeout(120000);

  let app: UsersHttpApp;
  let admin: User;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({ controllers: [Users], manifestMode: 'prefer' });
    admin = await app.seedUser({ login: 'manifest-admin', roles: ['admin'] });
    await app.seedUser({ login: 'manifest-target' });
    await app.seedUser({ login: 'manifest-other' });
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  it('applies the filter argument', async () => {
    const client = await app.signIn(admin.Uuid);
    const filter = JSON.stringify({ op: 'and', filters: [{ Column: 'Login', Operator: 'eq', Value: 'manifest-target' }] });

    const res = await client.get(`/users?filter=${encodeURIComponent(filter)}`);

    expect(res.status, res.text).to.eq(200);
    expect((res.body as Array<{ Login: string }>).map((u) => u.Login)).to.deep.equal(['manifest-target']);
  });
});
