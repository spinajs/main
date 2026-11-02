import 'mocha';
import { expect } from 'chai';
import { lazyImport } from '../src/lazy-import.js';

describe('lazyImport', () => {
  it('shares one load and retries after a rejection', async () => {
    let calls = 0;
    const load = lazyImport(() => (++calls === 1 ? Promise.reject(new Error('EMFILE')) : Promise.resolve('ok')));

    const first = load();
    expect(load()).to.equal(first);
    let message = '';
    await first.catch((err: Error) => (message = err.message));
    expect(message).to.equal('EMFILE');

    expect(await load()).to.equal('ok');
    expect(await load()).to.equal('ok');
    expect(calls).to.equal(2);
  });
});
