import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DefaultQueueService } from '@spinajs/queue';
import type { User } from '@spinajs/users';

import { Users } from '../../src/admin/controllers/Users/Users.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { HttpClient, UsersHttpApp } from '../support/http-app.js';

/**
 * `order` and `include` of the admin user routes, through the http layer: `@Sort(User)` checks the column against
 * the `@Sortable()` columns of User and `@Include(User, ['Metadata'])` the relation names, so both are only seen
 * in a request.
 */
describe('users-http v3: sort and include of the admin user routes', function () {
  this.timeout(120000);

  let app: UsersHttpApp;
  let client: HttpClient;
  let target: User;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({ controllers: [Users] });

    const admin = await app.seedUser({ login: 'sort-admin', roles: ['admin'] });
    // seeded a moment apart: CreatedAt is the default sort
    await new Promise((r) => setTimeout(r, 1100));
    await app.seedUser({ login: 'sort-b' });
    await new Promise((r) => setTimeout(r, 1100));
    target = await app.seedUser({ login: 'sort-a', metadata: { 'user:niceName': 'Sort A' } });

    client = await app.signIn(admin.Uuid);
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  const list = (query: string) => client.get(`/users?${query}`);
  const order = (o: unknown) => `order=${encodeURIComponent(JSON.stringify(o))}`;
  const logins = (body: Array<{ Login: string }>) => body.map((u) => u.Login);

  it('sorts by CreatedAt, newest first, when no order is sent', async () => {
    const res = await list('');

    expect(res.status, res.text).to.eq(200);
    expect(logins(res.body)).to.deep.eq(['sort-a', 'sort-b', 'sort-admin']);
  });

  it('sorts by a sortable column in the requested direction', async () => {
    const asc = await list(order({ column: 'Login', order: 'ASC' }));
    expect(asc.status, asc.text).to.eq(200);
    expect(logins(asc.body)).to.deep.eq(['sort-a', 'sort-admin', 'sort-b']);

    const desc = await list(order({ column: 'Login', order: 'desc' }));
    expect(logins(desc.body)).to.deep.eq(['sort-b', 'sort-admin', 'sort-a']);
  });

  it('keeps the default direction when only a column is sent', async () => {
    const res = await list(order({ column: 'Login' }));

    expect(res.status, res.text).to.eq(200);
    expect(logins(res.body)).to.deep.eq(['sort-b', 'sort-admin', 'sort-a']);
  });

  for (const column of ['Password', 'Role', 'RegisteredAt']) {
    it(`answers 400 to a sort by ${column}, which is not sortable`, async () => {
      const res = await list(order({ column }));

      expect(res.status, res.text).to.eq(400);
    });
  }

  it('answers 400 to a sort direction other than ASC or DESC', async () => {
    const res = await list(order({ column: 'Login', order: 'sideways' }));

    expect(res.status, res.text).to.eq(400);
  });

  it('populates Metadata on the list only when included', async () => {
    const without = await list('');
    expect(without.body.find((u: { Login: string }) => u.Login === 'sort-a').Metadata ?? []).to.be.empty;

    const res = await list('include=Metadata');
    expect(res.status, res.text).to.eq(200);
    const row = res.body.find((u: { Login: string }) => u.Login === 'sort-a');
    expect(row.Metadata.map((m: { Key: string }) => m.Key)).to.include('user:niceName');
  });

  it('populates Metadata on the single-user routes when included', async () => {
    const byUuid = await client.get(`/users/${target.Uuid}?include=Metadata`);
    expect(byUuid.status, byUuid.text).to.eq(200);
    expect(byUuid.body.Metadata.map((m: { Key: string }) => m.Key)).to.include('user:niceName');

    const byLogin = await client.get(`/users/byLogin/${target.Login}?include=${encodeURIComponent('["Metadata"]')}`);
    expect(byLogin.status, byLogin.text).to.eq(200);
    expect(byLogin.body.Metadata.map((m: { Key: string }) => m.Key)).to.include('user:niceName');
  });

  it('answers 400 to an include of a relation the routes do not offer', async () => {
    for (const path of ['/users?include=Roles', `/users/${target.Uuid}?include=Roles`, `/users/byLogin/${target.Login}?include=Roles`]) {
      const res = await client.get(path);
      expect(res.status, `${path}: ${res.text}`).to.eq(400);
    }
  });
});
