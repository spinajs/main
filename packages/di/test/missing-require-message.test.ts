import 'mocha';
import { expect } from 'chai';
import { fileURLToPath } from 'url';

import { DI } from '../src/index.js';

const esmModule = fileURLToPath(new URL('./fixtures/esm-module.ts', import.meta.url));

describe('loading a module without require and without ESM mode', () => {
  let esmModeBefore: unknown;

  before(() => {
    esmModeBefore = DI.get('__esmMode__');
    DI.uncache('__esmMode__');
  });

  after(() => {
    if (esmModeBefore) {
      DI.setESMModuleSupport();
    }
  });

  it('leads with the ESM flag and says when to set it, then names the module loader for bundles', async () => {
    let error: Error | undefined;
    try {
      await DI.__spinajs_require__(esmModule);
    } catch (err) {
      error = err as Error;
    }

    expect(error?.message).to.equal(
      '@spinajs/di: CommonJS `require` is not available in this environment. ' +
        'In a Node ESM application call DI.setESMModuleSupport() at the top of the entry file, before the configuration resolves. ' +
        "In a bundled or browser build register a module loader under '__module_loader__' ( DI.register(loader).asValue('__module_loader__') ).",
    );
  });
});
