import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { fileURLToPath } from 'node:url';
import { DI } from '../src/index.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('DI.__spinajs_require__', () => {
  afterEach(() => {
    DI.clearCache();
    DI.clearRegistry();
  });

  it('imports an ESM file by path without setESMModuleSupport() and unwraps the default export', async () => {
    const loaded = (await DI.__spinajs_require__(fixture('esm-module.mjs'))) as { loaded: string };
    expect(loaded.loaded).to.equal('default');
  });

  it('returns the namespace when there is no default export', async () => {
    const loaded = (await DI.__spinajs_require__(fixture('no-default.mjs'))) as { only: string };
    expect(loaded.only).to.equal('named');
  });

  it('accepts a file:// URL as before', async () => {
    const loaded = (await DI.__spinajs_require__(new URL('./fixtures/esm-module.mjs', import.meta.url).href)) as { loaded: string };
    expect(loaded.loaded).to.equal('default');
  });

  it('prefers a registered __module_loader__', async () => {
    DI.register({ load: async (m: string) => ({ from: 'loader', m }) }).asValue('__module_loader__');
    expect(await DI.__spinajs_require__('anything')).to.deep.equal({ from: 'loader', m: 'anything' });
  });

  it('setESMModuleSupport registers the legacy __esmMode__ value', () => {
    DI.setESMModuleSupport();
    expect(DI.get<{ mjs: boolean }>('__esmMode__')).to.deep.equal({ mjs: true });
  });

  it('setESMModuleSupport emits a single deprecation warning', async () => {
    // fresh module instance, so the once-per-process flag is not consumed by other tests
    const fresh = (await import(`../src/root.js?fresh=${Date.now()}`)) as typeof import('../src/root.js');
    const emitWarning = sinon.stub(process, 'emitWarning');
    try {
      fresh.setESMModuleSupport();
      fresh.setESMModuleSupport();
    } finally {
      emitWarning.restore();
    }
    expect(emitWarning.callCount).to.equal(1);
    expect(emitWarning.firstCall.args[1]).to.deep.include({ type: 'DeprecationWarning', code: 'SPINAJS_ESM_MODE' });
  });
});
