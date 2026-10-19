import 'mocha';
import { expect } from 'chai';

import { checkConfigurationValue } from '../src/configuration.js';
import { InvalidConfiguration } from '../src/exception.js';

const RETRY = {
  $configurationModule: 'mailer.retry',
  type: 'object',
  properties: {
    count: { type: 'integer', minimum: 0, default: 3 },
    delayMs: { type: 'integer', minimum: 1 },
  },
};

describe('checkConfigurationValue', () => {
  it('returns a copy with the schema defaults and coercion, leaving the value alone', () => {
    const value = { delayMs: '250' };
    const checked = checkConfigurationValue(RETRY, value);
    expect(checked).to.deep.eq({ count: 3, delayMs: 250 });
    expect(value).to.deep.eq({ delayMs: '250' });
  });

  it('throws InvalidConfiguration naming each bad path under the schema module', () => {
    let error: unknown;
    try {
      checkConfigurationValue(RETRY, { count: -1, delayMs: Number.NaN });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidConfiguration);
    expect((error as InvalidConfiguration).violations.map((v) => v.path)).to.have.members(['mailer.retry.count', 'mailer.retry.delayMs']);
    expect((error as InvalidConfiguration).message).to.contain('mailer.retry.count must be >= 0');
  });
});
