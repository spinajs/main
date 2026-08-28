// Pure unit test: the controller is constructed directly, so it does not touch
// the process-wide DI container that sibling suites contaminate.
import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { BadRequestResponse, Ok } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';
import { InvalidCredentials, TokenExpired, TokenInvalid } from '@spinajs/rbac';

import { PasswordResetController } from '../src/controllers/PasswordResetController.js';
import { PasswordResetConfirmDto, PasswordResetRequestDto } from '../src/dto/password-reset-dto.js';

/**
 * The reset endpoints are public, so the property that matters most is that
 * they say nothing about the account: a known and an unknown address must be
 * indistinguishable, and a rejected redemption must not reveal why.
 */
describe('PasswordResetController', function () {
  this.timeout(15000);

  let controller: PasswordResetController;
  let issueStub: sinon.SinonStub;
  let redeemStub: sinon.SinonStub;

  const body = async <T = any>(r: any): Promise<T> => await r.responseData;

  beforeEach(() => {
    controller = new PasswordResetController();

    // BaseController's logger is injected; a plain sink keeps the unit test
    // free of the logging stack.
    Object.defineProperty(controller, '_log', {
      value: { warn: sinon.stub(), error: sinon.stub(), trace: sinon.stub(), info: sinon.stub() },
      configurable: true,
      writable: true,
    });

    issueStub = sinon.stub(controller as any, 'issueToken').resolves();
    redeemStub = sinon.stub(controller as any, 'redeemToken').resolves();
  });

  afterEach(() => sinon.restore());

  describe('requestReset', () => {
    it('issues a token for a known address', async () => {
      const result = await controller.requestReset(new PasswordResetRequestDto({ Email: 'me@spinajs.pl' }));

      expect(result).to.be.instanceOf(Ok);
      expect(await body(result)).to.deep.equal({ Ok: true });
      sinon.assert.calledWith(issueStub, 'me@spinajs.pl');
    });

    it('answers an unknown address exactly as it answers a known one', async () => {
      const known = await body(await controller.requestReset(new PasswordResetRequestDto({ Email: 'me@spinajs.pl' })));

      issueStub.rejects(new InvalidCredentials('user not found'));
      const unknown = await controller.requestReset(new PasswordResetRequestDto({ Email: 'ghost@spinajs.pl' }));

      // identical status and body — the route must not be an enumeration oracle
      expect(unknown).to.be.instanceOf(Ok);
      expect(await body(unknown)).to.deep.equal(known);
    });

    it('does not surface infrastructure failures to the caller either', async () => {
      issueStub.rejects(new Error('mail queue down'));

      const result = await controller.requestReset(new PasswordResetRequestDto({ Email: 'me@spinajs.pl' }));

      expect(result).to.be.instanceOf(Ok);
    });
  });

  describe('confirmReset', () => {
    const payload = (over: Partial<PasswordResetConfirmDto> = {}) =>
      new PasswordResetConfirmDto({
        Email: 'me@spinajs.pl',
        Token: 'tok-123',
        Password: 'brandnew1',
        ConfirmPassword: 'brandnew1',
        ...over,
      });

    it('redeems the token and sets the new password', async () => {
      const result = await controller.confirmReset(payload());

      expect(result).to.be.instanceOf(Ok);
      sinon.assert.calledWith(redeemStub, 'me@spinajs.pl', 'brandnew1', 'tok-123');
    });

    it('rejects a mismatched confirmation before touching the token', async () => {
      await expect(controller.confirmReset(payload({ ConfirmPassword: 'different1' }))).to.be.rejectedWith(InvalidArgument);
      sinon.assert.notCalled(redeemStub);
    });

    it('returns one opaque error for an expired token', async () => {
      redeemStub.rejects(new TokenExpired('Password change token expired'));

      const result = await controller.confirmReset(payload());

      expect(result).to.be.instanceOf(BadRequestResponse);
      expect((await body<any>(result)).error.code).to.equal('E_RESET_TOKEN_INVALID');
    });

    it('returns the same opaque error for a wrong token and an unknown account', async () => {
      redeemStub.rejects(new TokenInvalid('token invalid'));
      const wrongToken = await body<any>(await controller.confirmReset(payload()));

      redeemStub.rejects(new InvalidCredentials('user not found'));
      const unknownUser = await body<any>(await controller.confirmReset(payload({ Email: 'ghost@spinajs.pl' })));

      // a caller must not be able to tell these two apart
      expect(wrongToken).to.deep.equal(unknownUser);
    });

    it('rethrows unexpected failures instead of masking them as a bad token', async () => {
      redeemStub.rejects(new Error('database is down'));

      await expect(controller.confirmReset(payload())).to.be.rejectedWith('database is down');
    });
  });
});
