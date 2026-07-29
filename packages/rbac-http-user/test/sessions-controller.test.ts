// Pure unit test: the controller is constructed directly and its injected
// fields are set by hand, so it does not touch the process-wide DI container
// that sibling suites contaminate.
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DateTime } from 'luxon';

import { NotFound, Ok } from '@spinajs/http';
import { hashSessionId } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';

import { SessionsController } from '../src/controllers/SessionsController.js';

/**
 * "Where am I logged in", and ending any of those sessions.
 *
 * The two properties that matter here are that the API never hands out a
 * usable session id, and that a user can only ever revoke their own sessions.
 */
describe('SessionsController', function () {
  this.timeout(15000);

  let controller: SessionsController;
  let listStub: sinon.SinonStub;
  let deleteStub: sinon.SinonStub;

  const body = async <T = any>(r: any): Promise<T> => await r.responseData;

  const user = { Id: 7, Uuid: 'user-uuid' } as any;

  const makeSession = (id: string, minutesAgo: number): ISession => ({
    SessionId: id,
    UserId: 7,
    Creation: DateTime.now().minus({ minutes: minutesAgo }),
    Expiration: DateTime.now().plus({ minutes: 30 }),
    Data: new Map<string, unknown>(),
  });

  beforeEach(() => {
    controller = new SessionsController();

    listStub = sinon.stub().resolves([makeSession('sid-current', 5), makeSession('sid-other', 60)]);
    deleteStub = sinon.stub().resolves();

    Object.defineProperty(controller, 'SessionProvider', {
      value: { listByUser: listStub, delete: deleteStub },
      configurable: true,
      writable: true,
    });

    Object.defineProperty(controller, 'Log', {
      value: { info: sinon.stub(), warn: sinon.stub() },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => sinon.restore());

  describe('list', () => {
    it('never returns a session id — only its opaque handle', async () => {
      const entries = await body<any[]>(await controller.list(user, 'sid-current'));

      const serialized = JSON.stringify(entries);
      expect(serialized, 'a listing that leaks ids is a listing of live credentials').to.not.contain('sid-current');
      expect(serialized).to.not.contain('sid-other');

      expect(entries.map((e) => e.Handle)).to.have.members([hashSessionId('sid-current'), hashSessionId('sid-other')]);
    });

    it('flags the session making the request', async () => {
      const entries = await body<any[]>(await controller.list(user, 'sid-current'));

      const current = entries.find((e) => e.Handle === hashSessionId('sid-current'));
      const other = entries.find((e) => e.Handle === hashSessionId('sid-other'));

      expect(current.Current).to.eq(true);
      expect(other.Current).to.eq(false);
    });

    it('lists newest first and reports creation / expiry', async () => {
      const entries = await body<any[]>(await controller.list(user, 'sid-current'));

      expect(entries[0].Handle).to.equal(hashSessionId('sid-current'));
      expect(entries[0].Created).to.be.a('string');
      expect(entries[0].Expires).to.be.a('string');
    });

    it('only ever looks at the calling user own sessions', async () => {
      await controller.list(user, 'sid-current');

      sinon.assert.calledWith(listStub, 7);
    });
  });

  describe('revoke', () => {
    it('ends the session behind a handle', async () => {
      const result = await controller.revoke(user, hashSessionId('sid-other'));

      expect(result).to.be.instanceOf(Ok);
      sinon.assert.calledWith(deleteStub, 'sid-other');
    });

    it('404s on a handle that is not one of the user own sessions', async () => {
      // the handle of somebody else's session resolves to nothing here, so the
      // route cannot be used to end a stranger's session even if it leaks
      const result = await controller.revoke(user, hashSessionId('somebody-elses-session'));

      expect(result).to.be.instanceOf(NotFound);
      sinon.assert.notCalled(deleteStub);
    });
  });

  describe('revokeOthers', () => {
    it('ends every session except the current one', async () => {
      const result = await controller.revokeOthers(user, 'sid-current');

      sinon.assert.calledOnce(deleteStub);
      sinon.assert.calledWith(deleteStub, 'sid-other');
      expect((await body<any>(result)).Revoked).to.equal(1);
    });

    it('ends all of them when the caller presents no session id', async () => {
      await controller.revokeOthers(user, '');

      expect(deleteStub.callCount).to.equal(2);
    });
  });
});
