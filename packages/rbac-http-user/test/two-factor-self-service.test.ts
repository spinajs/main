// Pure unit test: the controller is constructed directly and its injected
// fields are set by hand, so it does not touch the process-wide DI container
// that sibling suites contaminate.
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Ok, Unauthorized } from '@spinajs/http';
import { InvalidOperation } from '@spinajs/exceptions';

import { TwoFactorAuthUserController } from '../src/controllers/TwoFactorAuthUserController.js';
import { ConfirmPasswordDto } from '../src/dto/confirm-password-dto.js';
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
  let unenrolStub: sinon.SinonStub;

  const body = async <T = any>(r: any): Promise<T> => await r.responseData;

  const user = (twoFaEnabled: boolean) =>
    ({
      Uuid: 'user-uuid',
      Password: 'hashed-current',
      Metadata: { [TWO_FA_METATADATA_KEYS.ENABLED]: twoFaEnabled || undefined },
    } as any);

  beforeEach(() => {
    controller = new TwoFactorAuthUserController();

    verifyStub = sinon.stub().resolves(true);
    Object.defineProperty(controller, 'PasswordProvider', {
      value: { verify: verifyStub },
      configurable: true,
      writable: true,
    });

    enrolStub = sinon.stub(controller as any, 'enrol').resolves('otpauth://totp/Spinajs:me?secret=ABC');
    unenrolStub = sinon.stub(controller as any, 'unenrol').resolves();
  });

  afterEach(() => sinon.restore());

  describe('status', () => {
    it('reports enrolled', async () => {
      expect(await body(await controller.status(user(true)))).to.deep.equal({ Enabled: true });
    });

    it('reports not enrolled', async () => {
      expect(await body(await controller.status(user(false)))).to.deep.equal({ Enabled: false });
    });
  });

  describe('enable', () => {
    it('returns the provisioning URI once the password is confirmed', async () => {
      const result = await controller.enable(user(false), new ConfirmPasswordDto({ Password: 'current123' }));

      expect(result).to.be.instanceOf(Ok);
      expect((await body<any>(result)).otp).to.match(/^otpauth:\/\//);

      sinon.assert.calledOnce(enrolStub);
      sinon.assert.calledWith(verifyStub, 'hashed-current', 'current123');
    });

    it('refuses without a valid password and does not enrol', async () => {
      verifyStub.resolves(false);

      const result = await controller.enable(user(false), new ConfirmPasswordDto({ Password: 'wrong' }));

      expect(result).to.be.instanceOf(Unauthorized);
      expect((await body<any>(result)).error.code).to.equal('E_PASSWORD_INVALID');
      sinon.assert.notCalled(enrolStub);
    });

    it('rejects when 2FA is already enabled', async () => {
      await expect(controller.enable(user(true), new ConfirmPasswordDto({ Password: 'current123' }))).to.be.rejectedWith(InvalidOperation);
      sinon.assert.notCalled(enrolStub);
    });
  });

  describe('disable', () => {
    it('unenrols once the password is confirmed', async () => {
      const result = await controller.disable(user(true), new ConfirmPasswordDto({ Password: 'current123' }));

      expect(result).to.be.instanceOf(Ok);
      sinon.assert.calledOnce(unenrolStub);
    });

    it('refuses without a valid password and leaves 2FA in place', async () => {
      verifyStub.resolves(false);

      const result = await controller.disable(user(true), new ConfirmPasswordDto({ Password: 'wrong' }));

      expect(result).to.be.instanceOf(Unauthorized);
      expect((await body<any>(result)).error.code).to.equal('E_PASSWORD_INVALID');
      // a hijacked session must not be able to strip the second factor
      sinon.assert.notCalled(unenrolStub);
    });

    it('rejects when 2FA is not enabled', async () => {
      await expect(controller.disable(user(false), new ConfirmPasswordDto({ Password: 'current123' }))).to.be.rejectedWith(InvalidOperation);
      sinon.assert.notCalled(unenrolStub);
    });
  });
});
