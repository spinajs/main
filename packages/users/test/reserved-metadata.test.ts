import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';

import { USER_RESERVED_METADATA_PREFIXES, USER_SECURITY_METADATA_KEYS, isReservedMetadataKey } from '../src/models/User.js';
import { assertNoProtectedMetadata } from '../src/actions.js';

describe('reserved metadata keys', () => {
  it('reserves exactly the seven prefixes the A12 kit embeds', () => {
    expect([...USER_RESERVED_METADATA_PREFIXES]).to.have.members(['2fa:', 'user:2fa:', 'user:pwd_reset:', 'user:pwd:', 'user:login:', 'user:ban:', 'user:invite:']);
    expect(USER_RESERVED_METADATA_PREFIXES).to.have.lengthOf(7);
    expect(Object.isFrozen(USER_RESERVED_METADATA_PREFIXES)).to.eq(true);
  });

  const samples = ['2fa:token', '2fa:enabled', '2fa:otp', 'user:2fa:token', 'user:pwd_reset:token', 'user:pwd_reset:start_date', 'user:pwd:reset', 'user:login:attempts', 'user:login:locked_until', 'user:ban:is_banned', 'user:ban:reason', 'user:invite:pending'];

  for (const key of samples) {
    it(`reserves ${key}`, () => {
      expect(isReservedMetadataKey(key)).to.eq(true);
    });
  }

  for (const key of ['2FA:enabled', 'User:Pwd_Reset:token', '２fa:token', ' 2fa:token', 'USER:BAN:IS_BANNED', '2fá:enabled', '2​fa:token', 'uſer:ban:is_banned', 'üser:login:attempts']) {
    it(`reserves the variant ${JSON.stringify(key)} a collation may match`, () => {
      expect(isReservedMetadataKey(key)).to.eq(true);
    });
  }

  for (const key of ['user:avatar', 'user:phone', 'user:niceName', 'user:newsletter:enabled', '2factor', 'user:pwdhint', 'admin:note', 'user:2fa']) {
    it(`leaves ${key} plain`, () => {
      expect(isReservedMetadataKey(key)).to.eq(false);
    });
  }

  it('reserves every exact key the dehydrate filter hides', () => {
    for (const key of USER_SECURITY_METADATA_KEYS) {
      expect(isReservedMetadataKey(key), key).to.eq(true);
    }
  });

  describe('assertNoProtectedMetadata', () => {
    it('SR-02 guard refuses the real 2fa keys', () => {
      expect(() => assertNoProtectedMetadata({ '2fa:enabled': false })).to.throw(InvalidArgument);
      expect(() => assertNoProtectedMetadata({ '2fa:token': 'JBSWY3DPEHPK3PXP' })).to.throw(InvalidArgument);
      expect(() => assertNoProtectedMetadata({ '2fa:otp': '123456' })).to.throw(InvalidArgument);
    });

    it('refuses a key under any reserved prefix, in any case', () => {
      expect(() => assertNoProtectedMetadata({ 'user:login:attempts': 0 })).to.throw(InvalidArgument);
      expect(() => assertNoProtectedMetadata({ 'User:Invite:Pending': true })).to.throw(InvalidArgument);
    });

    it('refuses the bag when one key of several is reserved', () => {
      expect(() => assertNoProtectedMetadata({ 'user:phone': '1', 'user:pwd_reset:token': 'x' })).to.throw(InvalidArgument);
    });

    it('still refuses globs', () => {
      expect(() => assertNoProtectedMetadata({ '*': 'x' })).to.throw(InvalidArgument);
      expect(() => assertNoProtectedMetadata({ 'user:?fa:token': 'x' })).to.throw(InvalidArgument);
    });

    it('passes plain keys and empty input', () => {
      expect(() => assertNoProtectedMetadata(undefined)).to.not.throw();
      expect(() => assertNoProtectedMetadata({})).to.not.throw();
      expect(() => assertNoProtectedMetadata({ 'user:avatar': 'a.png', 'user:phone': '1' })).to.not.throw();
    });
  });
});
