import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { BaseController } from '../src/index.js';

class MinimalTestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

/**
 * Validates the DI contract that the Controllers loader depends on after the
 * @ListFromFiles refactor:
 *
 *  1. Any class registered as `BaseController` (e.g. by a package's
 *     Bootstrapper) shows up in `DI.resolve(Array.ofType(BaseController))`.
 *  2. Registering the same class twice yields one instance (singleton
 *     dedupe).
 *
 * The Controllers service no longer per-resolves file-scanned classes — it
 * just registers their types as BaseController and lets DI's Array.ofType
 * give back one instance per unique type. These tests verify that mechanism
 * works as relied upon.
 */

class ControllerA extends BaseController {
  public async resolve() {
    // Skip BaseController.resolve() — it requires HttpServer/Configuration
    // wiring that this isolated test doesn't set up.
  }
}

class ControllerB extends BaseController {
  public async resolve() { /* see above */ }
}

describe('Conditional controller registration (Array.ofType<BaseController>)', () => {
  before(() => {
    DI.register(MinimalTestConfiguration).as(Configuration);
  });

  beforeEach(async () => {
    await DI.resolve(Configuration);
  });

  afterEach(() => {
    // Each test starts with a clean cache; registrations persist across tests
    // intentionally so we can also assert dedupe across re-registers.
    DI.clearCache();
  });

  it('a class registered as BaseController is resolved via Array.ofType', async () => {
    DI.register(ControllerA).as(BaseController);

    const all = (await DI.resolve(Array.ofType(BaseController))) as BaseController[];
    const names = all.map(c => c.constructor.name);

    expect(names).to.include('ControllerA');
  });

  it('registering the same class twice yields one instance per type', async () => {
    DI.register(ControllerA).as(BaseController);
    DI.register(ControllerA).as(BaseController); // duplicate, intentional

    const all = (await DI.resolve(Array.ofType(BaseController))) as BaseController[];
    const occurrences = all.filter(c => c.constructor.name === 'ControllerA');

    // Allow either "exactly one entry" (deduped on register) or "two entries
    // pointing at the same singleton instance" (deduped on resolve). Both are
    // acceptable for the Controllers loader since register(ci) is idempotent
    // by class identity at the route-attach level.
    if (occurrences.length === 1) {
      expect(occurrences).to.have.lengthOf(1);
    } else {
      expect(occurrences).to.have.lengthOf(2);
      expect(occurrences[0]).to.equal(occurrences[1]);
    }
  });

  it('multiple distinct controllers all appear in the resolved array', async () => {
    DI.register(ControllerA).as(BaseController);
    DI.register(ControllerB).as(BaseController);

    const all = (await DI.resolve(Array.ofType(BaseController))) as BaseController[];
    const names = all.map(c => c.constructor.name);

    expect(names).to.include('ControllerA');
    expect(names).to.include('ControllerB');
  });
});
