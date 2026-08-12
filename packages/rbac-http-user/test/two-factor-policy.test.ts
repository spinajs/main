// Pure unit test: the policy is constructed directly and its @Config field is
// set by hand, so no DI container or configuration file is involved.
import 'mocha';
import { expect } from 'chai';

import { Forbidden } from '@spinajs/exceptions';

import { TwoFactorAuthEnabled } from '../src/policies/2FaPolicy.js';

describe('TwoFactorAuthEnabled', () => {
  const policy = (enabled: boolean) => {
    const p = new TwoFactorAuthEnabled();
    Object.defineProperty(p, 'TwoFactorConfig', { value: { enabled }, configurable: true, writable: true });
    return p;
  };

  it('passes when 2fa is on system-wide', async () => {
    await policy(true).execute({} as any);
  });

  it('answers 403 with a recognisable code when 2fa is off system-wide', async () => {
    let thrown: any = null;
    try {
      await policy(false).execute({} as any);
    } catch (err) {
      thrown = err;
    }

    // InvalidOperation has no @HandleException mapping in @spinajs/http, so it
    // used to surface as a 500 and the frontend could not tell a switched-off
    // feature from a broken server.
    //
    // `Forbidden` (via `Exception` in @spinajs/exceptions) has no built-in
    // structured-payload field — its constructor only takes a message string
    // — so the policy attaches the payload as a plain `error` property on the
    // thrown instance. That is also what the HTTP error handler's
    // `{ ...err, message: err.message }` spread picks up and serializes into
    // the response body.
    expect(thrown, 'must be a 403, not a 500').to.be.instanceOf(Forbidden);
    expect(thrown.error?.code).to.equal('E_2FA_SYSTEM_DISABLED');
  });
});
