import 'mocha';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DateTime } from 'luxon';

import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { DefaultQueueService } from '@spinajs/queue';
import type { Principal } from '@spinajs/authz';
import { User } from '@spinajs/users';
import type { IRouteCall, IRouteParameter, Request } from '@spinajs/http';

import { CurrentUserArg } from '../../src/index.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { UsersHttpApp } from '../support/http-app.js';

chai.use(chaiAsPromised);

const callData = ():IRouteCall => ({ Payload: {} }) as IRouteCall;
const param = { Index: 0, Name: 'user', Type: 'CurrentUserArg' } as unknown as IRouteParameter;
const requestOf = (principal: Principal | undefined): Request => ({ storage: principal ? { Principal: principal } : {} }) as unknown as Request;

const userPrincipal = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'session', attributes: {} });

/** `@CurrentUser()`: the users row of the request's authenticated user principal, read again as SYSTEM. */
describe('users-http v3: @CurrentUser() route arg', function () {
  this.timeout(60000);

  let app: UsersHttpApp;
  const arg = new CurrentUserArg();
  const extract = (principal: Principal | undefined) => arg.extract(callData(), [], param, requestOf(principal));

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({ controllers: [] });
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  it('resolves the row of the user principal with its metadata, as stored now', async () => {
    const user = await app.seedUser({ login: 'arg-me', metadata: { 'user:niceName': 'Arg Me' } });
    await User.update({ Login: 'arg-renamed' }).where({ Uuid: user.Uuid });

    const { Args } = await extract(userPrincipal(user.Uuid));

    expect(Args).to.be.instanceOf(User);
    expect((Args as User).Uuid).to.eq(user.Uuid);
    expect((Args as User).Login).to.eq('arg-renamed');
    expect((Args as User).Metadata['user:niceName']).to.eq('Arg Me');
  });

  it('refuses a request without a principal with 401', async () => {
    await expect(extract(undefined)).to.be.rejectedWith(AuthenticationFailed);
  });

  it('refuses the anonymous principal with 401', async () => {
    await expect(extract({ type: 'anonymous', id: 'anonymous', authenticated: false, source: 'anonymous', attributes: {} })).to.be.rejectedWith(AuthenticationFailed);
  });

  it('refuses a principal that is not a user with 403', async () => {
    await expect(extract({ type: 'service', id: 'probe', authenticated: true, source: 'service', attributes: {} })).to.be.rejectedWith(Forbidden);
  });

  it('refuses an agent acting for a user with 403', async () => {
    const owner = await app.seedUser({ login: 'arg-owner' });
    const agent: Principal = { type: 'agent', id: 'agent-1', authenticated: true, source: 'token', onBehalfOf: userPrincipal(owner.Uuid), attributes: {} };

    await expect(extract(agent)).to.be.rejectedWith(Forbidden);
  });

  it('refuses a user principal whose account was deleted with 401', async () => {
    const user = await app.seedUser({ login: 'arg-deleted' });
    await User.query().Driver.update().in('users').update({ DeletedAt: DateTime.now().toSQL({ includeOffset: false }) }).where('Uuid', user.Uuid);

    await expect(extract(userPrincipal(user.Uuid))).to.be.rejectedWith(AuthenticationFailed);
  });

  it('refuses a user principal that names no user with 401', async () => {
    await expect(extract(userPrincipal('00000000-0000-4000-8000-000000000000'))).to.be.rejectedWith(AuthenticationFailed);
  });
});
