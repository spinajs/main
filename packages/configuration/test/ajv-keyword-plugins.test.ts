import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';
import Ajv from 'ajv';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { configurationOf, NoSource } from './fixtures.js';
import { InvalidConfiguration } from '../src/exception.js';
import { addKeywordPluginsOnUse } from '../src/ajv-plugins.js';
import { registerConfigurationSchema } from '../src/schemas.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const PLAIN = {
  $id: 'test-plugins-plain',
  $configurationModule: 'plainPlugins',
  type: 'object',
  properties: { port: { type: 'integer', minimum: 1, default: 80 } },
};

const UNIQUE_NAMES = {
  $id: 'test-plugins-unique',
  $configurationModule: 'uniquePlugins',
  type: 'object',
  properties: { targets: { type: 'array', items: { type: 'object' }, uniqueItemProperties: ['name'] } },
};

const MERGED = {
  $id: 'test-plugins-merged',
  $configurationModule: 'mergedPlugins',
  $merge: {
    source: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
    with: { properties: { port: { type: 'integer', maximum: 100 } } },
  },
};

const pluginKeywords = ['$merge', '$patch', 'uniqueItemProperties', 'typeof', 'instanceof', 'range', 'regexp', 'transform', 'select'];

type AjvClass = { prototype: { addKeyword(def: unknown): unknown } };
const AjvConstructor = ((Ajv as unknown as { default?: AjvClass }).default ?? Ajv) as unknown as AjvClass;

const booted: IContainer[] = [];

async function boot(values: Record<string, unknown>, ...schemas: object[]) {
  const child = DI.child();
  booted.push(child);
  for (const s of schemas) child.register(s).asValue('__configurationSchema__');
  child.register(NoSource).as(ConfigurationSource);
  child.register(configurationOf(values)).as(Configuration);
  return { child, config: await child.resolve(Configuration) };
}

async function violationsOf(values: Record<string, unknown>, ...schemas: object[]) {
  const failure = (await boot(values, ...schemas).then(
    () => undefined,
    (e: unknown) => e,
  )) as InvalidConfiguration | undefined;
  expect(failure).to.be.instanceOf(InvalidConfiguration);
  return failure!.violations.map((v) => v.path);
}

describe('ajv-merge-patch and ajv-keywords are installed on first use', () => {
  let added: sinon.SinonSpy;

  beforeEach(() => {
    added = sinon.spy(AjvConstructor.prototype, 'addKeyword');
  });

  afterEach(async () => {
    sinon.restore();
    for (const c of booted.splice(0).reverse()) await c.dispose();
  });

  const pluginInstalls = () => added.getCalls().filter((c) => pluginKeywords.includes((c.args[0] as { keyword?: string })?.keyword ?? '')).length;

  it('boots without them when no schema names one of their keywords', async () => {
    const { config } = await boot({}, PLAIN);
    expect(config.get('plainPlugins.port')).to.equal(80);
    expect(pluginInstalls()).to.equal(0);
  });

  it('installs them for a schema that uses an ajv-keywords keyword, and still reports its violations', async () => {
    expect(await violationsOf({ uniquePlugins: { targets: [{ name: 'a' }, { name: 'a' }] } }, PLAIN, UNIQUE_NAMES)).to.deep.equal(['uniquePlugins.targets']);
    expect(pluginInstalls()).to.be.greaterThan(0);
  });

  it('accepts a value that satisfies an ajv-keywords keyword', async () => {
    const { config } = await boot({ uniquePlugins: { targets: [{ name: 'a' }, { name: 'b' }] } }, UNIQUE_NAMES);
    expect(config.get('uniquePlugins.targets')).to.have.length(2);
  });

  it('applies a $merge schema', async () => {
    expect(await violationsOf({ mergedPlugins: { host: 'h', port: 101 } }, MERGED)).to.include('mergedPlugins.port');
    expect(await violationsOf({ mergedPlugins: { port: 1 } }, MERGED)).to.include('mergedPlugins.host');
    const { config } = await boot({ mergedPlugins: { host: 'h', port: 100 } }, MERGED);
    expect(config.get('mergedPlugins.port')).to.equal(100);
  });

  it('installs them for a schema registered after the boot', async () => {
    const { child, config } = await boot({ uniquePlugins: { targets: [{ name: 'a' }, { name: 'a' }] } }, PLAIN);
    expect(pluginInstalls()).to.equal(0);
    expect(() => registerConfigurationSchema(UNIQUE_NAMES, child)).to.throw(InvalidConfiguration, /uniquePlugins\.targets/);
    expect(config.get('plainPlugins.port')).to.equal(80);
  });
});

describe('addKeywordPluginsOnUse', () => {
  type Instance = { addSchema(s: object): unknown; validate(key: string, data: unknown): boolean; compile(s: object): (data: unknown) => boolean; getKeyword(k: string): unknown };
  const ajv = () => addKeywordPluginsOnUse(new (AjvConstructor as unknown as new (o: object) => Instance)({ allErrors: true }));

  it('installs the plugins once, for compile and addSchema alike', () => {
    const a = ajv();
    a.addSchema({ $id: 'unique', type: 'array', uniqueItemProperties: ['id'] });
    expect(a.validate('unique', [{ id: 1 }, { id: 1 }])).to.equal(false);
    expect(a.compile({ type: 'number', range: [1, 2] })(3)).to.equal(false);
  });

  it('finds a keyword nested anywhere in the schema', () => {
    const a = ajv();
    const validate = a.compile({ type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { tags: { type: 'array', uniqueItemProperties: ['k'] } } } } } });
    expect(validate({ list: [{ tags: [{ k: 1 }, { k: 1 }] }] })).to.equal(false);
    expect(validate({ list: [{ tags: [{ k: 1 }, { k: 2 }] }] })).to.equal(true);
  });

  it('leaves a schema without their keywords to the plain instance', () => {
    const a = ajv();
    expect(a.compile({ type: 'object', properties: { port: { type: 'number' } } })({ port: 'x' })).to.equal(false);
    expect(a.getKeyword('uniqueItemProperties')).to.equal(false);
  });
});
