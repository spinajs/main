// Pure unit test: the controller is constructed directly and its injected
// fields are set by hand, so it does not touch the process-wide DI container
// that sibling suites contaminate.
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DateTime } from 'luxon';

import { Ok, Unauthorized } from '@spinajs/http';
import { BadRequest, Forbidden } from '@spinajs/exceptions';
import type { ISession } from '@spinajs/rbac';

import { TwoFactorAuthUserController } from '../src/controllers/TwoFactorAuthUserController.js';
import { ConfirmPasswordDto } from '../src/dto/confirm-password-dto.js';
import { TokenDto } from '../src/dto/token-dto.js';
import { TWO_FA_METATADATA_KEYS } from '../src/2fa/Default2FaToken.js';

/**
 * Self-service 2FA management.
 *
 * The behaviour under test is the one that was previously unreachable: an
 * authorized user enrolling or unenrolling their own TOTP device. The
 * login-window controller cannot serve this — its policies exclude an
 * authorized session by construction.
 */
describe('TwoFactorAuthUserController', function () {
  this.timeout(15000);

  let controller: TwoFactorAuthUserController;
  let verifyStub: sinon.SinonStub;
  let enrolStub: sinon.SinonStub;
  let confirmStub: sinon.SinonStub;
  let unenrolStub: sinon.SinonStub;
  let deleteStub: sinon.SinonStub;
  let saveStub: sinon.SinonStub;
  let session: ISession;

  const body = async <T = any>(r: any): Promise<T> => await r.responseData;
  const cookies = (r: any) => (r?.options?.Coockies ?? []) as Array<{ Name: string; Value: string }>;

  const user = (state: 'none' | 'pending' | 'enabled') =>
    ({
      Uuid: 'user-uuid',
      Password: 'hashed-current',
      Metadata: {
        [TWO_FA_METATADATA_KEYS.ENABLED]: state === 'enabled' || undefined,
        [TWO_FA_METATADATA_KEYS.TOKEN]: state === 'none' ? undefined : 'STOREDSECRET',
      },
    } as any);

  beforeEach(() => {
    controller = new TwoFactorAuthUserController();

    verifyStub = sinon.stub().resolves(true);
    Object.defineProperty(controller, 'PasswordProvider', {
      value: { verify: verifyStub },
      configurable: true,
      writable: true,
    });

    session = {
      SessionId: 'session-before',
      UserId: 7,
      Creation: DateTime.now(),
      Expiration: DateTime.now().plus({ minutes: 30 }),
      Data: new Map<string, unknown>([['User', 'user-uuid']]),
    };

    deleteStub = sinon.stub().resolves();
    saveStub = sinon.stub().resolves();
    Object.defineProperty(controller, 'SessionProvider', {
      value: { delete: deleteStub, save: saveStub },
      configurable: true,
      writable: true,
    });

    Object.defineProperty(controller, 'SessionCookies', {
      value: { issue: (s: ISession) => ({ Name: 'ssid', Value: s.SessionId, Options: {} }) },
      configurable: true,
      writable: true,
    });

    Object.defineProperty(controller, 'TwoFactorConfig', {
      value: { enabled: true },
      configurable: true,
      writable: true,
    });

    enrolStub = sinon.stub(controller as any, 'enrol').resolves('otpauth://totp/Spinajs:me?secret=ABC');
    confirmStub = sinon.stub(controller as any, 'confirmEnrolment').resolves();
    unenrolStub = sinon.stub(controller as any, 'unenrol').resolves();
  });

  afterEach(() => sinon.restore());

  describe('status', () => {
    it('reports enrolled', async () => {
      expect(await body(await controller.status(user('enabled')))).to.deep.equal({ Enabled: true, Pending: false, SystemEnabled: true });
    });

    it('reports not enrolled', async () => {
      expect(await body(await controller.status(user('none')))).to.deep.equal({ Enabled: false, Pending: false, SystemEnabled: true });
    });

    it('reports an enrolment that was started but never confirmed', async () => {
      expect(await body(await controller.status(user('pending')))).to.deep.equal({ Enabled: false, Pending: true, SystemEnabled: true });
    });
  });

  describe('enable', () => {
    it('returns the provisioning URI once the password is confirmed', async () => {
      const result = await controller.enable(user('none'), new ConfirmPasswordDto({ Password: 'current123' }), session);

      expect(result).to.be.instanceOf(Ok);
      expect((await body<any>(result)).otp).to.match(/^otpauth:\/\//);

      sinon.assert.calledOnce(enrolStub);
      sinon.assert.calledWith(verifyStub, 'hashed-current', 'current123');
    });

    it('rotates the session id and resets the cookie after enrolling', async () => {
      const result = await controller.enable(user('none'), new ConfirmPasswordDto({ Password: 'current123' }), session);

      // old id destroyed, a different one persisted in its place
      sinon.assert.calledWith(deleteStub, 'session-before');
      sinon.assert.calledOnce(saveStub);

      const issued = saveStub.firstCall.args[0] as ISession;
      expect(issued.SessionId).to.not.equal('session-before');
      expect(issued.UserId).to.equal(7);
      expect(issued.Data.get('User')).to.equal('user-uuid');

      expect(cookies(result)).to.have.lengthOf(1);
      expect(cookies(result)[0].Value).to.equal(issued.SessionId);
    });

    it('refuses without a valid password and does not enrol', async () => {
      verifyStub.resolves(false);

      const result = await controller.enable(user('none'), new ConfirmPasswordDto({ Password: 'wrong' }), session);

      expect(result).to.be.instanceOf(Unauthorized);
      expect((await body<any>(result)).error.code).to.equal('E_PASSWORD_INVALID');
      sinon.assert.notCalled(enrolStub);

      // a rejected attempt must not rotate anything
      sinon.assert.notCalled(deleteStub);
      sinon.assert.notCalled(saveStub);
    });

    it('rejects when 2FA is already enabled', async () => {
      await expect(controller.enable(user('enabled'), new ConfirmPasswordDto({ Password: 'current123' }), session)).to.be.rejectedWith(BadRequest);
      sinon.assert.notCalled(enrolStub);
    });
  });

  describe('enable, pending semantics', () => {
    it('hands out a secret for an account that started but abandoned an enrolment', async () => {
      const result = await controller.enable(user('pending'), new ConfirmPasswordDto({ Password: 'current123' }), session);

      expect(result).to.be.instanceOf(Ok);
      sinon.assert.calledOnce(enrolStub);
    });
  });

  describe('confirm', () => {
    it('confirms the enrolment and rotates the session', async () => {
      const result = await controller.confirm(user('pending'), new TokenDto({ Token: '123456' }), session);

      expect(result).to.be.instanceOf(Ok);
      sinon.assert.calledWith(confirmStub, sinon.match.any, '123456');
      sinon.assert.calledWith(deleteStub, 'session-before');
    });

    it('answers 403 on a bad code without rotating anything', async () => {
      confirmStub.rejects(new Unauthorized('2fa confirmation failed'));

      const result = await controller.confirm(user('pending'), new TokenDto({ Token: '000000' }), session);

      expect((await body<any>(result)).error.code).to.equal('E_2FA_FAILED');
      sinon.assert.notCalled(deleteStub);
    });

    it('rejects when there is no enrolment to confirm', async () => {
      await expect(controller.confirm(user('none'), new TokenDto({ Token: '123456' }), session)).to.be.rejectedWith(BadRequest);
      sinon.assert.notCalled(confirmStub);
    });

    it('rejects when the account is already enabled', async () => {
      await expect(controller.confirm(user('enabled'), new TokenDto({ Token: '123456' }), session)).to.be.rejectedWith(BadRequest);
      sinon.assert.notCalled(confirmStub);
    });
  });

  describe('disable', () => {
    it('unenrols once the password is confirmed', async () => {
      const result = await controller.disable(user('enabled'), new ConfirmPasswordDto({ Password: 'current123' }), session);

      expect(result).to.be.instanceOf(Ok);
      sinon.assert.calledOnce(unenrolStub);
    });

    it('rotates the session id and resets the cookie after unenrolling', async () => {
      const result = await controller.disable(user('enabled'), new ConfirmPasswordDto({ Password: 'current123' }), session);

      sinon.assert.calledWith(deleteStub, 'session-before');

      const issued = saveStub.firstCall.args[0] as ISession;
      expect(issued.SessionId).to.not.equal('session-before');
      expect(cookies(result)[0].Value).to.equal(issued.SessionId);
    });

    it('refuses without a valid password and leaves 2FA in place', async () => {
      verifyStub.resolves(false);

      const result = await controller.disable(user('enabled'), new ConfirmPasswordDto({ Password: 'wrong' }), session);

      expect(result).to.be.instanceOf(Unauthorized);
      expect((await body<any>(result)).error.code).to.equal('E_PASSWORD_INVALID');
      // a hijacked session must not be able to strip the second factor
      sinon.assert.notCalled(unenrolStub);
      sinon.assert.notCalled(deleteStub);
    });

    it('rejects when 2FA is not enabled', async () => {
      await expect(controller.disable(user('none'), new ConfirmPasswordDto({ Password: 'current123' }), session)).to.be.rejectedWith(BadRequest);
      sinon.assert.notCalled(unenrolStub);
    });
  });

  describe('system-wide switch', () => {
    const withSystem2Fa = (enabled: boolean) =>
      Object.defineProperty(controller, 'TwoFactorConfig', { value: { enabled }, configurable: true, writable: true });

    it('status reports the switch as on', async () => {
      expect((await body<any>(await controller.status(user('none')))).SystemEnabled).to.equal(true);
    });

    it('status still answers when the switch is off, reporting it', async () => {
      withSystem2Fa(false);

      const result = await body<any>(await controller.status(user('none')));

      // The policy cannot block an authorized caller, so the frontend reads
      // this flag rather than inferring a feature switch from an error.
      expect(result.SystemEnabled).to.equal(false);
      expect(result.Enabled).to.equal(false);
    });

    it('enable refuses while the switch is off', async () => {
      withSystem2Fa(false);

      await expect(controller.enable(user('none'), new ConfirmPasswordDto({ Password: 'current123' }), session)).to.be.rejectedWith(Forbidden);
      sinon.assert.notCalled(enrolStub);
    });

    it('disable refuses while the switch is off', async () => {
      withSystem2Fa(false);

      await expect(controller.disable(user('enabled'), new ConfirmPasswordDto({ Password: 'current123' }), session)).to.be.rejectedWith(Forbidden);
      sinon.assert.notCalled(unenrolStub);
    });

    it('confirm refuses while the switch is off', async () => {
      withSystem2Fa(false);

      await expect(controller.confirm(user('pending'), new TokenDto({ Token: '123456' }), session)).to.be.rejectedWith(Forbidden);
      sinon.assert.notCalled(confirmStub);
    });
  });
});
