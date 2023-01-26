import { BasicPasswordProvider } from '../src/password';
import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider } from '../src/index.js';
import { expect } from 'chai';

chai.use(chaiAsPromised);

describe('Password provider tests', () => {
  before(async () => {
    DI.register(BasicPasswordProvider).as(PasswordProvider);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  it('Should hash password', async () => {
    const provider = DI.resolve(PasswordProvider);
    const hashed = await provider.hash('bbbb');
    expect(typeof hashed).to.be.eq('string');
    expect(hashed.length).to.gt(12);
  });

  it('Should verify password', async () => {
    const provider = DI.resolve(PasswordProvider);
    const ok = await provider.verify('$argon2i$v=19$m=4096,t=3,p=1$xS9IIsZik2It+PrdjFNKiA$3sEyHfIHLXObxIm8Jva5F18MNB9O+yOw4Lkh+P7+Sdk', 'bbbb');
    const notok = await provider.verify('$argon2i$v=19$m=4096,t=3,p=1$xSddasddsaqPrdjFNKiA$3sEyHfIHLXObxIm8Jva5F18MNB9O+yOw4Lkh+P7+Sdk', 'bbbb');

    expect(notok).to.be.false;
    expect(ok).to.be.true;
  });

  it('Should generate password', async () => {
    const provider = DI.resolve(PasswordProvider);
    const password = provider.generate();
    expect(typeof password).to.be.eq('string');
    expect(password.length).to.gt(1);
  });
});
