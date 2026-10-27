import 'mocha';
import { expect } from 'chai';
import { Config } from '@spinajs/configuration';
import { configurationViolations, createTestApp, disposeTestApps, fakeContainer, readingFrom, setPastSchema } from '../src/index.js';

const SCHEMA = { $id: 'spec/z', $configurationModule: 'z', type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false };

class Reader {
  @Config('z.n')
  public n: number;
}

describe('configuration helpers', () => {
  afterEach(disposeTestApps);

  it('configurationViolations lists violation paths and [] on success', async () => {
    expect(await configurationViolations({ schemas: [SCHEMA], config: { z: { n: 1 } } })).to.deep.equal([]);
    expect(await configurationViolations({ schemas: [SCHEMA], config: { z: { n: 'x' } } })).to.deep.equal(['z.n']);
  });

  it('readingFrom binds @Config of a new-ed instance to an app container', async () => {
    const app = await createTestApp({ scope: 'child', bootstrap: false, schemas: [SCHEMA], config: { z: { n: 7 } } });
    expect(readingFrom(new Reader(), app.container).n).to.equal(7);
    await app.dispose();
  });

  it('fakeContainer answers full paths without validation', () => {
    expect(readingFrom(new Reader(), fakeContainer({ 'z.n': 3 })).n).to.equal(3);
  });

  it('setPastSchema writes without the schema check', async () => {
    const app = await createTestApp({ scope: 'child', bootstrap: false, schemas: [SCHEMA], config: { z: { n: 1 } } });
    setPastSchema(app.config, 'z.n', 'not-a-number');
    expect(app.config.get('z.n')).to.equal('not-a-number');
    await app.dispose();
  });
});
