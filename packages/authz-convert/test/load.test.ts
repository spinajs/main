import { expect } from 'chai';
import { join } from 'node:path';

import { ConversionError, loadLayers, mergeLayers } from '../src/index.js';

const fixture = (...p: string[]) => join(process.cwd(), 'test', 'fixtures', ...p);

async function refusal(dirs: string[]): Promise<ConversionError> {
  try {
    await loadLayers(dirs);
  } catch (err) {
    expect(err).to.be.instanceOf(ConversionError);
    return err as ConversionError;
  }
  throw new Error('expected a refusal');
}

describe('loadLayers', () => {
  it('merges the common files of every dir, js and json, nested dirs included', async () => {
    const layers = await loadLayers([fixture('load', 'a'), fixture('load', 'b')]);
    expect(layers.common.rbac).to.deep.include({ defaultRole: 'user', systemRole: 'system', roleColumn: 'Roles' });
    expect((layers.common.rbac as any).grants.user.$extend).to.have.members(['base', 'extra']);
  });

  it('keeps each env file in its own layer, named by the env suffix', async () => {
    const layers = await loadLayers([fixture('load', 'a'), fixture('load', 'b')]);
    expect([...layers.envs.keys()]).to.deep.equal(['local', 'prod']);
    expect(layers.envs.get('local')).to.deep.equal({ rbac: { twoFactorAuth: { enabled: false } } });
    expect(layers.envs.get('prod')).to.deep.equal({ http: { cors: { origins: [] } } });
    expect(layers.common.rbac).to.not.have.property('twoFactorAuth');
  });

  it('merges a view the way the configuration loader does: arrays concatenate, scalars override', async () => {
    const merged = mergeLayers({ a: [1], b: { c: 1, d: 2 } }, { a: [2], b: { c: 3 } });
    expect(merged).to.deep.equal({ a: [1, 2], b: { c: 3, d: 2 } });
  });

  it('does not change the layers it merges', () => {
    const common = { a: [1] };
    mergeLayers(common, { a: [2] });
    expect(common).to.deep.equal({ a: [1] });
  });

  it('refuses a dir of TypeScript sources and names the compiled dir to use', async () => {
    const err = await refusal([fixture('ts-only')]);
    expect(err.problems[0]).to.match(/TypeScript sources only.*compiled config dir/);
  });

  it('refuses a missing dir', async () => {
    const err = await refusal([fixture('nope')]);
    expect(err.problems[0]).to.match(/does not exist/);
  });

  it('refuses a file that fails to load instead of skipping it', async () => {
    const err = await refusal([fixture('broken')]);
    expect(err.problems[0]).to.match(/cannot load config file .*rbac\.js/);
  });

  it('refuses when no dir is given', async () => {
    const err = await refusal([]);
    expect(err.problems[0]).to.match(/no config dir/);
  });
});
