import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { fs, FILE_PROVIDER_INSTANCES, publishedFs } from '../src/index.js';

describe('publishedFs', () => {
  it('uses the key fsService publishes providers under', () => {
    expect(FILE_PROVIDER_INSTANCES).to.equal('__file_provider_instance__');
  });

  it('returns the provider published under the name in the given container', () => {
    const child = DI.child();
    const provider = { Name: 'pub-a' } as unknown as fs;
    child.register(provider).asMapValue(FILE_PROVIDER_INSTANCES, 'pub-a');

    expect(publishedFs('pub-a', child)).to.equal(provider);
    expect(publishedFs('pub-missing', child)).to.be.undefined;
  });

  it('returns undefined when nothing is published in the container', () => {
    expect(publishedFs('pub-a', DI.child())).to.be.undefined;
  });

  it('defaults to the root container', () => {
    const hadMap = DI.RootContainer.Cache.has(FILE_PROVIDER_INSTANCES);
    const provider = { Name: 'pub-root' } as unknown as fs;
    DI.register(provider).asMapValue(FILE_PROVIDER_INSTANCES, 'pub-root');

    try {
      expect(publishedFs('pub-root')).to.equal(provider);
    } finally {
      DI.get<Map<string, fs>>(FILE_PROVIDER_INSTANCES)!.delete('pub-root');
      if (!hadMap) DI.uncache(FILE_PROVIDER_INSTANCES);
    }
  });
});
