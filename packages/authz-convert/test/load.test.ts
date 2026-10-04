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
    expect(err.problems[0]).to.match(/TypeScript sources .*compiled config dir/);
  });

  it('refuses a dir that holds TypeScript sources next to other config files', async () => {
    const err = await refusal([fixture('mixed')]);
    expect(err.problems[0]).to.match(/TypeScript sources \(rbac\.ts\)/);
  });

  it('skips files the configuration loader never reads and says so', async () => {
    const layers = await loadLayers([fixture('skip')]);
    expect([...layers.envs.keys()]).to.deep.equal([]);
    expect(layers.common).to.deep.equal({ rbac: { defaultRole: 'user' } });
    expect(layers.skipped).to.have.length(2);
    expect(layers.skipped.join('\n')).to.match(/rbac\.production\.js: the loader reads env 'production' as 'prod'/);
  });

  it('builds the view of an env in the loader order: JS files, then JSON files', async () => {
    const layers = await loadLayers([fixture('load', 'a'), fixture('load', 'b')]);
    const prod = layers.view('prod');
    expect(prod.http).to.deep.equal({ cors: { origins: ['https://a.example'] } });
    expect((prod.rbac as any).systemRole).to.equal('system');
    expect(layers.view(null)).to.deep.equal(layers.common);
  });

  it('refuses a key an env JS file and a common JSON file both set, where the loader lets the JSON win', async () => {
    const err = await refusal([fixture('clash')]);
    expect(err.problems[0]).to.match(/env 'local' JS files and common JSON files both set rbac\.systemRole/);
  });

  it('refuses a scalar in a common JSON file under an object of an env JS file', async () => {
    const err = await refusal([fixture('clash-prefix')]);
    expect(err.problems[0]).to.match(/both set rbac\.session\.service/);
  });

  it('finds the values a file computes from NODE_ENV, and the files that read process.env', async () => {
    const before = { NODE_ENV: process.env.NODE_ENV, APP_ENV: process.env.APP_ENV };
    const layers = await loadLayers([fixture('computed')]);
    expect(layers.computed.get('common')).to.deep.equal(['rbac.session.cookie.secure']);
    expect(layers.envReaders).to.deep.equal([]);
    expect(layers.probeErrors).to.deep.equal([]);
    expect({ NODE_ENV: process.env.NODE_ENV, APP_ENV: process.env.APP_ENV }).to.deep.equal(before);
  });

  it('finds a value computed in a module the config file imports', async () => {
    const layers = await loadLayers([fixture('probe-helper', 'config')]);
    expect(layers.computed.get('common')).to.deep.equal(['rbac.session.cookie.secure']);
    expect(layers.envReaders).to.deep.equal([]);
  });

  it('names the other variables a config file reads through what it imports', async () => {
    const layers = await loadLayers([fixture('probe-vars', 'config')]);
    expect(layers.envReaders).to.deep.equal([{ file: 'test/fixtures/probe-vars/config/rbac.js', layer: 'common', vars: ['COOKIE_SECURE_FOR_TEST'] }]);
  });

  it('runs the second time in the environment from before the first run, which a dotenv helper may have filled', async () => {
    try {
      const layers = await loadLayers([fixture('probe-dotenv', 'config')]);
      expect(layers.computed.get('common')).to.deep.equal(['rbac.session.cookie.secure']);
    } finally {
      delete process.env.SECURE_FLAG_FOR_TEST;
    }
  });

  it('reads the second run whatever the config files print', async () => {
    const layers = await loadLayers([fixture('probe-noisy')]);
    expect(layers.probeErrors).to.deep.equal([]);
  });

  it('reports a second run that fails, instead of refusing the conversion', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    let layers: Awaited<ReturnType<typeof loadLayers>>;
    try {
      layers = await loadLayers([fixture('probe-fail')]);
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
    expect(layers.common).to.deep.equal({ rbac: { defaultRole: 'user' } });
    expect(layers.computed.size).to.equal(0);
    expect(layers.probeErrors.join('\n')).to.match(/NODE_ENV=production: APP_SECRET_FOR_TEST is not set/);
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
