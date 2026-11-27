import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { DI, IContainer } from '@spinajs/di';
import { InternalLogger } from '@spinajs/internal-logger';
import { Configuration, ConfigurationSource, ConfigVar } from '@spinajs/configuration-common';

import { configurationOf, NoSource } from './fixtures.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { declaredKeysAt, droppedKeys, keysAt, nearestKey } from '../src/dropped-keys.js';
import { InvalidConfiguration } from '../src/exception.js';
import { registerConfigurationSchema } from '../src/schemas.js';

chai.use(chaiAsPromised);

const expect = chai.expect;

const same = (value: object) => value;

describe('dropped configuration keys', () => {
  describe('droppedKeys()', () => {
    it('lists the keys the second value lacks, nested and inside arrays, by path', () => {
      const before = { a: 1, typo: 2, nested: { keep: 1, gone: { deep: 1 } }, list: [{ id: 1, x: 1 }, { id: 2 }] };
      const after = { a: 1, added: 3, nested: { keep: 1 }, list: [{ id: 1 }, { id: 2 }] };
      expect(droppedKeys(before, after, same)).to.deep.equal([['typo'], ['nested', 'gone'], ['list', '0', 'x']]);
    });

    it('lists nothing for equal values, added defaults and scalars', () => {
      expect(droppedKeys({ a: { b: [1] } }, { a: { b: [1], c: 2 } }, same)).to.deep.equal([]);
      expect(droppedKeys(5, 5, same)).to.deep.equal([]);
      expect(droppedKeys(null, null, same)).to.deep.equal([]);
    });

    it('does not walk a class instance', () => {
      class Holder {
        public value = 1;
      }
      expect(droppedKeys({ h: new Holder() }, { h: {} }, same)).to.deep.equal([]);
    });

    it('walks a proxy by the target unwrap gives', () => {
      const target = { typo: 1, kept: 2 };
      const proxy = new Proxy({}, {});
      expect(droppedKeys({ s: proxy }, { s: { kept: 2 } }, (v) => (v === proxy ? target : v))).to.deep.equal([['s', 'typo']]);
    });

    it('ends on a value that holds itself', () => {
      const before: Record<string, unknown> = { typo: 1 };
      before.self = before;
      const after: Record<string, unknown> = {};
      after.self = after;
      expect(droppedKeys(before, after, same)).to.deep.equal([['typo']]);
    });
  });

  describe('keysAt()', () => {
    it('gives the keys of the object at a path, through arrays, and none where there is no object', () => {
      const value = { a: { list: [{ id: 1, name: 'x' }] } };
      expect(keysAt(value, ['a', 'list', '0'], same)).to.deep.equal(['id', 'name']);
      expect(keysAt(value, [], same)).to.deep.equal(['a']);
      expect(keysAt(value, ['a', 'missing'], same)).to.deep.equal([]);
    });
  });

  describe('declaredKeysAt()', () => {
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object', properties: { id: {}, slug: {} } } },
        map: { type: 'object', additionalProperties: { type: 'object', properties: { depth: {} } } },
        ref: { $ref: '#/$defs/x' },
      },
    };

    it('follows properties, items and additionalProperties', () => {
      expect(declaredKeysAt(schema, [])).to.deep.equal(['list', 'map', 'ref']);
      expect(declaredKeysAt(schema, ['list', '3'])).to.deep.equal(['id', 'slug']);
      expect(declaredKeysAt(schema, ['map', 'anyName'])).to.deep.equal(['depth']);
    });

    it('gives nothing behind a $ref or an undeclared key', () => {
      expect(declaredKeysAt(schema, ['ref'])).to.deep.equal([]);
      expect(declaredKeysAt(schema, ['missing', 'x'])).to.deep.equal([]);
    });
  });

  describe('nearestKey()', () => {
    it('suggests the closest key within a third of the key length, ignoring case', () => {
      expect(nearestKey('maxChange', ['maxKeys', 'maxChanges', 'maxDepth'])).to.equal('maxChanges');
      expect(nearestKey('MAXDEPTH', ['maxDepth'])).to.equal('maxDepth');
      expect(nearestKey('timeout', ['timeoutMs'])).to.equal('timeoutMs');
    });

    it('suggests nothing when no key is close', () => {
      expect(nearestKey('colour', ['maxChanges', 'maxKeys'])).to.equal(undefined);
      expect(nearestKey('ab', ['cd'])).to.equal(undefined);
      expect(nearestKey('x', [])).to.equal(undefined);
    });
  });
});

// The shape of authz-orm's REPLAY_CONFIGURATION_SCHEMA, which this package cannot import.
const REPLAY = {
  $id: 'test-dropped-keys-replay',
  $configurationModule: 'authz.replay',
  type: 'object',
  properties: {
    maxChanges: { type: 'integer', minimum: 1, default: 50000 },
    maxKeys: { type: 'integer', minimum: 1, default: 5000 },
  },
  additionalProperties: false,
};

const DIRECTORY = {
  $id: 'test-dropped-keys-directory',
  $configurationModule: 'directory',
  type: 'object',
  properties: {
    tenants: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, slug: { type: 'string' } } },
    },
    limits: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: { inner: { type: 'object', additionalProperties: false, properties: { depth: { type: 'integer', default: 3 } } } },
    },
  },
};

// Closed at the root, as emailVerification is; the file sources tag every root section with __file__.
const CLOSED_ROOT = {
  $id: 'test-dropped-keys-closed-root',
  $configurationModule: 'closedRoot',
  type: 'object',
  additionalProperties: false,
  properties: { enabled: { type: 'boolean', default: false } },
};

const OPEN = {
  $id: 'test-dropped-keys-open',
  $configurationModule: 'openSection',
  type: 'object',
  properties: { known: { type: 'integer' } },
};

const LATE = {
  $id: 'test-dropped-keys-late',
  $configurationModule: 'late',
  type: 'object',
  additionalProperties: false,
  properties: { kept: { type: 'integer' } },
};

const LAZY = {
  $id: 'test-dropped-keys-lazy',
  $configurationModule: 'lazySection',
  type: 'object',
  additionalProperties: false,
  properties: { known: { type: 'integer' }, secret: { type: 'string' } },
};

const DROPPED = 'is not declared by schema';

const booted: IContainer[] = [];
let warn: sinon.SinonStub;

async function boot(values: Record<string, unknown>, ...schemas: object[]): Promise<{ config: Configuration; container: IContainer }> {
  const container = DI.child();
  booted.push(container);
  for (const s of schemas) container.register(s).asValue('__configurationSchema__');
  container.register(NoSource).as(ConfigurationSource);
  container.register(configurationOf(values)).as(Configuration);
  return { config: await container.resolve(Configuration), container };
}

const dropWarnings = () =>
  warn
    .getCalls()
    .filter((c) => String(c.args[1]).includes(DROPPED))
    .map((c): unknown => c.args[0]);

describe('FrameworkConfiguration: keys a closed schema removes', () => {
  beforeEach(() => {
    warn = sinon.stub(InternalLogger, 'warn');
  });

  afterEach(async () => {
    sinon.restore();
    for (const c of booted.splice(0).reverse()) await c.dispose();
  });

  it('warns for a misspelt key with its full path, the schema $id and the nearest declared key', async () => {
    const { config } = await boot({ authz: { replay: { maxChange: 500 } } }, REPLAY);
    expect(config.get('authz.replay')).to.deep.equal({ maxChanges: 50000, maxKeys: 5000 });
    expect(dropWarnings()).to.deep.equal([{ path: 'authz.replay.maxChange', schema: 'test-dropped-keys-replay', suggestion: 'maxChanges' }]);
  });

  it('covers objects inside arrays and nested closed objects', async () => {
    const { config } = await boot({ directory: { tenants: [{ id: 'a', slug: 'a' }, { id: 'b', slg: 'b' }], limits: { inner: { depth: 1, dept: 2 } }, extra: 1 } }, DIRECTORY);
    expect(config.get('directory.extra')).to.equal(1);
    expect(dropWarnings()).to.deep.equal([
      { path: 'directory.tenants.1.slg', schema: 'test-dropped-keys-directory', suggestion: 'slug' },
      { path: 'directory.limits.inner.dept', schema: 'test-dropped-keys-directory', suggestion: 'depth' },
    ]);
  });

  it('stays silent when every key is declared, and for keys an open schema keeps', async () => {
    const { config } = await boot(
      { authz: { replay: { maxChanges: 7 } }, directory: { tenants: [{ id: 'a', slug: 'a' }], limits: { inner: { depth: 2 } } }, openSection: { known: 1, other: 2 } },
      REPLAY,
      DIRECTORY,
      OPEN,
    );
    expect(config.get('openSection.other')).to.equal(2);
    expect(dropWarnings()).to.deep.equal([]);
  });

  it('does not report the __file__ tag of a root section', async () => {
    const { config } = await boot({ closedRoot: { enabled: true, __file__: ['/app/config/app.js'], enabld: false } }, CLOSED_ROOT);
    expect(config.get('closedRoot')).to.deep.equal({ enabled: true });
    expect(dropWarnings()).to.deep.equal([{ path: 'closedRoot.enabld', schema: 'test-dropped-keys-closed-root', suggestion: 'enabled' }]);
  });

  it('reports a key that set() or merge() brings in at run time, once per key', async () => {
    const { config } = await boot({ authz: { replay: {} } }, REPLAY);
    config.set('authz.replay.maxKey', 9);
    config.set('authz.replay.maxKey', 10);
    config.merge('authz.replay', { maxChanges: 3, maxDepth: 2 });
    expect(config.get('authz.replay')).to.deep.equal({ maxChanges: 3, maxKeys: 5000 });
    expect(dropWarnings()).to.deep.equal([
      { path: 'authz.replay.maxKey', schema: 'test-dropped-keys-replay', suggestion: 'maxKeys' },
      { path: 'authz.replay.maxDepth', schema: 'test-dropped-keys-replay' },
    ]);
  });

  it('reports the keys a schema registered after boot removes', async () => {
    const { config, container } = await boot({ late: { kept: 1, typo: 2 } });
    registerConfigurationSchema(LATE, container);
    expect(config.get('late')).to.deep.equal({ kept: 1 });
    expect(dropWarnings()).to.deep.equal([{ path: 'late.typo', schema: 'test-dropped-keys-late' }]);
  });

  it('does not repeat a warning when the configuration reloads', async () => {
    const { config } = await boot({ authz: { replay: { maxChange: 1 } } }, REPLAY);
    await config.load();
    expect(config.get('authz.replay.maxChange')).to.equal(undefined);
    expect(dropWarnings()).to.have.length(1);
  });

  it('says nothing about the keys of a value it refuses', async () => {
    await expect(boot({ authz: { replay: { maxChanges: 0, maxChange: 1 } } }, REPLAY)).to.be.rejectedWith(InvalidConfiguration);
    expect(dropWarnings()).to.deep.equal([]);
  });

  // configurationOf() round-trips JSON, so only a raw onLoad() value is stored as a lazy-var proxy.
  it('reports a key removed from a section behind a lazy-var proxy', async () => {
    const container = DI.child();
    booted.push(container);
    container.register(LAZY).asValue('__configurationSchema__');
    container.register(NoSource).as(ConfigurationSource);
    container
      .register(
        class extends FrameworkConfiguration {
          protected loadSources(): void {
            this.Sources = [];
          }

          protected onLoad(): unknown {
            return { lazySection: { known: 1, typo: 2, secret: new ConfigVar(() => 'x') } };
          }
        },
      )
      .as(Configuration);
    const config = await container.resolve(Configuration);
    expect(config.get('lazySection.typo')).to.equal(undefined);
    expect(config.get('lazySection.secret')).to.equal('x');
    expect(dropWarnings()).to.deep.equal([{ path: 'lazySection.typo', schema: 'test-dropped-keys-lazy' }]);
  });
});
