import 'mocha';
import { expect } from 'chai';

import { testHost } from '../src/index.js';

describe('testHost.TestConfiguration', () => {
  it('sets, merges and unsets nested values', () => {
    const config = new testHost.TestConfiguration();
    config.set('a.b', 1);
    config.merge(['a'], { c: 2 });
    expect(config.get('a')).to.deep.equal({ b: 1, c: 2 });
    config.unset('a.b');
    expect(config.get('a')).to.deep.equal({ c: 2 });
  });

  it('refuses writes through __proto__, constructor and prototype', () => {
    const config = new testHost.TestConfiguration();
    for (const path of ['__proto__.polluted', ['a', '__proto__', 'polluted'], 'constructor.prototype.polluted']) {
      expect(() => config.set(path, true)).to.throw(/reserved segment/);
      expect(() => config.merge(path, true)).to.throw(/reserved segment/);
      expect(() => config.unset(path)).to.throw(/reserved segment/);
    }
    expect(({} as Record<string, unknown>).polluted).to.equal(undefined);
  });
});
