import 'mocha';
import { expect } from 'chai';

import '@spinajs/log';
import { InternalLoggerProxy } from '@spinajs/internal-logger';
import { resolveCliLog } from '../src/cliLog.js';

describe('resolveCliLog', () => {
  it('falls back to InternalLoggerProxy when no Log implementation is registered', () => {
    const log = resolveCliLog(() => false);

    expect(log).to.be.instanceOf(InternalLoggerProxy);
    expect(() => log.success('welcome')).to.not.throw();
    expect(() => log.error('boom')).to.not.throw();
  });

  it('resolves the registered logger when an implementation is available', () => {
    // @spinajs/log is imported above, which registers the Log factory in DI
    const log = resolveCliLog();

    expect(log.success).to.be.a('function');
    expect(log.error).to.be.a('function');
  });
});
