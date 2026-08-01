import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, Injectable } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { _cfg, _service } from '../src/fp.js';

chai.use(chaiAsPromised);

class TestConfiguration extends FrameworkConfiguration {}

class FpTestServiceBase {
  public foo() {
    return 'base';
  }
}

@Injectable(FpTestServiceBase)
export class FpTestServiceImpl extends FpTestServiceBase {
  public foo() {
    return 'impl';
  }
}

describe('configuration fp', () => {
  let cfg: Configuration;

  before(() => {
    DI.register(TestConfiguration).as(Configuration);
  });

  beforeEach(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    cfg = await DI.resolve(Configuration);
  });

  describe('_cfg', () => {
    it('returns configured value', async () => {
      cfg.set('fp.test.value', 42);
      expect(await _cfg('fp.test.value')()).to.eq(42);
    });

    it('returns default when path missing', async () => {
      expect(await _cfg('fp.test.missing', 'def')()).to.eq('def');
    });

    it('throws on null / undefined value without default', async () => {
      expect(() => _cfg('fp.test.missing')()).to.throw();
    });

    it('allows empty array and empty object values', async () => {
      cfg.set('fp.test.emptyArr', []);
      cfg.set('fp.test.emptyObj', {});

      expect(await _cfg('fp.test.emptyArr')()).to.deep.eq([]);
      expect(await _cfg('fp.test.emptyObj')()).to.deep.eq({});
    });

    it('allows falsy primitive values', async () => {
      cfg.set('fp.test.zero', 0);
      cfg.set('fp.test.false', false);
      cfg.set('fp.test.emptyStr', '');

      expect(await _cfg('fp.test.zero')()).to.eq(0);
      expect(await _cfg('fp.test.false')()).to.eq(false);
      expect(await _cfg('fp.test.emptyStr')()).to.eq('');
    });
  });

  describe('_service', () => {
    it('resolves service registered under configured name', async () => {
      cfg.set('fp.service.good', { service: 'FpTestServiceImpl' });

      const s = await _service('fp.service.good', FpTestServiceBase)();
      expect(s).to.be.instanceOf(FpTestServiceImpl);
      expect(s.foo()).to.eq('impl');
    });

    it('names the missing service in the error when not registered', async () => {
      cfg.set('fp.service.bad', { service: 'NoSuchService' });

      await expect(_service('fp.service.bad', FpTestServiceBase)()).to.be.rejectedWith(/NoSuchService/);
    });

    it('rejects with configuration path when config entry missing', async () => {
      await expect(_service('fp.service.missing', FpTestServiceBase)()).to.be.rejectedWith(/fp\.service\.missing/);
    });
  });
});
