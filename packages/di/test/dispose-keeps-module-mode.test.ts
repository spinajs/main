import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'url';

import { DI } from '../src/index.js';

const esmModule = fileURLToPath(new URL('./fixtures/esm-module.ts', import.meta.url));

describe('ESM module mode across a dispose', () => {
  afterEach(() => {
    DI.uncache('__esmMode__');
    DI.clear();
  });

  it('dispose keeps the mode, so a second boot still loads modules with import()', async () => {
    DI.setESMModuleSupport();

    await DI.dispose();

    expect(DI.get('__esmMode__')).to.deep.equal({ mjs: true });
    expect(await DI.__spinajs_require__(esmModule)).to.equal('loaded with import()');
  });

  it('clearing the cache keeps the mode', () => {
    DI.setESMModuleSupport();

    DI.clearCache();

    expect(DI.get('__esmMode__')).to.deep.equal({ mjs: true });
  });

  it('setting the mode emits di.registered.__esmMode__ once per call, like any value', () => {
    const seen: unknown[] = [];
    const listener = (value: unknown) => seen.push(value);
    DI.on('di.registered.__esmMode__', listener);

    try {
      DI.setESMModuleSupport();
      DI.setESMModuleSupport();
    } finally {
      DI.off('di.registered.__esmMode__', listener);
    }

    expect(seen).to.deep.equal([{ mjs: true }, { mjs: true }]);
  });

  it('uncache turns the mode off for good', () => {
    DI.setESMModuleSupport();

    DI.uncache('__esmMode__');
    DI.clearCache();

    expect(DI.get('__esmMode__')).to.not.exist;
  });
});
